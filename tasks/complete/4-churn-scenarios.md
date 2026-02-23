description: Churn scenario simulation tests validating FRET resilience
dependencies: simulation harness (packages/fret/test/simulation/*)
----

### Summary

5 churn scenario tests validate FRET's overlay resilience under various failure and scaling patterns. All deterministic (seeded RNG), all passing.

### Test scenarios (`packages/fret/test/churn-scenarios.spec.ts`)

1. **Batched leave** (N=50, 30% departure): Coverage recovers to >=80% after 5s stabilization
2. **Batched join** (N=20 + 30 burst): All peers integrated with no orphans, coverage >=70%
3. **Mixed churn** (continuous join/leave at 2/s): Coverage never drops below 50% in any 2s window
4. **Proactive announcements** (5 peers removed): Dead neighbor ratio <=20% after stabilization
5. **Routing under churn** (20 lookups during 1/s churn): >=80% routing success, hops bounded by O(log N)

### Harness enhancements

- `EventScheduler`: `scheduleAt()` for absolute-time events, `route` event type
- `MetricsCollector`: coverage time series, routing attempt/success/hop tracking
- `FretSimulation`: batch join/leave scheduling, greedy ring routing with hop counting, coverage snapshots, dead neighbor ratio measurement, public `processEvent()` for manual stepping

### Review fixes applied

- Exposed `processEvent()` on FretSimulation — eliminates `(sim as any).handleEvent()` type casts in tests
- Simplified `createPeer` coordinate range formula (removed redundant `config.n + nextPeerIndex - config.n` -> `nextPeerIndex`)
- Increased `simulation.spec.ts` timeout from 30s to 60s (N=100 test was hitting 28s, matching churn suite's 60s timeout)

### Validation

- `npx tsc --noEmit` passes
- `npm test` — 67/67 tests passing
