description: libp2p in-memory integration tests
dependencies: FRET core, libp2p memory transport
----

Integration tests using libp2p's memory transport to verify FRET end-to-end without real networking.

### Coverage

- Spin up 3–10 nodes with memory transport.
- Verify neighbor exchange: nodes discover each other and populate S/P sets.
- Verify routeAct: messages route to correct anchors and activities complete.
- Verify stabilization: after initial join, topology converges to correct state.
- Verify leave: graceful departure updates remaining peers' tables.

### Design

- Use libp2p's in-memory transport (no TCP/UDP).
- Deterministic where possible; timeout guards for CI stability.
- Validate against ring invariants after each operation.

See [fret.md](../docs/fret.md) — libp2p integration, Join and bootstrap, Stabilization.
