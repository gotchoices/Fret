description: Peer health scoring can now tell "we measured this peer at zero milliseconds" apart from "we never measured this peer", and forwarding a message no longer records a fake zero-millisecond timing, so fast peers are no longer scored worse than slow ones.
files: packages/fret/src/store/digitree-store.ts, packages/fret/src/store/relevance.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/relevance.properties.spec.ts, packages/fret/test/digitree.persistence.spec.ts, packages/fret/test/digitree.invariants.spec.ts, packages/fret/test/ring-membership.spec.ts, packages/fret/test/service.table-persistence.spec.ts, docs/fret.md, packages/fret/README.md
difficulty: medium

## What landed

One representation change plus the two call-site corrections it enables. `PeerEntry.avgLatencyMs`
is now `number | null`, where `null` means "no round trip to this peer has ever been timed". The
value `0` therefore means exactly one thing: a peer measured at 0 ms.

### Store (`src/store/digitree-store.ts`)

- `PeerEntry.avgLatencyMs: number | null`, carrying a doc comment explaining why `0` cannot be
  the sentinel (`Date.now()` granularity is ~15 ms on Windows, so a localhost peer routinely
  measures 0 ms).
- `SerializedPeerEntry.avgLatencyMs: number | null`.
- `upsert` defaults a brand-new entry to `null` (was `0`).
- `importEntries` maps a missing field to `null` (`s.avgLatencyMs ?? null`). A pre-nullable
  snapshot that wrote `0` for "never measured" still reads back as a genuine 0 ms — accepted
  deliberately (the next ping overwrites it) rather than coercing `0 → null`, which would
  discard real 0 ms measurements. Comment at the site says so.

### Scoring (`src/store/relevance.ts`)

- `healthScore` is now **exported** (it was module-private) so the property test can pin the rule
  directly rather than inferring it through `touch`/`relevance`. Its latency test is
  `entry.avgLatencyMs === null ? 0.5 : Math.min(1, entry.avgLatencyMs / 1000)`.
- New private `blendLatency(avg, sample)` holds the EMA rule in one place: `undefined` sample →
  average untouched; `null` average → first sample seeds it outright; otherwise α = 0.2 EMA. A
  real 0 ms average now blends like any other value instead of hard-resetting.
- `recordSuccess`'s `latencyMs` parameter is now `number | undefined`, documented as "supply only
  when you timed a round trip to this peer alone".

### Service (`src/service/fret-service.ts`)

- `applySuccess(id, coord, latencyMs?)` — the latency argument is optional, and the `store.update`
  patch **omits `avgLatencyMs` entirely** when no sample was supplied (`...(latencyMs === undefined
  ? {} : { avgLatencyMs: next.avgLatencyMs })`), so the patch never speaks for a field the call has
  nothing to say about.
- The successful-forward call site in `routeAct` (was `applySuccess(next, nextCoord, 0)`) is now
  `applySuccess(next, nextCoord)`. The replacement comment explains why the forward's own duration
  is *not* a usable sample: `sendMaybeAct` on the forward path returns only after the entire
  remaining route completes downstream, so its wall time is the whole subtree's cost, not the link
  to `next`.
- The two ping call sites (`probeNeighborsLatency`, `reprobeForeignPeers`) are unchanged — they
  already pass a real one-hop `res.rttMs`.

### Docs

- `docs/fret.md`: `SerializedPeerEntry` block under *Wire formats* now shows `number | null`; two
  new bullets under *Relevance score calculation* covering (a) unmeasured = `null` = neutral score,
  with the measured 1.389-vs-1.461 skew as the motivating number, and (b) what does and does not
  count as a latency sample.
- `packages/fret/README.md:126`: same type change on the `SerializedPeerEntry` block.

## How to validate

```
cd packages/fret && npx tsc --noEmit     # clean
cd packages/fret && yarn build           # clean
cd packages/fret && yarn test            # 408 passing, 0 failing (~6m)
```

Run just the scoring properties:

```
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/relevance.properties.spec.ts" --timeout 30000
```

### Behaviors worth poking at

- **A 0 ms peer must outrank a 300 ms peer.** Two entries identical but for latency
  (`successCount: 10`, `failureCount: 0`, same recency/frequency/x) previously scored
  fast = 1.389 / slow = 1.461. `healthScore` is the seam; it is exported now, so this is a
  two-line check.
- **Unmeasured sits between them.** `healthScore({avgLatencyMs: null})` must be strictly below
  `{0}` and strictly above `{1000}`. Not equal to either — an unmeasured peer that scored like a
  0 ms peer would be the opposite failure of the original bug.
- **Forward does not touch latency.** `recordSuccess(entry, undefined, x, model)` returns the
  entry's existing `avgLatencyMs` unchanged (still `null` if never pinged) while still
  incrementing `successCount` and producing a positive relevance.
- **Twenty forwards no longer erase a measurement.** A peer at 200 ms stays at 200 ms across 20
  latency-less successes (it used to decay 200 → 2.3).
- **Snapshot round-trip.** `null` exports and re-imports as `null`; a measured `0` round-trips as
  `0`; a record with the field absent reads back as `null`.

## Tests added (a floor, not a ceiling)

In `test/relevance.properties.spec.ts`:

- property: `healthScore` is non-increasing in measured latency over `[0, 5000]` (fast-check,
  200 runs) — this is the generalized guard for the whole sentinel class, not just the 0 ms point.
- property: a 0 ms peer scores strictly above any peer measured in `(1e-6, 1000]`.
- unit: unmeasured sits strictly between 0 ms and 1000 ms.
- unit: first sample seeds the average (`null` + 400 → 400).
- unit: 400 ms sample against a measured 0 ms average blends to 80, not 400.
- unit: no sample leaves `avgLatencyMs` untouched, on both a measured and an unmeasured peer.
- unit: a latency-less success still increments `successCount` and yields positive relevance.
- unit: 20 latency-less successes leave a 200 ms average at 200.

In `test/digitree.persistence.spec.ts`:

- unit: `null` round-trips as `null` and a measured `0` round-trips as `0` through
  export → import.
- unit: a serialized record with `avgLatencyMs` absent imports as `null`.

Fixtures updated to the new default: `test/digitree.invariants.spec.ts` (`serialized()` helper,
`ModelEntry.avgLatencyMs` type, `DEFAULTS`), `test/ring-membership.spec.ts:128` (the `upsert`
default assertion is now `null`), `test/service.table-persistence.spec.ts:31`.

## Known gaps — start here

- **No end-to-end test drives `routeAct`'s forward path.** The regression is asserted at the
  `recordSuccess` scoring seam (test name says so). Nothing mechanically prevents a *future* call
  site from passing a fabricated number again — the type only forbids passing "unknown", it does
  not forbid passing a wrong measurement. If the reviewer wants that closed, a service-level test
  forwarding a `maybeAct` through a two-node harness and asserting the hop's `avgLatencyMs` stayed
  `null` is the shape.
- **`test/digitree.persistence.spec.ts:46`** still generates `Math.random() * 500` and never
  exercises `null` in the round-trip *property* (only in the two new unit tests). Folding `null`
  into that generator would be strictly better coverage; left alone to keep the diff scoped.
- **Pre-nullable snapshots that wrote `0`** import as a genuine 0 ms. Documented as deliberate at
  the code site and in `docs/fret.md`, per the ticket, and consistent with AGENTS.md ("don't worry
  about backwards compatibility yet"). If snapshot back-compat ever becomes a real requirement this
  is a decision to revisit, not a bug to patch in place.
- **`healthScore` was made public purely so the test could name it.** It is a pure function
  alongside the already-exported `sparsityBonus` / `normalizedLogDistance`, so this seems in
  keeping, but it is a widened public surface and worth a second opinion.
- **`docs/review.html:259,369`** still describes this bug in the present tense. It reads as a
  historical review artifact rather than live documentation, so it was left untouched — confirm
  that reading.
- No behavior in `linkQuality` (`fret-service.ts`) was touched; it scores on success/failure
  counts only and never reads latency.

## Review findings

- Nothing parked as a tripwire — no conditional concerns surfaced during this work.
