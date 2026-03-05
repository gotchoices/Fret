description: Structured JSON metrics output, Edge/Core profile simulation, and CI integration for simulation harness
dependencies: 4-sim-message-bus-and-distributions (message bus should land first or concurrently)
files:
  - packages/fret/test/simulation/sim-metrics.ts
  - packages/fret/test/simulation/fret-sim.ts
  - packages/fret/test/simulation.spec.ts
  - packages/fret/test/churn-scenarios.spec.ts
  - packages/fret/src/index.ts (FretConfig, profile types)
----

Extends the simulation harness with structured output for CI consumption, Edge/Core profile differentiation, and trend-ready metrics.

### 1. Structured JSON metrics output

The `MetricsCollector.finalize()` already returns a `SimMetrics` object. Extend it with:

- **JSON export method**: `toJSON(): string` that produces a CI-consumable JSON document.
- **Run metadata envelope**: seed, config, timestamp, git SHA (if available from env).
- **Distribution summaries**: percentiles (p50, p90, p99) for routing hops, neighbor counts, and convergence time series.
- **Histogram bins** for path length distribution (already tracked as `routingHops[]`; add binning).

```typescript
interface SimReport {
  meta: {
    seed: number;
    config: SimConfig;
    timestamp: string;  // ISO 8601
    gitSha?: string;
  };
  summary: SimMetrics;
  distributions: {
    routingHops: { p50: number; p90: number; p99: number; max: number };
    neighborCount: { p50: number; p90: number; p99: number };
    convergence: { timeToTarget: number; finalCoverage: number };
  };
}
```

### 2. Edge/Core profile simulation

Add `profile: 'edge' | 'core'` per simulated peer (or as a global default with per-peer overrides). Profile affects:

- **Snapshot caps**: Edge peers send/receive smaller neighbor snapshots (≤6/6/6 S/P/sample) vs Core (≤12/12/8) per fret.md.
- **Stabilization cadence**: Edge has longer intervals; Core stabilizes more frequently.
- **Connection budget**: Edge limits concurrent connections (2-4); Core allows more (6-12).

This doesn't need to model the full token bucket / rate limiting — just the behavioral differences that affect topology convergence and routing efficiency.

```typescript
interface SimPeerConfig {
  profile: 'edge' | 'core';
  snapshotCap: { successors: number; predecessors: number; sample: number };
  stabilizationIntervalMs: number;
  maxConnections: number;
}
```

Add a `profileMix` parameter to `SimConfig`: ratio of edge to core peers (e.g., `{ edge: 0.7, core: 0.3 }`).

### 3. CI integration pattern

- Simulation tests that produce JSON output should write to a configurable directory (default: `test/simulation/output/`).
- Add a `.gitignore` entry for simulation output.
- Document the JSON schema so CI pipelines can parse and trend.
- Tests should assert regression thresholds (e.g., "routing success rate must not drop below 85%") while still outputting full metrics for trend analysis.

### Key tests

- **JSON round-trip**: `toJSON()` output parses back and matches original metrics.
- **Edge vs Core convergence**: A mixed network (70% edge, 30% core) converges slower than all-core, but still meets coverage threshold.
- **Edge snapshot caps**: Edge peers never send snapshots exceeding their profile limits.
- **Percentile accuracy**: Distribution summaries match hand-calculated values for known inputs.

## TODO

- [ ] Add percentile calculation utility to `MetricsCollector` (p50, p90, p99 from sorted arrays)
- [ ] Add `SimReport` interface and `toJSON()` / `toReport()` methods to `MetricsCollector`
- [ ] Add `SimPeerConfig` with profile-driven caps to `FretSimulation`
- [ ] Add `profileMix` parameter to `SimConfig`; assign profiles during peer creation
- [ ] Apply snapshot caps during simulated stabilization exchange
- [ ] Apply per-profile stabilization cadence (schedule different intervals per peer)
- [ ] Add simulation tests: mixed-profile convergence, edge cap enforcement, JSON output
- [ ] Add `.gitignore` entry for `test/simulation/output/`
- [ ] Type-check and run full test suite
