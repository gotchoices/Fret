description: Structured JSON metrics output, Edge/Core profile simulation, and CI integration for simulation harness
files:
  - packages/fret/test/simulation/sim-metrics.ts
  - packages/fret/test/simulation/fret-sim.ts
  - packages/fret/test/sim-profiles.spec.ts
  - .gitignore
----

## What was built

### 1. Structured JSON metrics output (`sim-metrics.ts`)
- `percentile(sorted, p)` — nearest-rank percentile from a sorted array
- `percentileSummary(values)` — builds `PercentileSummary` (p50/p90/p99/max) from unsorted data
- `SimReport` interface with `meta` (seed, config, timestamp, gitSha), `summary` (SimMetrics), and `distributions` (routing hops, neighbor count percentiles, convergence summary)
- `MetricsCollector.toReport(config)` — builds a full SimReport with distribution summaries
- `MetricsCollector.toJSON(config)` — serializes to CI-consumable JSON string

### 2. Edge/Core profile simulation (`fret-sim.ts`)
- `SimPeerConfig` interface: `profile`, `snapshotCap` (successors/predecessors/sample), `stabilizationIntervalMs`, `maxConnections`
- `EDGE_PROFILE` (6/6/6 caps, 2000ms cadence, 4 max connections) and `CORE_PROFILE` (12/12/8 caps, 500ms cadence, 12 max connections) constants
- `ProfileMix` interface and `profileMix` field on `SimConfig` (e.g., `{ edge: 0.7, core: 0.3 }`)
- Profile assignment during peer creation via RNG-driven threshold
- Per-profile stabilization cadence: global tick at fastest cadence, per-peer gating based on profile interval
- Snapshot caps enforced in both bus-based and direct neighbor exchange
- Connection budget enforced via `maxConnections` in `handleConnect`

### 3. CI integration
- `.gitignore` entry for `packages/fret/test/simulation/output/`
- JSON schema documented via TypeScript interfaces (`SimReport`, `PercentileSummary`, `ConvergenceSummary`)
- Regression threshold test: routing success rate >= 85%

## Key tests (`sim-profiles.spec.ts`)

- **Percentile accuracy**: known inputs (1..100), empty array, single-element array
- **JSON round-trip**: `toJSON()` output parses back and matches original metrics
- **toReport() distributions**: verifies routing hops and convergence summaries
- **Mixed profile convergence**: 70% edge / 30% core network converges and meets coverage threshold
- **All-core vs mixed comparison**: all-core converges at least as well as mixed
- **Edge snapshot caps**: all-edge network verifies 6/6/6 caps
- **Edge connection limits**: verifies maxConnections = 4
- **Regression threshold**: 50-peer network routing success rate >= 85%

## Usage

```typescript
// Run simulation with mixed profiles
const sim = new FretSimulation({
  seed: 42, n: 30, k: 15, m: 8,
  churnRatePerSec: 0,
  stabilizationIntervalMs: 500,
  durationMs: 10000,
  profileMix: { edge: 0.7, core: 0.3 },
})
sim.run()

// Generate CI-consumable JSON report
const json = sim.metrics.toJSON({ seed: 42, config: { n: 30 } })
// Write to output directory for CI trend analysis
```
