description: A node that knows more peers than its discovery bookkeeping can remember never tells libp2p about roughly half of them — always the same half, permanently. Make the announcement sweep resume where it left off instead of restarting from the beginning every time.
files: packages/fret/src/service/peer-discovery.ts (the `scan` loop, the `emitted` map, `FretPeerDiscoveryConfig`), packages/fret/src/store/digitree-store.ts (ring walks — the new resumable walk lives here), packages/fret/src/service/libp2p-fret-service.ts (the `maxTracked` profile sizing comment), packages/fret/test/peer-discovery.spec.ts, docs/fret.md (libp2p integration → Discovery)
difficulty: medium
repro: verified
----

## The defect, restated

`FretPeerDiscovery.scan` walks `store.list()` — the whole routing table in ring-coordinate
order — from **position 0 on every tick**, emitting up to `batchSize` peers it has not emitted
recently and then stopping. "Recently emitted" lives in `emitted`, an `ExpiringMap` bounded at
`maxTracked` that evicts oldest-first.

There is no cursor. While the live-member population fits inside `maxTracked` the walk eventually
runs off the end of the table and everyone is announced. Once the population *exceeds*
`maxTracked`, the evictions land on exactly the entries nearest the front of the ring — the ones
emitted earliest — so the next tick re-reaches them, re-emits them, and evicts more of the front to
do it. The walk settles into a stable cycle covering roughly the first `maxTracked + batchSize`
positions. Everything past that is emitted **never**, and since ring position is a stable hash of
the peer id, it is the same set forever.

## Reproduction (ran it, saw it)

A temporary spec was written against the **real** `FretPeerDiscovery` and `DigitreeStore` (not a
transcription of the loop): N synthetic Ed25519 peer ids upserted and marked `member`, discovery
started with `emissionIntervalMs: 10`, `debounceMs: 600_000`, and run for `8 * ceil(N/B) + 20`
ticks — eight times the minimum needed to drain the population.

| N (members) | `maxTracked` | `batchSize` | distinct peers emitted | result |
|---|---|---|---|---|
| 60 | 20 | 5 | **25** | fails — 35 never emitted |
| 60 | 59 | 5 | 60 | passes |
| 40 | 40 | 5 | 40 | passes |

25 = `maxTracked + batchSize`, matching the predicted plateau exactly. The two passing rows are the
control: the plateau only bites when it falls below the population (`59 + 5 > 60`, so row two is
covered). More ticks does not help — the failure is permanent, not slow.

That temporary spec was deleted; its content is the starting point for the property test below.

## Fix, verified by prototype

A resumable cursor. Prototyped in place — `scan` replaced with
`store.neighborsRight(cursorCoord, batchSize, eligibilityFilter)` and the cursor advanced to the
last emitted entry's coordinate — and the table above turns all-green while all 18 existing
`peer-discovery.spec.ts` cases still pass. The prototype was then reverted; the working tree is at
baseline.

**Do not ship the prototype as-is.** It has a real hole the property test will find: the cursor
resumes *at* the last emitted coordinate (inclusive), so when that peer has already been evicted
from `emitted` it is re-emitted and consumes a batch slot. At `batchSize: 1` the cursor then never
advances at all — starvation again, from the other end of the parameter space.

Resuming *strictly after* the last emitted entry, wrapping round the ring, is the shape that has no
such hole: with a single-entry table "strictly after X, wrapping" is X itself, so a one-peer ring
still re-emits after its debounce lapses, and with two or more the cursor always moves.

Strict-after needs the entry's **tree key** (`hex(coord)|id`), which is deliberately private to
`DigitreeStore` — nothing outside that class may derive it (see the invariant comment above the
class). So the cursor should be an **opaque token minted and consumed by the store**, e.g.

```ts
/** Opaque resume position in ring-coordinate order. Only DigitreeStore may read `key`. */
export interface RingCursor { readonly key: string }

/**
 * One page of a resumable ring walk. Starts strictly after `cursor` (or at the ring start when
 * `null`), wraps, skips filter misses, and visits at most `size()` entries.
 */
walkFrom(cursor: RingCursor | null, count: number, filter?: (e: PeerEntry) => boolean):
	{ entries: PeerEntry[]; next: RingCursor | null }
```

Returning `PeerEntry[]` rather than ids (as `neighborsRight` does) is what lets the caller mint the
next cursor without a second `getById` per page. Keeping the key format inside the store is the
point — a cursor built from `coordToHex(e.coord) + '|' + e.id` in `peer-discovery.ts` would be a
second copy of the key rule outside its owner.

Everything else about `scan` stays: the `isLiveMember` gate, the self exclusion, and the
`emitted.has` check all become the walk's `filter` predicate (which is what makes skipped entries
advance the walk instead of consuming batch slots), and the unconditional `emitted.sweep()` at the
end is unchanged.

## What the fix does and does not change

- **`batchSize` now costs latency, not coverage.** The whole table drains in `ceil(N / batchSize)`
  ticks for any N, any `maxTracked`. The rate limit itself is deliberate and stays.
- **`maxTracked` becomes a pure memory bound.** Its only remaining effect is shortening the
  effective debounce to ≈ `maxTracked / (batchSize / emissionIntervalMs)`, i.e. a peer is
  re-announced once per lap rather than once per `debounceMs`. Re-announcement is idempotent in
  libp2p's peerStore and the emission rate is already hard-capped at `batchSize / emissionIntervalMs`,
  so that is genuinely harmless — which is what the pre-existing "one extra emission" comment
  claimed and could not deliver without a cursor.
- **Keep the Core 4096 / Edge 1024 split** rather than collapsing it. The ticket flagged this as
  worth re-deciding; with coverage no longer depending on it, it is exactly what it looks like — a
  profile-scaled memory ceiling — and Edge should hold fewer entries than Core. What must change is
  the *justification* in the comments, which currently reads as a hazard warning.
- **`emitted` is still needed.** On a small ring a lap completes in one tick, so without the
  debounce the same three peers would be re-announced every 5 s.
- **Reset the cursor in `stop()`**, alongside the existing `emitted.clear()`. A start→stop→start
  cycle is a fresh run, the same rule the service's backoff maps follow.
- Worst-case per-tick cost is unchanged: a filtered walk skip-scans at most one full lap
  (`size()` entries), which is what the unconditional `list()` walk already did every tick. The
  existing `NOTE:` above the filtered ring walks in `digitree-store.ts` already states this cost
  and its escape hatch; nothing new to record.

## Regression guard

A **property** over the parameter space, not another tuned case — a single tuned case is what let
this through, and the shipped spec at `maxTracked: 4` is a monument to it. `fast-check` is already
a dev dependency and `test/nexthop-cost.spec.ts` is the house precedent for a property test.

Shape: for a population of N live members with capacity C and batch B, every member is emitted
within a bounded number of ticks — bound `2 * ceil(N / B) + 2` is comfortable, since a correct
cursor covers the ring in one lap plus the partial lap it started mid-way through. Generate
N ∈ [1, 200], C ∈ [1, 200], B ∈ [1, 50] and assert on the generated distribution so the
`N > C` region is provably reached (again following `nexthop-cost.spec.ts`).

**Drive the ticks directly — do not sleep.** Timing the property through `setInterval` makes it
assert on scheduler overshoot and turns a ~200-case property into minutes of wall clock; the
temporary repro above needed ~1.2 s per parameter combination for that reason alone. `ExpiringMap`
already takes an injectable `Clock` on exactly this argument (see its `Clock` doc comment). So
promote the scan tick to a documented, directly-callable method — `scanOnce()` or similar, with a
comment saying why it is not private — and have `start()` schedule *it*. The property then
constructs the discovery without starting it and calls `scanOnce()` in a loop. Note the debounce
is driven by wall time inside `emitted`; give the property a large `debounceMs` so expiry never
fires and the capacity rule is what is under test.

Generating 200 real Ed25519 peer ids per case is too slow for a property. Mint the id pool **once**
outside the property (`generateKeyPair('Ed25519')` + `peerIdFromPrivateKey`, as
`test/dialability.spec.ts` and `test/announce-rate-limit.spec.ts` do) and have each case take a
prefix of it. Real ids are required because `scan` calls `peerIdFromString` on every emission.

## TODO

Phase 1 — store

- Add the resumable ring walk to `DigitreeStore` (`walkFrom` + the opaque `RingCursor` above, or an
  equivalent shape that keeps the tree-key format inside the class). Strictly after the cursor,
  wrapping, filter-aware, capped at one full lap.
- Extend `test/digitree.invariants.spec.ts` or add cases alongside it: walking with a cursor across
  the whole ring visits every entry exactly once per lap, wraps correctly, and terminates when the
  filter matches nothing.

Phase 2 — discovery

- Replace the `store.list()` loop in `scan` with the cursor walk; move `isLiveMember`, the self
  exclusion and the `emitted.has` debounce into the walk's filter predicate.
- Hold the cursor as instance state; advance it from the walk's returned `next`; clear it in
  `stop()` next to `emitted.clear()`.
- Promote the tick to a directly-callable method with a comment explaining why it is not private;
  `start()` schedules it.
- Delete the now-false starvation `NOTE:`s: the block in the constructor (`peer-discovery.ts`
  ~lines 90–96), the second `NOTE:` above `scan` (~lines 133–138), and the block in the
  `Libp2pFretService` constructor (~lines 26–30). Keep the accurate parts — the drain-rate note
  above `scan` and the effective-debounce arithmetic in `Libp2pFretService` — and re-justify the
  Core 4096 / Edge 1024 split as a memory ceiling.

Phase 3 — tests and docs

- Add the coverage property test described above.
- Re-point the existing `debounce map caps at maxTracked and evicts…` case at a capacity **below**
  the population (5 members, `maxTracked: 2`) so it proves the fix directly, and delete its
  explanatory `NOTE:` comment (`peer-discovery.spec.ts` ~lines 202–208), which exists only to
  excuse the bug.
- Update `docs/fret.md`, libp2p integration → Discovery: drop the "Known defect: the cap binding is
  not harmless…" paragraph and state the cursor rule and the `ceil(N / batchSize)` drain instead.
  Also fix the `maxTracked` sentence that currently says the cap binding is a hazard on Edge.
- `cd packages/fret && npx tsc --noEmit && yarn test`.
