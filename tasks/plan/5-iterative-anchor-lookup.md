description: Iterative anchor lookup and forwarding (maybeAct pipeline)
dependencies: FRET core (routing table, cohort assembly, size estimation)
----

Implement the full RouteAndMaybeAct forwarding pipeline — the core routing mechanism of FRET.

### Behavior

- **TTL**: decrement on each hop; drop if expired.
- **Breadcrumbs**: append self to breadcrumbs on forward; reject if self already present (loop detection).
- **Next-hop selection**: connected-first bias with distance, link quality, backoff, and confidence weighting (see cost function in fret.md).
- **Near vs far behavior**: when far from target, allow slack in distance improvement and prefer connected peers; when near, require strict distance improvement.
- **Payload inclusion heuristic**: include activity payload when probability of being in-cluster exceeds threshold T (based on distance to key vs expected cluster span and confidence).
- **NearAnchor response**: when in-cluster but no activity included, respond with anchor hints inviting resend.

### Interface

- Async generator or callback-based progressive result stream.
- Correlation ID for deduplication and tracing.
- Activity callback interface for threshold signature tracking (minSigs).

See [fret.md](../docs/fret.md) — Unified find+maybe-act RPC, RouteAndMaybeAct pipeline (A5).
