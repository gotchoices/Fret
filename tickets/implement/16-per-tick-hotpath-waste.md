description: The background maintenance loop redoes expensive work on every cycle — re-computing peer ring positions it already knows, re-hashing its own identity, and re-checking the routing table's size limit three times — several times a second in active mode.
files: packages/fret/src/service/fret-service.ts
difficulty: medium
----

Three independent wins on the stabilization tick, all inside `fret-service.ts`, all
behavior-preserving. Point (d) of the original ticket (running unknown/foreign/dead counts to make
the three probe-selection store walks no-ops) is **not** here — it needs a store-side design
decision and is carried by `plan/16.5-probe-pass-store-walks`. The two touch disjoint methods and
may land in either order.

Measurement note: costs below are read off the call sites, not profiled. Where a magnitude is
stated it is a call count per tick, which is countable from the source; no slowdown factor is
claimed.

---

### (a) `seedFromPeerStore` — reuse the stored ring coordinate

`seedFromPeerStore` (~1860) runs at `start()` and on **every** stabilization tick (~300 ms active,
~1.5 s passive). It walks the whole libp2p peerStore and does `await hashPeerId(p.id)` — a SHA-256
— for every entry, then `store.upsert(pidStr, coord)`. A peer already in the routing table already
has that exact coordinate stored: the hash is deterministic over the peer id, so re-deriving it
produces the same 32 bytes every time.

Change: look the entry up first and only hash on a genuine miss.

```ts
const existing = this.store.getById(pidStr);
const coord = existing?.coord ?? await hashPeerId(p.id);
```

`upsert` preserves an existing entry's mutable state and refreshes only `coord` and `lastAccess`,
so re-upserting with the identical coordinate keeps today's `lastAccess` refresh intact.

**The one behavior change, stated plainly.** Today's unconditional re-hash is an *accidental*
repair path: if a routing-table entry ever held a coordinate that is not `SHA-256(peer id)`, the
next tick silently overwrote it with the right one — for those peers that also have a libp2p
peerStore entry. The only way a wrong coordinate can enter the store today is `importTable`, which
trusts the coordinate in a persisted snapshot (`docs/fret.md`, *Routing table persistence*, records
this as an open concern). Reusing the stored coordinate removes that incidental repair.

That is the right call: the repair was partial (it only ever covered peers the peerStore also
knows), unowned, and paid for on every tick by every node; the defense belongs at the boundary the
bad value enters by. `tickets/backlog/plan/2-routing-table-export-integrity` item 3 is exactly that
defense ("On import, coordinates are re-verified"). **Append an arm to that backlog ticket** noting
this change removed the incidental repair, so whoever triages it knows the import-side check is now
the only coordinate check for imported entries.

Add a `NOTE:` at the lookup recording both facts — why reuse is sound (the hash is deterministic
over the id, so a stored coordinate cannot legitimately go stale) and the revisit condition (if
epoch/VRF ring-coordinate rotation is ever implemented — an open question in `docs/fret.md` — a
coordinate *can* go stale and this reuse becomes wrong).

---

### (b) Use the cached self coordinate

`selfCoord()` (~464) caches `hashPeerId(this.node.peerId)`. Five sites re-hash instead:

| Line | Site | Frequency |
|---|---|---|
| ~1413 | `announceNeighborsBounded` | per announce |
| ~1473 | start-up warm-up pass | once per `start()` |
| ~1566 | leave fan-out | once per `stop()` |
| ~1898 | `seedFromPeerStore` self-upsert | **every tick** |
| ~2361 | `snapshot()` | per outgoing snapshot |

All five become `await this.selfCoord()`.

**Do not touch line ~1795.** The original ticket counted it as a sixth site; it is not. In
`mergeAnnounceSnapshot` the locals read `const self = peerIdFromString(from)` / `const selfCoord =
await hashPeerId(self)` — that is the **sending peer's** coordinate, not ours, and replacing it
with `selfCoord()` would upsert every announcing peer at our own ring position. Rename the two
locals to `sender` / `senderCoord` so the next reader is not caught by the same trap. That rename
is the whole change at that site.

---

### (c) Enforce capacity once per tick

`enforceCapacity` (~470) early-returns when `store.size() <= cap`, so it is already free below
capacity. At capacity — the steady state for a ring under churn at C=2048 — it does
`store.list()` (materializes every entry) plus a full sort, to drop a handful of entries.

Counted from the call sites, one stabilization tick reaches it **three** times: end of
`seedFromPeerStore` (~1906), end of `seedFromBootstraps` (~1962), and inside `stabilizeOnce`
(~2007). (The original ticket said "four or five"; three is what the tick path actually contains.
The other call sites — `mergeAnnounceSnapshot` ~1852, the leave-replacement insert path ~1709,
`importTable` ~3195 — are inbound- or caller-driven, not per-tick, and stay as they are.)

Change: hoist enforcement to the end of the insert sequence.

- Drop the trailing `await this.enforceCapacity()` from `seedFromPeerStore` and
  `seedFromBootstraps`.
- Keep the one in `stabilizeOnce` (~2007). It already sits after phase 1's snapshot merges, which
  are themselves inserts, so it is strictly the better position: it sees every insert the tick
  made, seeds included.
- `start()` (~874) calls `seedFromPeerStore()` directly before arming the loop, so add one
  explicit `await this.enforceCapacity()` there. Do not rely on the first tick to cover it — that
  couples a correctness property to timer arming.
- `fetchAndMergeSnapshot` already documents this exact pattern ("the caller does the one
  `enforceCapacity`"); follow its comment style.

**Accepted cost, state it in a `NOTE:` at the `stabilizeOnce` call:** the table may now sit over
capacity for the span of phase 1 (bounded by `STABILIZE_TICK_BUDGET_MS`, 5 s) instead of being
trimmed at the end of each seed. Capacity is a soft eviction target, not an allocation bound, and
the transient overshoot is whatever one tick's seeding added — not unbounded growth.

---

## Edge cases & interactions

- **(a) with `importTable`.** Import an entry whose `coord` is not `SHA-256(id)`, for an id that is
  also in the peerStore. Before: the next tick rewrote the coordinate. After: the tampered
  coordinate persists. Assert the new behavior deliberately so the change is pinned rather than
  discovered later, and cross-reference the backlog ticket in the test's comment.
- **(a) coordinate re-key.** `store.upsert` with a *different* coordinate is a re-key (the tree key
  embeds the coordinate). Reuse means the re-key path is no longer exercised from this loop. Do not
  "simplify" `upsert` on the strength of that — `importTable` and the merge loops still re-key.
- **(a) miss path.** A peer newly appearing in the peerStore has no entry, so it still hashes. A
  peer whose entry was just evicted at capacity likewise re-hashes on the next tick. Both are
  correct; pin the "new peer still gets the right coordinate" case.
- **(b) `selfCoord()` before `start()`.** It hashes on demand and caches, so it is safe from any of
  the five sites — including the `stop()`-path leave fan-out, where the cache is already warm.
  Confirm the leave fan-out still produces the same replacement list.
- **(b) the ~1795 rename.** After renaming, grep the method body for any other use of the old
  `selfCoord` local; all of them are the sender's coordinate.
- **(c) over-capacity window.** Test: seed a peerStore larger than `capacity`, run one tick, assert
  the table is at or under capacity once the tick completes.
- **(c) `start()` without a tick.** Test: import/seed over capacity, `start()`, and assert the table
  is trimmed *without* waiting for a stabilization tick.
- **(c) aborted tick.** `stabilizeOnce` runs `enforceCapacity` before the `budget.signal.aborted`
  early return, so a truncated tick still enforces. Do not move it below that return.
- **(c) concurrent inbound announce.** `mergeAnnounceSnapshot` keeps its own enforcement and can run
  concurrently with a tick. Two concurrent `enforceCapacity` calls could over-evict against each
  other — this is pre-existing (both already existed), unchanged by this ticket, and the reason
  `stabilizeOnce` documents that enforcement must not run inside its pool. Do not add a second
  concurrent enforcement path.
- **Interaction with `plan/16.5-probe-pass-store-walks`.** Disjoint methods; no ordering
  requirement. If both are in flight, expect a trivial merge in `stabilizeOnce` only if 16.5 also
  edits the enforcement line, which it should not.
- **Interaction with `plan/23-fret-service-decomposition`** item (a), which reconciles the
  self-anchored ring-walk off-by-one. (b) makes those call sites read `selfCoord()` uniformly, which
  helps that work rather than conflicting with it.

## Key tests

- `seedFromPeerStore` does not hash a peer already in the store: count `hashPeerId` calls (or
  assert via a coordinate that differs from the id's hash surviving a tick) across two ticks with a
  stable peerStore — the second tick hashes only self, if at all.
- A peer new to the peerStore is stored at `SHA-256(id)` on the tick it first appears.
- Existing coordinate-integrity specs (`test/sample-coordinate-verification.spec.ts`) still pass —
  the merge paths are untouched by this ticket.
- `mergeAnnounceSnapshot` still stores the **announcing peer** at the announcer's own coordinate
  after the rename (a rename-safety test, cheap, and it pins the trap).
- Capacity holds after one tick when seeding over capacity, and after `start()` with no tick.
- `test/relevance.eviction.spec.ts` and `test/stabilize-concurrency.spec.ts` unchanged and passing.

## TODO

- (a) `seedFromPeerStore`: look up `store.getById(pidStr)` and reuse `existing.coord`; hash only on
  a miss. Add the `NOTE:` (soundness + VRF-rotation revisit condition).
- (a) Append an arm to `tickets/backlog/plan/2-routing-table-export-integrity` recording that the
  incidental per-tick coordinate repair is gone, so its item 3 is now the only import-side check.
- (b) Replace `await hashPeerId(this.node.peerId)` with `await this.selfCoord()` at ~1413, ~1473,
  ~1566, ~1898, ~2361.
- (b) Rename the `self` / `selfCoord` locals in `mergeAnnounceSnapshot` (~1794-1799) to `sender` /
  `senderCoord`; leave the `hashPeerId` call there alone.
- (c) Remove the trailing `enforceCapacity` from `seedFromPeerStore` and `seedFromBootstraps`.
- (c) Add one `await this.enforceCapacity()` in `start()` after `await this.seedFromPeerStore()`.
- (c) Add the `NOTE:` at `stabilizeOnce`'s enforcement recording the accepted transient-overshoot
  window.
- Add the tests listed above.
- `cd packages/fret && npx tsc --noEmit`, then `yarn test` from `packages/fret` (foreground, no
  redirection).
- Update `docs/fret.md` only if the capacity-enforcement wording needs it — the *Relevance scoring
  and table management* section describes eviction policy, not call frequency, so likely no change.
