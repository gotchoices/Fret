description: Add per-peer rate limiting alongside existing global token buckets
dependencies: 5-transport-identity-verification (need verified peer identity to key the per-peer buckets)
files: src/utils/token-bucket.ts, src/rpc/neighbors.ts, src/rpc/maybe-act.ts, src/rpc/leave.ts, src/rpc/ping.ts, src/service/fret-service.ts
----

### Problem

All token buckets (`bucketNeighbors`, `bucketMaybeAct`, `bucketPing`, `bucketLeave`, `bucketAnnounce`) are global per-node, not per-peer. A single attacker with one connection can exhaust all tokens in ~2 seconds per bucket. Once exhausted, all legitimate peers receive `BusyResponseV1` or have their requests dropped — complete service denial from a single connection.

Additionally, the inbound announce handler (`neighbors.ts:34-45`) has **zero** rate limiting. The `bucketNeighbors` guards outbound snapshot responses; `bucketAnnounce` limits outbound announcements sent by the victim. Neither limits inbound announce processing.

### Expected behavior

1. Per-peer sliding window or token bucket on all inbound handlers, keyed by the transport-authenticated peer identity. A single peer can only consume a fraction of the node's total capacity.
2. Global buckets remain as a secondary ceiling to bound total load regardless of peer count.
3. Inbound announce processing (`onAnnounce` path) gains rate limiting matching the other handlers. Profile-bounded array caps (`capSucc`/`capPred`/`capSample`) are applied in `mergeAnnounceSnapshot` matching `mergeNeighborSnapshots`.
4. Peers that persistently exceed their per-peer budget are temporarily blocked at the connection level.

### Threat references

- threat-analysis.md §4.1 (High): Global rate limit exhaustion — single peer DoS
- threat-analysis.md §3.4 (High): No rate limit on inbound announcements
- threat-analysis.md §2.5 (Medium): Backoff exploitation via rate limit consumption
- threat-rir-mitigated.md §4.1, §3.4: Unchanged by RiR; also blocks dispute participation
