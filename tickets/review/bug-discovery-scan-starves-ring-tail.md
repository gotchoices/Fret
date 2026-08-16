description: The peer-announcement sweep now resumes where it left off instead of restarting from the beginning each time, so a node that knows more peers than its bookkeeping can remember eventually tells libp2p about all of them rather than the same half forever.
files: packages/fret/src/store/digitree-store.ts (`RingCursor`, `RingWalkPage`, `walkFrom`), packages/fret/src/service/peer-discovery.ts (`scanOnce`, `cursor`, `FretPeerDiscoveryConfig.maxTracked`), packages/fret/src/service/libp2p-fret-service.ts (profile sizing comment), packages/fret/src/index.ts (type re-exports), packages/fret/test/digitree.invariants.spec.ts (`DigitreeStore.walkFrom` block), packages/fret/test/peer-discovery.spec.ts (coverage property + retargeted capacity case), docs/fret.md (libp2p integration → Discovery)
difficulty: medium
----

## What changed

`FretPeerDiscovery` used to walk `store.list()` from ring position 0 on **every** tick, emitting
up to `batchSize` peers not currently in its `emitted` debounce map. Once the live-member
population exceeded that map's capacity (`maxTracked`), evictions always landed on the entries
nearest the front of the ring, so the sweep re-reached them, re-emitted them, and never advanced
past roughly `maxTracked + batchSize` positions. Everything beyond was emitted **never** — and
permanently, since ring position is a stable hash of the peer id.

The sweep now resumes. Three pieces:

**`DigitreeStore.walkFrom(cursor, count, filter)` → `{ entries, next }`** (new). One page of a
ring walk that starts **strictly after** `cursor` (at the ring start when `null`), wraps past the
end, skips filter misses rather than stopping, and visits at most `size()` entries — one full lap
— so a ring where nothing matches terminates. `RingCursor` is an opaque `{ key }` token minted and
consumed by the store: the position it names is the store's private tree key (`hex(coord)|id`),
and a second copy of that format outside the class is how ordered reads break silently. Returns
`PeerEntry[]` rather than ids so the caller gets its next cursor without a second `getById`.

**`FretPeerDiscovery.scanOnce()`** (was the private `scan`). Holds a `cursor` as instance state,
asks the store for one page, advances the cursor from `page.next`, then emits. The three
exclusions — `isLiveMember`, the self check, the `emitted.has` debounce — moved *into* the walk's
filter predicate, which is what makes a skipped entry advance the walk instead of consuming one
of the tick's `batchSize` slots. `stop()` clears the cursor next to `emitted.clear()`.

It is **deliberately public**, with a comment saying why: the coverage property drives ticks
directly. Timing through `setInterval` would assert on scheduler overshoot instead of the sweep
rule and would cost minutes of wall clock. `start()` schedules `scanOnce`.

**Two deliberate design points worth checking under review:**

- *Strictly after, not at.* Resuming *at* the last emitted entry re-emits it whenever its debounce
  has lapsed, spending a page slot every tick and — at `batchSize: 1` — never advancing at all.
  That is the hole a naive cursor has, and the property test at `B ∈ [1, 50]` covers it.
- *Empty page holds position.* `walkFrom` returns the **input cursor** as `next` when nothing
  matched, rather than `null`. Returning `null` would silently restart the sweep whenever a lap
  found nothing eligible.

Comments and docs: the three starvation `NOTE:` blocks are gone (constructor, above `scan`,
`Libp2pFretService` constructor). The accurate parts stay — the drain-rate note and the
effective-debounce arithmetic — and the Core 4096 / Edge 1024 split is **kept and re-justified**
as a profile-scaled memory ceiling, since coverage no longer depends on it. `docs/fret.md` (libp2p
integration → Discovery) drops the "Known defect" paragraph and states the cursor rule and the
`ceil(N / batchSize)` drain instead.

## Validation run

`cd packages/fret && npx tsc --noEmit` clean; `yarn test` → **589 passing, 0 failing** (~4 min).
No pre-existing failures surfaced, so no `.pre-existing-error.md` was written.

## Use cases to exercise

**The bug itself.** `FretPeerDiscovery` over a store of N live members with
`maxTracked < N`; drive `scanOnce()` and collect `peer` events. Every member must appear.
The old code plateaued at exactly `maxTracked + batchSize` distinct peers and stayed there
forever — the ticket measured 25 of 60 at `maxTracked: 20, batchSize: 5`.

**The regression guard** — `test/peer-discovery.spec.ts` → *FretPeerDiscovery ring coverage
(property)*. `fast-check` over population ∈ [1, 200] × `maxTracked` ∈ [1, 200] × `batchSize` ∈
[1, 50], 200 runs, asserting every member is emitted within `2 * ceil(N/B) + 2` directly-driven
ticks. It asserts on its own generated distribution (following `test/nexthop-cost.spec.ts`) so the
`N > maxTracked` region is provably reached. 200 real Ed25519 ids are minted once in `before()` —
`scanOnce` runs `peerIdFromString` on every emission, so synthetic ids would not exercise it.
Runs in ~1.1 s.

**`walkFrom` directly** — `test/digitree.invariants.spec.ts` → *DigitreeStore.walkFrom*: one lap
visits every entry exactly once in ring order; wraps; a single page caps at one lap even when
`count` exceeds the ring; a one-peer ring re-yields its peer; filter misses are skipped not
counted; an all-miss filter terminates and holds position; empty ring; `count <= 0`; and a cursor
whose entry was **removed** between pages still resumes at the next ring position (the store seeks
into the crack where the key used to be).

**The retargeted capacity case** — *debounce map caps at maxTracked and evicts…* now runs at
`maxTracked: 2` against 5 members (was `4`, chosen to dodge the bug), so it proves the fix
directly. Its excuse comment is gone.

**Behaviour that must not have changed:** the 18 pre-existing `peer-discovery.spec.ts` cases —
member/dead/foreign/self filtering, debounce, `batchSize` respected per tick, not-ready and
throwing source thunks, start idempotence, stop clearing state, the `Libp2pFretService`
`peerDiscoverySymbol` wiring, and the peerStore-merge integration case.

## Known gaps — treat these as starting points, not a floor

- **The property takes wall-clock expiry out of play** (`debounceMs: 3_600_000`) so the capacity
  rule is what is under test. The interaction between *TTL expiry* and the cursor is covered only
  by the pre-existing single-peer `re-emits after debounce window expires` case, which is a tuned
  case of exactly the kind that let the original bug ship. `emitted`'s clock is `Date.now` and is
  not injectable from `FretPeerDiscovery`'s config, which is why the property cannot drive it.
- **The property never runs the `setInterval` path.** `start()`/`stop()` scheduling, and the lazy
  `DiscoverySnapshotSource` thunk, are exercised only by the existing wall-clock cases.
- **Coverage is asserted as set membership after a tick bound.** Nothing asserts emission
  *ordering*, nor that a peer is not re-emitted more often than the once-per-lap the design
  predicts. A sweep that thrashed but still eventually covered the ring would pass.
- **Per-tick cost is argued, not measured.** A filtered walk skip-scans at most one full lap
  (`size()` entries), which is what the unconditional `list()` walk already did every tick, so the
  worst case is unchanged. The existing `NOTE:` above the filtered ring walks in
  `digitree-store.ts` already states that cost and its escape hatch (a member-only secondary
  index); nothing new was recorded there.
- **`walkFrom` returns live `PeerEntry` references**, exactly as `list()` does. A caller mutating
  one mutates store state. Pre-existing convention, not introduced here, but `walkFrom` is a new
  surface that inherits it.
- **A cursor is a position, not a handle to a store.** `FretPeerDiscovery` resolves its store per
  tick through a thunk; if that thunk ever returned a *different* store, the retained cursor would
  still resolve positionally in the new store's ring order — degrading to "resume near that ring
  position", not corrupting anything. In practice `Libp2pFretService` returns one store for the
  service's lifetime, so this is unexercised rather than wrong.

No tripwires were parked in code for this ticket; the two conditional concerns that exist
(filtered-walk cost, and per-entry TTLs in `ExpiringMap`) already carry their own `NOTE:` at their
sites and were not changed.
