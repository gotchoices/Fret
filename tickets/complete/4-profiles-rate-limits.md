description: Profile enforcement tests — Edge vs Core rate limits, caps, and backpressure
dependencies: packages/fret (FretService, TokenBucket)
files: packages/fret/test/profile.behavior.spec.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/utils/token-bucket.ts
----

## What was built

34 profile behavior tests in `packages/fret/test/profile.behavior.spec.ts` verifying Edge vs Core profile enforcement across all profile-differentiated parameters.

### Coverage

- **Token bucket capacity & refill (12 tests)**: All 6 bucket types (Discovery, Neighbors, MaybeAct, Ping, Leave, Announce) for both profiles. Capacity verified by drain counting; refill rates verified via internal state.
- **retryAfterMs & announce fanout (4 tests)**: TokenBucket returns 0 when available, >0 when empty. Core fanout=8, Edge=4.
- **Snapshot export caps (2 tests)**: Edge ≤ 6/6/6, Core ≤ 12/12/8 (succ/pred/sample).
- **Snapshot receive caps (2 tests)**: Edge bounded by 8+8+6=22, Core by 16+16+8=40.
- **Concurrent act limits & busy responses (5 tests)**: Behavioral boundary tests at limit-1 vs at-limit. BusyResponseV1 on bucket exhaustion.
- **Payload size limits (4 tests)**: maxBytesNeighbors Core=128KB, Edge=64KB. maxBytesMaybeAct Core=512KB, Edge=256KB.
- **Preconnect budget (2 tests)**: Core=6, Edge=3.
- **Profile defaults (2 tests)**: Default is core; edge when requested.
- **Diagnostics (1 test)**: rateLimited counter increments correctly.

### Review notes

- Tests are data-driven where appropriate (Phase 1 bucket specs array)
- Assertions verified against implementation in fret-service.ts constructor (lines 121-145), handlers (lines 288-341), snapshot (lines 789-817), mergeNeighborSnapshots (lines 750-786), and preconnect (line 418)
- All values align with docs/fret.md Operating profiles section
- TypeScript compiles cleanly
- 34/34 profile tests pass; 154/156 total suite (2 pre-existing flaky tests in proactive-announce.spec.ts unrelated to this ticket)

### Testing

```bash
cd packages/fret && yarn test
# or single file:
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/profile.behavior.spec.ts" --timeout 30000
```
