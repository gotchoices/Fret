----
description: The scoring that decides which peers to trust is fed a fake zero-millisecond timing every time a message is passed along, and it cannot tell a real zero-millisecond measurement from no measurement at all, so fast peers can end up scored worse than slow ones.
files: packages/fret/src/store/relevance.ts, packages/fret/src/store/digitree-store.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/relevance.properties.spec.ts, packages/fret/test/ring-membership.spec.ts, packages/fret/test/digitree.persistence.spec.ts, packages/fret/test/digitree.invariants.spec.ts, packages/fret/test/service.table-persistence.spec.ts, docs/fret.md, packages/fret/README.md
difficulty: medium
repro: verified
----

## Root cause

One representation defect with two arms. `PeerEntry.avgLatencyMs` is a bare `number` in
which the value `0` is overloaded to mean **"no latency has ever been measured"**. Nothing in
the type says so, so both readers and writers get it wrong in opposite directions:

- **Readers** (`relevance.ts`) branch on `avgLatencyMs > 0` and treat a genuine 0 ms sample as
  unmeasured — and "unmeasured" scores *worse* than a mediocre measurement.
- **Writers** (`fret-service.ts`) feel free to pass a literal `0` when they have no measurement
  to give, because `0` is what the field already means when empty.

The fix belongs at the representation, not at either call site: make "unknown" a distinct
inhabitant of the type so neither mistake is expressible.

### Arm 1 — reader: `0 ms` is scored as unmeasured

`packages/fret/src/store/relevance.ts:77`

```ts
const latencyPenalty = entry.avgLatencyMs > 0 ? Math.min(1, entry.avgLatencyMs / 1000) : 0.5;
```

A peer measured at exactly 0 ms takes the `0.5` branch (the neutral "no data" penalty) instead
of the `0.0` it earned. It therefore scores *below* a peer measured at 300 ms, whose penalty is
0.3. Measured, with two entries identical but for latency (`successCount: 10`,
`failureCount: 0`, same recency/frequency/sparsity inputs):

```
fast(0ms)   relevance = 1.38900668178442
slow(300ms) relevance = 1.46100668178442
```

The 0 ms peer is ranked 4.9% lower. Relevance drives both next-hop preference and capacity
eviction victim selection, so the faster peer is preferred less and evicted sooner.

Genuine 0 ms is not exotic: `sendPing` measures with `Date.now()`, whose granularity on
Windows is ~15 ms, so a localhost or same-process ping routinely rounds to 0.

The same overload sits in `relevance.ts:112`, where a peer whose average is genuinely 0 skips
the EMA and hard-resets to the new sample:

```
avg after a 400ms sample on a 0ms-measured peer = 400   (EMA at α=0.2 would be 80)
```

### Arm 2 — writer: successful forwards inject a fabricated 0 ms

`packages/fret/src/service/fret-service.ts:1751`, on the successful-forward path of `routeAct`:

```ts
await this.applySuccess(next, nextCoord, 0);
```

There is no measurement here at all; `0` is a placeholder. Every forward feeds a 0 ms sample
into the hop's EMA (α = 0.2), so a peer with a healthy measured 200 ms average decays like
this over successive forwards:

```
160, 128, 102.4, 81.92, 65.536, 52.429, 41.943, 33.554, 26.844, 21.475,
17.18, 13.744, 10.995, 8.796, 7.037, 5.629, 4.504, 3.603, 2.882, 2.306
```

Twenty forwards erase the real measurement. Today the two arms partly mask each other — the
fabricated 0 lands in the `> 0` false branch and scores as "unknown" (0.5) rather than as
"instant" (0.0) — so **fixing arm 1 alone makes the system strictly worse**: every forwarded-to
hop would then be scored as a perfect 0 ms link. The two arms must land together.

The other two `applySuccess` call sites (`fret-service.ts:1354` in `probeNeighborsLatency`,
`:1460` in `reprobeForeignPeers`) already pass a real `res.rttMs` from a ping and are correct.

## Recommended fix

### Representation: `avgLatencyMs: number | null`

`null` = never measured. This is the rung the whole bug sits on — with it, "I have no
measurement" cannot be written as a number, so arm 2's placeholder stops type-checking, and
`0` can only ever mean a real 0 ms.

Rejected alternative: gating on `successCount > 0`. It breaks the moment a latency-less success
path exists (below), since that path increments `successCount` without recording a sample — so
`successCount > 0` would no longer imply a latency is known. A separate `latencySamples` counter
works but adds a field to serialize and to the store invariants without buying anything the
nullable does not.

Blast radius is small: only `relevance.ts:77` and `:112` do arithmetic on the field.
`linkQuality` (`fret-service.ts:1804`) uses success/failure counts only and is unaffected.

### Arm 2: a latency-less success path, not a measured forward

The ticket's other option — timing the forward RPC and passing its real duration — is the
**wrong** measurement, and should not be taken. `sendMaybeAct` on the forward path returns only
after the *entire remaining route* completes downstream, so its wall time is the cost of the
whole subtree, not of the link to `next`. Recording it would penalize a perfectly healthy
adjacent hop for a long downstream path — a different corruption of the same field, in the
opposite direction, and harder to spot.

Latency belongs to the ping path, which already measures it correctly. So the forward records
success and health (and the membership proof it already grants) **without touching
`avgLatencyMs`**.

Shape: make the parameter optional — `applySuccess(id, coord, latencyMs?: number)` — and in
`relevance.ts` add a sibling of `recordSuccess` that omits the latency update (or make
`recordSuccess`'s `latencyMs` parameter `number | undefined` and skip the `avgLatencyMs` field
in the returned patch when it is absent). Either way the forward call site becomes
`applySuccess(next, nextCoord)` and `applySuccess` must not include `avgLatencyMs` in its
`store.update` patch when no sample was supplied.

### Serialization

`SerializedPeerEntry.avgLatencyMs` becomes `number | null`. On import, a missing field maps to
`null`. Pre-nullable snapshots wrote `0` for "never measured", which is ambiguous and will read
back as a genuine 0 ms — acceptable, since this repo is not carrying snapshot back-compat yet
(see AGENTS.md), and the next ping overwrites it. Do not add a coercion that discards a real 0.

## Expected behavior after the fix

- A peer measured at 0 ms scores **higher** than one measured at 300 ms, all else equal.
- A peer that has never been measured scores at the neutral midpoint — between the two above,
  not below both.
- A successful forward leaves the hop's `avgLatencyMs` untouched (still `null` if never pinged),
  while still bumping `successCount`, relevance, `lastAccess`, and the membership signal.
- A 400 ms sample against a peer averaging 0 ms blends to 80 ms, not 400 ms.

## Interactions with other open tickets

Both are in the same file but a different concern; expect textual conflicts only, no semantic
dependency, and this ticket's lower sequence lands it first:

- `19-cleanup-store-ring` edits `relevance.ts`'s `withCounters` / `touch` access-count basis.
- `9-relevance-scoring-tests` adds relevance coverage; the property test below is the natural
  home for its "health scoring" arm if it lands after.

## TODO

- Change `PeerEntry.avgLatencyMs` and `SerializedPeerEntry.avgLatencyMs` to `number | null` in
  `packages/fret/src/store/digitree-store.ts`; default a new entry in `upsert` to `null`
  (currently `:171`), and map a missing field to `null` in `importEntries` (`:391`).
- In `relevance.ts`, replace both `avgLatencyMs > 0` sentinel checks (`:77`, `:112`) with an
  explicit `=== null` test for "unmeasured".
- Add the latency-less success path in `relevance.ts` and thread it through
  `FretService.applySuccess` as an optional `latencyMs`; ensure the `store.update` patch omits
  `avgLatencyMs` entirely when no sample was given.
- Change the successful-forward call site (`fret-service.ts:1751`) to the latency-less form and
  replace the comment there with why the forward's own duration is not a usable latency sample.
- Add a property test (extend `test/relevance.properties.spec.ts`) pinning the general rule, so
  the whole sentinel class stays caught: health score is monotonically non-increasing in
  measured latency across the full range including 0, and an unmeasured peer sits strictly
  between a 0 ms peer and a 1000 ms peer.
- Add a regression test asserting a successful forward does not change the hop's
  `avgLatencyMs`. If driving `routeAct` end-to-end is heavy, assert at the `applySuccess` /
  `recordSuccess` seam instead and say so in the test name.
- Update the fixtures and assertions that hard-code `avgLatencyMs: 0`:
  `test/ring-membership.spec.ts:105,115,128` (`:128` asserts the `upsert` default is `0` —
  becomes `null`), `test/digitree.invariants.spec.ts:79,109,205,298,309`,
  `test/digitree.persistence.spec.ts:25,46,178`, `test/relevance.properties.spec.ts:31`,
  `test/service.table-persistence.spec.ts:31`.
- Update `docs/fret.md` — the `SerializedPeerEntry` block under "Wire formats", and note in
  "Relevance score calculation" that unmeasured latency is `null` and scores neutrally — and
  `packages/fret/README.md:126`.
- Run `cd packages/fret && npx tsc --noEmit` and `yarn test`.
