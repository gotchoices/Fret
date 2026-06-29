description: Reviewed the simulation harness additions (message bus, placement distributions, store-capacity enforcement) — fixed a broken "skewed" distribution and tidied dead/inefficient code.
files:
  - packages/fret/test/simulation/message-bus.ts
  - packages/fret/test/simulation/fret-sim.ts
  - packages/fret/test/simulation/deterministic-rng.ts
  - packages/fret/test/simulation/event-scheduler.ts
  - packages/fret/test/simulation/sim-metrics.ts
  - packages/fret/test/message-bus.spec.ts
----

## What was built (implement stage)

A deterministic, test-only simulation harness gained three capabilities:

- **`SimMessageBus`** — in-process inter-peer message bus with configurable latency
  (constant / uniform / normal), per-message loss, per-link queue capacity
  (backpressure), and per-link overrides. All randomness flows through
  `DeterministicRNG` for reproducible runs.
- **Placement strategies** in `FretSimulation` — `uniform` (default, unchanged),
  `clustered` (Gaussian around N centers), `skewed` (intended power-law).
- **Store-capacity enforcement** — optional `capacity` caps each peer's store,
  evicting the lowest-relevance non-self entries.

`FretSimulation` routes through the bus only when `messageBus` config is supplied;
otherwise the original instant-delivery path is preserved. `DeterministicRNG` gained
`nextGaussian()` (Box-Muller) and `nextBigInt(bits)`.

## Review findings

Scope: read the full implement diff (`70d0e5d`) before the handoff, then every
touched file plus `DigitreeStore` (the eviction dependency). Ran `tsc --noEmit`
(clean) and the full suite — **232 passing**, no regressions, no pre-existing
failures. There is no separate lint step; `tsc` is the type/lint gate.

### Correctness — two real defects in `skewedCoord`, both fixed inline (minor)
- **The "skewed" distribution was actually uniform.** The inverse-Pareto form
  `normalized = (pareto - 1) / pareto` with `pareto = u^(1/(1-α))` algebraically
  reduces to `1 - u` — i.e. a uniform sample. Empirically the lower/upper-half
  split was ~50/50 (mean 0.4975 over 5000 samples), so the strategy modeled no
  skew at all. Replaced with `normalized = u^3`, which genuinely concentrates mass
  at the low end (lower half now ~43/50 at seed 42).
- **`u === 0` crashed the skewed path.** `pareto = 1/0 = Infinity` →
  `normalized = NaN` → `BigInt(NaN)` throws `RangeError`. Low-probability but
  reachable (`DeterministicRNG.next()` can return exactly 0). The new form maps
  `u = 0` cleanly to coordinate 0.
- **Test strengthened to lock this in.** The original assertion
  (`lowerHalf !== upperHalf`) passes for a *uniform* layout too (an exact even
  split is astronomically unlikely), so it never would have caught the bug. It now
  asserts a real imbalance: `lowerHalf > floor(upperHalf * 1.5)`.

### Dead code — removed inline (minor)
- The `'message-deliver'` event type, its `processEvent` case, and
  `handleMessageDeliver()` were never scheduled anywhere, and `handleMessageDeliver`
  only re-called `deliverPendingMessages()` — which already runs after *every*
  event. Removed all three (incl. the `SimEvent` union member). Bus delivery
  continues to piggyback on the periodic stabilization cadence, unchanged.

### Efficiency — refactored inline (minor)
- `enforceCapacity` re-listed and re-sorted the whole store on every loop iteration
  while removing one entry at a time (O(n² log n) when far over cap). Replaced with
  a single sort + slice that drops the lowest `overBy` entries at once. Eviction
  outcome is identical and remains deterministic.

### Tripwires — parked at their sites, not filed as tickets
- **Capacity eviction is ring-order, not relevance-order, today.** `DigitreeStore.upsert`
  fixes `relevance: 0`, and the sim only ever populates stores via `upsert`, so all
  entries tie and `list()`'s key order decides victims. Harmless now; becomes true
  relevance eviction for free if the harness ever scores peers. Parked as a `NOTE:`
  in `enforceCapacity` (`fret-sim.ts`).
- **In-flight bus messages at `durationMs` are never delivered** (no standalone bus
  timer; delivery rides the stabilization cadence). Acceptable — models end-of-life
  in-transit traffic. Parked as a `NOTE:` in `handleEvent` (`fret-sim.ts`).
- **`clusteredCoord` spread loses low-bit precision above ~52 bits** (scaled through
  a JS float). Default `spreadBits: 32` is exact; wrap still correct. Parked as a
  `NOTE:` at the site (`fret-sim.ts`).
- **`SimMessageBus.deliver` is a linear scan + per-message `indexOf`/`splice`.** Fine
  at sim scale; parked as a `NOTE:` in `deliver` (`message-bus.ts`) with the
  heap-based fix to reach for if in-flight counts grow.

### Checked and clean
- **Determinism preserved.** All fixes either touch only the skewed path (not used
  by replay tests) or are outcome-equivalent (capacity refactor). The two
  deterministic-replay tests still pass.
- **`nextBigInt` / `nextGaussian`** — uniformity and range verified by the
  implementer's tests; chunked BigInt generation stays within JS's 30-bit shift
  safety. No issues.
- **Docs** — the simulation harness is test-only and not described in `docs/fret.md`;
  there is no simulation README. Nothing to update.
- **No major findings**, so no new fix/plan/backlog tickets were filed.

## Key usage patterns

```typescript
// Message bus
new FretSimulation({ seed: 42, n: 20, k: 10, m: 5, churnRatePerSec: 0,
  stabilizationIntervalMs: 500, durationMs: 5000,
  messageBus: { defaultLatencyMs: 100, defaultLossRate: 0.05,
    defaultQueueCapacity: 50, latencyDistribution: 'normal', latencyJitter: 20 } })

// Clustered / skewed placement
new FretSimulation({ ...base, placement: 'clustered', clusterConfig: { numClusters: 3, spreadBits: 32 } })
new FretSimulation({ ...base, placement: 'skewed' })

// Capacity enforcement
new FretSimulation({ ...base, capacity: 50 })
```
