----
description: Recording a success or failure about a peer currently re-adds that peer to the routing table if it is not there, so deleting a peer does not stick — make bookkeeping about a peer unable to create one.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/churn.leave.spec.ts, packages/fret/test/rpc.snapshot-merge-cap.spec.ts, docs/fret.md
difficulty: medium
----

### The one site

Three private helpers on `FretService` each open with the same line:

```ts
const entry = this.store.getById(id) ?? this.store.upsert(id, coord);
```

- `applyTouch`   — `fret-service.ts:550`
- `applySuccess` — `fret-service.ts:615`
- `applyFailure` — `fret-service.ts:640`

That `?? upsert` is the create-on-miss arm, and it is the whole ticket. It makes *any* bookkeeping
about a peer re-admit that peer, including bookkeeping that fires **because the peer went away**:
`handleLeave` removes a departing peer (`fret-service.ts:1245`), its connection closes a moment
later, the `peer:disconnect` listener calls `applyFailure` (`fret-service.ts:1027`), and the entry
comes back with `membership: 'unknown'`, `relevance: 0` and no health history. The node then spends
several stabilization ticks classification-probing a peer that told it goodbye.

### The shape of the fix: scoring cannot create, because it has nothing to create *from*

The rest of this seam already behaves correctly and is the model to follow. Every sibling
bookkeeping helper reads the entry and returns when there is none:

| helper | line | missing-entry behavior |
|---|---|---|
| `applyMembershipSignal` | 872 | `const e = this.store.getById(id); if (!e) return;` |
| `applyContactStrike` | ~695 | same |
| `noteProofOfLife` | ~725 | same |
| `noteDisconnected` | ~775 | reads through `getById(id)?.state` |

So the three scoring helpers are the *only* create-on-miss sites left, and making them match their
siblings is a consistency change, not a new rule.

Go one rung further than an `if (!entry) return;` guard, though. The `coord` parameter on all three
helpers exists solely to feed `normalizedLogDistance(await this.selfCoord(), coord)`. Once the entry
is required to exist, `entry.coord` **is** that value: every caller computes its argument as
`await this.coordOf(id)`, which is defined as `this.store.getById(id)?.coord ?? hash(id)` — i.e.
identical to `entry.coord` in exactly the case that now survives the guard. Dropping the parameter
therefore removes the ability to express "create this peer at coordinate X while scoring it" at all,
rather than leaving it expressible and guarded. Target signatures:

```ts
private async applyTouch(id: string): Promise<void>
private async applySuccess(id: string, latencyMs?: number): Promise<void>
private async applyFailure(id: string): Promise<void>
```

Each opens `const entry = this.store.getById(id); if (!entry) return;` — the return placed **before**
`await this.selfCoord()`, so a call about an unknown peer costs one map lookup and no await.

`applySuccess`'s trailing `applyMembershipSignal(id, 'rpc-success')` and `noteProofOfLife(id)` land
inside the guard and so stop running for a missing peer. That loses nothing: both already no-op on a
missing entry today. The only behavior removed anywhere is the creation itself.

### Call sites, and why none of them needs the creation

Every caller either inserts explicitly first or draws its id from the store:

| site | line | already inserts / where the id came from |
|---|---|---|
| `peer:connect` listener → `applyTouch` | 1012 | `store.upsert(id, coord)` two lines above |
| `mergeAnnounceSnapshot` → `applyTouch(from, …)` | 1952 | `store.upsert(from, senderCoord)` one line above |
| `peer:disconnect` listener → `applyFailure` | 1027 | **nothing** — this is the bug |
| `applyContactFailure` → `applyFailure` | 666 | callers probe peers drawn from the store |
| `noteRpcFailure` decode-error arm → `applyFailure` | 806 | as above |
| `probeNeighborLatency` → `applySuccess` / `applyFailure` | 2254, 2260 | target from `nearProbeTargets` (a store walk) |
| `probeMembership` → `applySuccess` | 2466 | target from `phaseTwoTargets` (a store walk) |
| `routeAct` forward → `applySuccess` | 2859 | `next` from `chooseNextHop` over store candidates |

The genuine "learn a new peer" paths do not go through these helpers at all and are untouched:
`seedFromPeerStore`, `seedFromBootstraps`, `noteInboundRpc` (`fret-service.ts:928` — explicit
`upsert` before signalling), the `peer:identify` listener (explicit `upsert`), and both snapshot
merges plus the leave-notice replacement hints (all via `noteDiscovered`). A genuinely returning peer
is therefore still rediscovered by a fresh connection, an identify, an inbound RPC, or another peer's
snapshot naming it — which is exactly the ticket's stated expected behavior.

Drop the now-unused `await this.coordOf(id)` argument computations at the probe and route call sites.
Keep `coordOf` itself: `peer:connect` still needs it for its `upsert`, and `peer:disconnect` still
needs it for `isNearNeighbor` and `announceOnDeparture`.

### One thing that looks like a regression and is not

At the `peer:disconnect` site, `wasNear = this.isNearNeighbor(id, coord)` is computed *before* the
scoring call. For a peer removed by `handleLeave`, that is already `false` today — the removal
happens before the disconnect event, and the resurrection happens inside `applyFailure` afterwards —
so the departure announce is already skipped for a gracefully-departed peer, both before and after
this change. Do not "fix" it here.

## Edge cases & interactions

- **Peer evicted mid-tick.** `enforceCapacity` runs after the pooled tick's phase 1, so a peer can be
  selected as a probe target and then evicted before its outcome is scored. Scoring must be a silent
  no-op, not a throw and not a resurrection.
- **Concurrent scoring across a removal.** Two pooled tasks scoring the same peer, with a
  `store.remove` landing between them: the second must no-op. Assert no throw.
- **`store.update` / `store.setState` on a missing id must already be a no-op, not a throw** — that
  is what makes the guard-free sibling helpers safe today. Verify it in `DigitreeStore` and, if it is
  not, fix that assumption rather than adding a guard at each caller.
- **`noteRpcFailure`'s decode-error arm** calls `noteAnsweredOnProtocol` then `applyFailure`; both
  no-op for a missing peer. It must not log an error for a peer that simply left.
- **Self.** Self is always in the store and seeded `member`, so `applyTouch(selfId)` is unchanged.
  No new self guard is needed — the existing one in `applyContactStrike` stays.
- **Scoring an existing entry is byte-for-byte unchanged.** This ticket touches only the create arm;
  relevance, counters, latency handling and the membership/proof-of-life calls keep their behavior.
- **Rediscovery still works.** A departed peer that genuinely comes back must reappear via each of:
  `peer:connect`, `peer:identify`, an inbound RPC, and a neighbor snapshot naming it.
- **The lost-increment NOTE on `applySuccess`** (two chains deriving counters across the `selfCoord()`
  await) is unchanged in kind — the await window shrinks by one `coordOf` call but the race is the
  same. Leave the NOTE in place, updated only if its line references move.

## Key tests and expected outputs

- **`test/churn.leave.spec.ts:370`** currently carries a workaround comment saying the departed peer
  "may be re-added" and asserts on service health instead of store contents. Replace it with the real
  assertion: after a graceful leave **plus** the disconnect that follows, the departed peer is absent
  from `getStore()`. Written against HEAD this assertion fails; that failure is the reproduction the
  ticket never ran. Remove the stale `backlog/debt-scoring-resurrects-removed-peers` reference in that
  comment.
- **New: scoring an unknown id creates nothing.** For each of `applyTouch` / `applySuccess` /
  `applyFailure` against an id not in the store: `store.size()` unchanged, `getById(id)` still null,
  no throw.
- **New: scoring an existing entry is unaffected.** Same relevance / counter outcomes as before for a
  peer that is present — a regression guard on the arm this ticket does not touch.
- **New: removal during a probe.** Remove the entry between selecting a probe target and scoring its
  outcome; assert the peer stays absent and nothing throws.
- **`test/rpc.snapshot-merge-cap.spec.ts:137`** has a comment reasoning explicitly about `applyTouch`
  opening with `getById(id) ?? upsert(id, coord)`. The announce path upserts `from` explicitly one
  line earlier, so the counted `store.upsert` calls should not change — but re-read the comment and
  correct it, and confirm the count empirically rather than assuming.

## TODO

- Verify `DigitreeStore.update` / `setState` / `remove` are no-ops (not throws) for an id not in the
  store; note the finding in the handoff either way.
- Rewrite `applyTouch`, `applySuccess`, `applyFailure` to `getById` + early return, dropping the
  `coord` parameter and reading `entry.coord` instead. Place the return before `await this.selfCoord()`.
- Update all call sites listed above; delete the `await this.coordOf(id)` argument computations that
  become dead. Keep `coordOf` for the two sites that still use it.
- Update the doc comments on the three helpers to state that scoring never creates, and to point at
  `noteDiscovered` as the seam that does.
- Rewrite the `test/churn.leave.spec.ts` workaround into the real store-contents assertion; confirm it
  fails before the source change and passes after.
- Add the three new tests above.
- Re-read and correct the `applyTouch` comment in `test/rpc.snapshot-merge-cap.spec.ts`.
- Update `docs/fret.md`: in *Relevance scoring and table management* (and the `accessCount` note under
  *Relevance score calculation*), state that the scoring helpers never create an entry — a peer not in
  the routing table is not scored — and that creation belongs to `noteDiscovered` and the explicit
  insert sites.
- Run `npx tsc --noEmit` and `yarn test` from `packages/fret`.
