description: Proactive neighbor announcements on topology change with profile-aware rate limiting
dependencies: FRET core (fret-service.ts, neighbors.ts, token-bucket.ts, digitree-store.ts)
files: packages/fret/src/service/fret-service.ts, packages/fret/test/proactive-announce.spec.ts
----

## Summary

Proactive announcement system in FretService notifies non-connected peers about topology changes, improving convergence speed. All announcement paths are rate-limited via a dedicated `bucketAnnounce` token bucket and bounded by profile-aware fanout.

### Key mechanisms

- **Dedicated `bucketAnnounce` token bucket** — Core: 16 capacity / 8 refill/s, Edge: 6 / 2. All announce sends gated through `sendAnnouncementsRateLimited`.
- **Bounded fanout** — Core: 8 max, Edge: 4 max.
- **Non-connected peer preference** — Peers with addresses but no active connection are preferred over connected peers (who learn via normal stabilization exchange).
- **Peer departure trigger** — On `peer:disconnect`, if the departed peer was a near neighbor, announces to remaining neighbors around that coordinate. 2s debounce per coordinate region prevents storms.
- **New peer discovery trigger** — When `mergeAnnounceSnapshot` or `mergeNeighborSnapshots` discovers new peers, announces self to a bounded subset of non-connected discovered peers.
- **On-start timing** — `proactiveAnnounceOnStart` fires after first stabilization tick (table is populated), not immediately on start.
- **Diagnostics** — `announcementsSkipped` counter tracks throttled sends; `announcementsSent` incremented consistently.

### Review notes

- Extracted `sendAnnouncementsRateLimited` helper to eliminate 4x repeated rate-limited announce loop (DRY).
- Fixed unused `coord` parameter in `isNearNeighbor` (prefixed `_coord` per conventions).
- TypeScript compiles clean. All 6 proactive announcement tests pass. No regressions in existing tests.
- Pre-existing `bucketDiscovery` test failures (off-by-one) are unrelated — caused by `emitDiscovered` consuming a token during `start()`.

### Test coverage (packages/fret/test/proactive-announce.spec.ts)

- On-start announce timing (fires after first stabilization)
- Peer disconnect trigger (5-node mesh, abrupt departure)
- Bounded fanout (edge vs core profile comparison)
- Rate limiting (edge-profile 4-node mesh, verifies sent > 0)
- Discovery-triggered announcements (line topology, gossip propagation)
- Diagnostics tracking (announcementsSkipped counter)
