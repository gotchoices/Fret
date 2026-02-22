description: Deterministic simulation harness (headless) for FRET overlay validation
dependencies: Digitree, FRET core (routing table, stabilization, cohort assembly)
----

Build a headless, deterministic simulation environment for validating FRET overlay behavior at scale without real networking.

### Components

- **Deterministic RNG**: seeded PRNG for reproducible topology generation. N peers placed on 256-bit ring with controllable distribution (uniform, clustered, skewed).
- **Event scheduler**: discrete-event loop driving joins, leaves, link-latency injection, and message delivery. Bounded queues to emulate backpressure and dropped messages.
- **Metrics collection**: stabilization convergence time, neighbor coverage (% of ideal S/P filled), path length distribution, drop/retry rates, routing success rate.

### Design considerations

- Must be transport-agnostic — no libp2p dependency. Peers communicate through an in-process message bus with configurable latency/loss.
- Parameterizable: N (peer count), churn rate, latency distribution, capacity C, profile (Edge/Core).
- Output structured JSON metrics for CI consumption and trend analysis.

See [fret.md](../docs/fret.md) — Testing strategy, Configuration, Operating profiles.
