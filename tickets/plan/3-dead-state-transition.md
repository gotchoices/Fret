description: Implement consecutive failure tracking and dead state transition per design doc
dependencies: none
files: src/service/fret-service.ts, src/store/digitree-store.ts, src/store/relevance.ts
----

### Problem

The `PeerState` type includes `'dead'` but it is never set programmatically. The design doc specifies "Hard failure (3+ consecutive timeouts or explicit error): remove from S/P; mark as dead in Digitree" but the implementation only decays relevance via `applyFailure` (0.7 factor).

Dead peers accumulate in the store with low-but-nonzero relevance, consuming capacity slots and potentially appearing in cohort walks. They're only removed by explicit `store.remove` (leave handling) or capacity eviction. In the context of RiR dispute escalation, stale peers in enlistee selection waste escalation rounds.

### Expected behavior

Track consecutive failures per peer. After a configurable threshold (default 3) of consecutive timeouts or explicit errors, transition the peer to `'dead'` state. Dead peers are removed from S/P sets and excluded from cohort assembly and next-hop selection. On successful contact after failure, reset the counter and transition back to `'disconnected'` or `'connected'`.

### Threat references

- threat-analysis.md §7.6 (Medium): Missing dead state transition
- threat-rir-mitigated.md §7.6: Unchanged by RiR
