----
description: The design calls for peers that repeatedly fail to be marked dead and dropped from routing, but the code never actually marks any peer dead, so unreachable peers linger in the routing table and keep getting selected.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/store/digitree-store.ts, packages/fret/src/store/relevance.ts
difficulty: medium
----
The `PeerState` type includes `'dead'`, but nothing in the service ever sets it. The design doc's "Failure detection and recovery" section specifies that a hard failure — three or more consecutive timeouts, or an explicit error — should remove the peer from the successor/predecessor sets and mark it dead in the routing table, with recovery resetting it on the next successful contact. Today the only failure response is relevance decay via `applyFailure` (0.7 factor). Dead peers therefore accumulate at low-but-nonzero relevance, keep consuming capacity, and can still surface in cohort walks and next-hop selection. Review finding T1 flags this as a possible doc/code divergence.

### Expected behavior
- Consecutive failures are tracked per peer.
- After a configurable threshold (default 3) of consecutive timeouts or an explicit error, the peer transitions to `'dead'`.
- Dead peers are excluded from successor/predecessor sets, cohort assembly, and next-hop selection.
- A successful contact resets the consecutive-failure counter and transitions the peer back to a live state (`connected`/`disconnected`), per the doc's recovery-on-contact rule.

### Design direction
- Decide where the consecutive-failure counter lives (routing-table entry vs service-side) and how it resets on success.
- Decide how "dead" excludes from the ring views — this likely composes with the existing member-only ring filter (dead should be filtered the same way `unknown`/`foreign` are), so settle whether it extends the existing predicate or adds a separate guard.
- Confirm interaction with capacity eviction (dead peers should be preferred eviction victims) and with the classification/re-probe passes (a dead peer that recovers must be able to re-enter).

The plan agent should settle the above and enumerate the failure call sites that feed the counter (ping failure, RPC failure) before handing to implement. Include tests covering: three-strikes dead-marking, exclusion from S/P/cohort/next-hop, and recovery reset on successful contact — the review's "failure machinery untested" gap.

References: fret-service.ts failure handling (`applyFailure`), the ring-view member filter, cohort assembly, and next-hop selection; `PeerState` in the store. Review "Core service"/"Tests" findings (missing dead state transition, T1); design doc "Stabilization and churn handling"; threat-analysis.md §7.6.
