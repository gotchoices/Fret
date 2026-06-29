description: Diagnostics counters, hop counts, and convergence metrics
dependencies: FRET core (all modules)
----

Add operational diagnostics for monitoring and debugging FRET in production.

### Counters

- Per-RPC: send/receive counts, errors, latency histograms (neighbors, maybeAct, leave, ping).
- Routing: hop count distribution, routing success/failure rate, TTL exhaustion count.
- Stabilization: convergence events, S/P gap count, probes sent/succeeded.
- Table: current size, evictions, insertions, capacity utilization.

### Interface

- Structured counters accessible programmatically (for higher-layer metrics systems).
- Debug toggle: when enabled, log detailed per-operation traces with correlation IDs and cohort sizes.
- No mandatory external dependency (no prometheus, etc.) — just expose data; consumers choose format.

See [fret.md](../docs/fret.md) — Metrics, logging, and tracing (A8).
