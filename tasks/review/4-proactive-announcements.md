description: Proactive neighbor announcements on topology change with profile-aware rate limiting
dependencies: FRET core (fret-service.ts, neighbors.ts, token-bucket.ts, digitree-store.ts)
----

## Summary

Added proactive announcement system to FretService that notifies non-connected peers about topology changes, improving convergence speed.

### What was implemented

1. **Dedicated `bucketAnnounce` token bucket** — Profile-aware rate limiting (core: 16/8, edge: 6/2) for all announcement sends. `announcementsSkipped` diagnostic counter tracks throttled sends.

2. **Bounded fanout per profile** — Core: 8 max, Edge: 4 max. Applied in `announceNeighborsBounded` and all new announce paths.

3. **Non-connected peer filter** — `announceNeighborsBounded` prefers non-connected peers with addresses; falls back to connected peers. Connected peers already learn via normal stabilization exchange.

4. **Peer departure trigger (`announceOnDeparture`)** — On `peer:disconnect`, if the departed peer was a near neighbor (within S/P range), announces to remaining neighbors around that coordinate. Includes 2s debounce per coordinate region to prevent storms.

5. **New peer discovery trigger (`announceToNewPeers`)** — When `mergeAnnounceSnapshot` or `mergeNeighborSnapshots` discovers new peers, announces self to a bounded subset of non-connected discovered peers.

6. **On-start announce timing** — `proactiveAnnounceOnStart` now fires after the first stabilization tick (table is populated), not immediately on start. `postBootstrapAnnounced` one-shot retained as safety net.

7. **Diagnostics** — `announcementsSkipped` counter added. `announcementsSent` incremented consistently across all announce paths. `announceReplacementsToNeighbors` also gated by `bucketAnnounce`.

### Key files changed

- `packages/fret/src/service/fret-service.ts` — All changes (rate bucket, triggers, methods, diagnostics)

### Testing

Test file: `packages/fret/test/proactive-announce.spec.ts` (6 tests, all passing)

- **on-start announce timing**: Verifies announcements fire after first stabilization tick
- **peer disconnect trigger**: 5-node mesh, abruptly stops one node, verifies additional announcements sent by remaining nodes
- **bounded fanout (edge vs core)**: Two parallel 6-node meshes (edge and core profiles), verifies core sends >= edge announcements
- **rate limiting**: Edge-profile 4-node mesh, verifies `announcementsSent > 0` and `announcementsSkipped` counter is tracked
- **discovery-triggered announcements**: Line topology (A-B-C-D), verifies gossip propagation triggers announcements and distant peers are discovered
- **diagnostics tracking**: Verifies `announcementsSkipped` property exists and is a number

### Validation

- TypeScript compiles clean (`tsc --noEmit`)
- All 90 tests pass (full suite, 3 min)
- No regressions in existing churn, leave, routing, or integration tests
