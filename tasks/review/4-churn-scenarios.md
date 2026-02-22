description: Churn scenario simulation tests validating FRET resilience
dependencies: simulation harness (packages/fret/test/simulation/*)
----

### Summary

Extended the simulation harness and added 5 churn scenario tests that validate FRET's overlay resilience under various failure and scaling patterns.

### Harness enhancements

**`packages/fret/test/simulation/event-scheduler.ts`**
- Added `route` event type and `targetCoord` field to `SimEvent`
- Added `scheduleAt()` for absolute-time scheduling

**`packages/fret/test/simulation/sim-metrics.ts`**
- Added `coverageTimeSeries`, `routingAttempts`, `routingSuccesses`, `routingHops[]`, `routingSuccessRate`, `avgRoutingHops` to `SimMetrics`
- Added `recordCoverage(time, coverage)` and `recordRoute(success, hops)` methods

**`packages/fret/test/simulation/fret-sim.ts`**
- `join` event handler: creates new peers mid-simulation with store seeding
- `scheduleBatchLeave(count, atMs)`: simultaneous peer departures
- `scheduleBatchJoin(count, atMs)`: burst of new peers
- `scheduleRoute(fromPeerId, targetCoord, atMs)`: route lookup scheduling
- `handleRoute()`: greedy ring routing with hop counting
- `snapshotCoverage()`: computes neighbor coverage across alive peers
- `deadNeighborRatio()`: measures stale entries in S/P sets
- Enhanced `handleStabilize()`: full S/P exchange (not just 3 random) and dead peer pruning
- Enhanced `handleLeave()`: removes departed peer from all other stores

### Test scenarios (`packages/fret/test/churn-scenarios.spec.ts`)

1. **Batched leave** (N=50, 30% departure): Coverage recovers to ≥80% — measured 87.5%
2. **Batched join** (N=20 + 30 burst): All peers have neighbors, coverage ≥70% — measured 87.5%, 0 orphans
3. **Mixed churn** (continuous join/leave at 2/s): Min 2s-window coverage ≥50% — measured 87.5%
4. **Proactive announcements** (5 peers removed): Dead neighbor ratio ≤20% — measured 0.0%
5. **Routing under churn** (20 lookups during 1/s churn): ≥80% success — measured 90%, avg 0.9 hops

### Validation

- `npx tsc --noEmit` — passes
- `npm test` — 63/63 tests passing (includes all existing + 5 new churn scenarios)
