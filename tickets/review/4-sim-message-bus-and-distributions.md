description: Review SimMessageBus, placement distributions, and capacity enforcement in the simulation harness
dependencies: none (self-contained in test/simulation/)
files:
  - packages/fret/test/simulation/message-bus.ts
  - packages/fret/test/simulation/fret-sim.ts
  - packages/fret/test/simulation/deterministic-rng.ts
  - packages/fret/test/simulation/event-scheduler.ts
  - packages/fret/test/simulation/sim-metrics.ts
  - packages/fret/test/message-bus.spec.ts
----

## What was built

### SimMessageBus (`test/simulation/message-bus.ts`)
In-process message bus that mediates inter-peer communication with configurable:
- **Latency**: constant, uniform, or normal (Gaussian) distributions
- **Loss**: RNG-driven per-message drop probability
- **Backpressure**: per-link queue capacity; drops when full
- **Per-link overrides**: `setLink(from, to, config)` for heterogeneous topologies

All randomness flows through `DeterministicRNG` for reproducibility.

### DeterministicRNG extensions (`test/simulation/deterministic-rng.ts`)
- `nextGaussian()`: Box-Muller transform for standard normal deviates
- `nextBigInt(bits)`: uniform BigInt generation for ring coordinates

### Placement distributions (in `FretSimulation`)
Three `PlacementStrategy` modes:
- **uniform** (default): evenly spaced on 256-bit ring (original behavior)
- **clustered**: Gaussian spread around N cluster centers — models datacenter clustering
- **skewed**: power-law distribution — dense/sparse regions modeling organic growth

### Capacity enforcement
Optional `capacity` field in `SimConfig`. When set, stores are capped after every stabilization round and after connect/message-deliver events. Evicts lowest-relevance entries; never evicts self.

### Integration
- `FretSimulation` optionally routes through `SimMessageBus` when `messageBus` config is provided
- Without message bus config, original instant-delivery behavior is preserved (backward compatible)
- `handleLeave` sends leave-notices through bus when enabled
- `handleStabilize` sends neighbor snapshots through bus when enabled
- `'message-deliver'` event type added to `EventScheduler`
- `messageDrops` counter added to `SimMetrics`

## Test coverage (20 tests in `message-bus.spec.ts`)

- **DeterministicRNG**: Gaussian distribution properties (mean/stddev), BigInt range/variety
- **SimMessageBus isolation**: latency delivery timing, loss rate (~50%), queue overflow drops, per-link overrides, uniform jitter, normal jitter
- **Deterministic replay**: identical metrics from same seed (with and without bus)
- **Integration**: latency slows convergence vs instant mode, 10% loss still converges, backpressure records drops
- **Placement**: clustered peers show gap structure, routing works with clusters, skewed distribution is non-uniform, uniform default unchanged
- **Capacity**: stores respect cap, self-entry preserved

All 184 tests pass (20 new + 164 existing).

## Key usage patterns for validation

```typescript
// Message bus mode
const sim = new FretSimulation({
  seed: 42, n: 20, k: 10, m: 5,
  churnRatePerSec: 0,
  stabilizationIntervalMs: 500,
  durationMs: 5000,
  messageBus: {
    defaultLatencyMs: 100,
    defaultLossRate: 0.05,
    defaultQueueCapacity: 50,
    latencyDistribution: 'normal',
    latencyJitter: 20,
  },
})

// Clustered placement
const sim = new FretSimulation({
  ...baseConfig,
  placement: 'clustered',
  clusterConfig: { numClusters: 3, spreadBits: 32 },
})

// Capacity enforcement
const sim = new FretSimulation({
  ...baseConfig,
  capacity: 50,
})
```
