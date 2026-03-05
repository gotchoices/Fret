description: In-process message bus with latency/loss and topology placement distributions for simulation harness
dependencies: Digitree, DeterministicRNG, EventScheduler, FretSimulation (existing test/simulation/)
files:
  - packages/fret/test/simulation/fret-sim.ts
  - packages/fret/test/simulation/event-scheduler.ts
  - packages/fret/test/simulation/deterministic-rng.ts
  - packages/fret/test/simulation/sim-metrics.ts
  - packages/fret/test/simulation.spec.ts
  - packages/fret/test/churn-scenarios.spec.ts
  - packages/fret/src/store/digitree-store.ts
----

The existing simulation harness drives FRET overlay validation but bypasses realistic message passing — stabilization directly reads from other peers' stores, messages arrive instantly, and there's no latency, loss, or backpressure modeling. This ticket adds the two most critical missing pieces: a message bus abstraction and configurable topology placement.

### 1. SimMessageBus

Create `packages/fret/test/simulation/message-bus.ts`.

The message bus mediates all inter-peer communication in the simulation. Instead of `handleStabilize` directly reading neighbor stores, peers send and receive messages through the bus, which applies configurable latency and loss.

```typescript
interface SimMessage {
  from: string;
  to: string;
  type: 'neighbor-request' | 'neighbor-response' | 'route-request' | 'route-response' | 'leave-notice';
  payload: unknown;
  scheduledDelivery: number;  // absolute sim time
}

interface LinkConfig {
  latencyMs: number | (() => number);  // constant or distribution function
  lossRate: number;                     // [0, 1]
  queueCapacity: number;               // max pending messages per link
}

type LatencyDistribution = 'constant' | 'uniform' | 'normal';

interface MessageBusConfig {
  defaultLatencyMs: number;
  defaultLossRate: number;
  defaultQueueCapacity: number;
  latencyDistribution: LatencyDistribution;
  latencyJitter: number;  // for uniform/normal: range or stddev
}
```

Behavior:
- `send(msg)` computes delivery time from link config, applies loss (RNG-driven), enqueues if within capacity, drops if queue full (records drop in metrics).
- `deliver(upToTime)` returns messages whose scheduledDelivery <= time, in order.
- Per-link overrides via `setLink(from, to, config)` for heterogeneous topologies.
- Latency functions use the simulation's `DeterministicRNG` for reproducibility.

### 2. Topology placement distributions

Extend `FretSimulation` (or extract a `TopologyGenerator`) to support three placement modes:

- **uniform**: Current behavior — evenly spaced on the 256-bit ring.
- **clustered**: `numClusters` centers chosen uniformly; peers assigned to clusters with Gaussian spread around centers. Models geographic/datacenter clustering.
- **skewed**: Power-law distribution — a few ring regions are dense, most are sparse. Models organic growth.

```typescript
type PlacementStrategy = 'uniform' | 'clustered' | 'skewed';

interface ClusterConfig {
  numClusters: number;
  spreadBits: number;  // Gaussian stddev in ring-bit terms
}
```

The `DeterministicRNG` already supports the primitives needed. Add:
- `nextGaussian()`: Box-Muller transform using `next()`.
- `nextBigInt(bits)`: Generate a random BigInt of the given bit width.

### 3. Integration with FretSimulation

Refactor `FretSimulation`:
- Constructor accepts optional `MessageBusConfig` and `PlacementStrategy`.
- `handleStabilize` sends neighbor-request/response messages through the bus instead of direct store reads.
- `handleRoute` sends route-request messages through the bus.
- New event type `'message-deliver'` in `EventScheduler` for deferred message arrivals.
- A new simulation step: after processing an event, call `bus.deliver(currentTime)` and process delivered messages.

The existing direct-manipulation mode should remain as the default (no message bus = instantaneous delivery) for backward compatibility with existing tests.

### 4. Capacity enforcement

Add an optional `capacity` parameter to `SimConfig`. When set, after each stabilization round, enforce a store cap per peer: if `store.size() > capacity`, evict lowest-relevance entries (using `store.list()` sorted by relevance, removing the tail).

### Key tests

- **Deterministic replay**: Two runs with the same seed and config produce identical metrics (byte-for-byte JSON match).
- **Message bus latency**: With latency=100ms, messages scheduled at t=0 arrive at t=100. Coverage convergence takes longer than instant mode.
- **Message loss**: With lossRate=0.1, ~10% of messages are dropped. Stabilization still converges but takes more cycles.
- **Backpressure**: With queueCapacity=5, bursts of >5 messages result in drops recorded in metrics.
- **Clustered placement**: With 3 clusters of 10 peers each, inter-cluster routing takes more hops than uniform placement.
- **Skewed placement**: Dense regions have high coverage quickly; sparse regions take longer.
- **Capacity enforcement**: With capacity=50 and N=100, no store exceeds 50 entries after stabilization.

## TODO

### Phase 1: Message bus
- [ ] Create `SimMessageBus` class in `test/simulation/message-bus.ts`
- [ ] Add `nextGaussian()` and `nextBigInt(bits)` to `DeterministicRNG`
- [ ] Add `'message-deliver'` event type to `EventScheduler`
- [ ] Write tests for message bus in isolation (latency, loss, queue overflow)

### Phase 2: Placement distributions
- [ ] Implement uniform/clustered/skewed placement in `FretSimulation` or extracted generator
- [ ] Write tests verifying distribution properties (cluster detection, skewness)

### Phase 3: Integration
- [ ] Refactor `FretSimulation` to optionally route through `SimMessageBus`
- [ ] Add capacity enforcement logic
- [ ] Update `SimConfig` with new parameters (messageBus, placement, capacity)
- [ ] Ensure existing tests still pass (backward compatibility with default config)
- [ ] Add new simulation tests: latency impact, loss recovery, clustered routing, skewed convergence
- [ ] Type-check and run full test suite
