description: Churn scenario simulation tests
dependencies: simulation harness (4-simulation-harness)
----

Use the simulation harness to validate FRET's resilience under churn.

### Scenarios

- **Batched leave**: simultaneous departure of X% of peers; verify S/P sets recover within bounded time.
- **Batched join**: burst of new peers; verify stabilization converges and no peer is orphaned.
- **Mixed churn**: continuous join/leave at configurable rate; verify neighbor coverage remains above threshold.
- **Proactive announcements**: verify that neighbor announcements maintain coverage during churn; non-connected peers receive updates.
- **Routing under churn**: routeAct still finds anchors and completes activities during active churn.

### Metrics

- Time to re-stabilize after churn event.
- Neighbor coverage (% of ideal S/P filled) over time.
- Routing success rate and hop count distribution during churn.

See [fret.md](../docs/fret.md) — Stabilization and churn handling, Leave protocol.
