description: Profile enforcement tests — Edge vs Core rate limits, caps, and backpressure
dependencies: packages/fret (FretService, TokenBucket, token-bucket.ts, fret-service.ts)
files: packages/fret/test/profile.behavior.spec.ts
----

## Summary

Comprehensive profile behavior tests verifying Edge vs Core profile enforcement across all profile-differentiated parameters in FretService. 34 tests covering 5 phases.

### What was built

Augmented `packages/fret/test/profile.behavior.spec.ts` with systematic coverage:

**Phase 1 — Token bucket capacity & refill rates (12 tests)**
- All 6 bucket types (Discovery, Neighbors, MaybeAct, Ping, Leave, Announce) verified for both profiles
- Capacity verified by draining bucket and counting accepted takes
- Refill rates verified via internal state inspection (`(bucket as any).refillPerSec`)

**Phase 1b — retryAfterMs & announce fanout (4 tests)**
- retryAfterMs returns 0 when tokens available, >0 when empty
- announceFanout: Core=8, Edge=4

**Phase 2 — Snapshot caps (4 tests)**
- Export caps: Edge ≤ 6/6/6 (succ/pred/sample), Core ≤ 12/12/8
- Receive caps: Edge bounded by 8+8+6=22 max, Core bounded by 16+16+8=40 max

**Phase 3 — Concurrent act limits & busy responses (5 tests)**
- Behavioral boundary tests: inflightAct at limit-1 passes, at limit returns BusyResponseV1 with retry_after_ms=500
- BusyResponseV1 on bucket exhaustion for handleMaybeAct, handleNeighborsRequest, handlePingRequest
- diag.rejected.rateLimited counter verified

**Phase 4 — Payload size limits (4 tests)**
- maxBytesNeighbors: Core=131072 (128KB), Edge=65536 (64KB)
- maxBytesMaybeAct: Core=524288 (512KB), Edge=262144 (256KB)

**Phase 5 — Preconnect budget (2 tests)**
- Active mode preconnect loop bounded by budget: Core=6, Edge=3
- Verified via behavioral observation (pingsSent bounded by budget)

**Profile config defaults (2 tests)** — default profile is core; edge when requested

**Diagnostics rejection tracking (1 test)** — rateLimited counter increments correctly

### Key improvements over prior version
- Added refill rate verification for all 6 bucket types (was missing)
- Replaced tautological inflight act tests with behavioral boundary tests (under-limit vs at-limit)
- Replaced tautological preconnect budget tests with behavioral tests using active mode
- Exact byte values in payload size test names for clarity

### Testing
- 34 profile behavior tests pass
- 120 total tests pass across full fret package
- TypeScript compiles cleanly (`tsc --noEmit`)

### Validation
- Run: `cd packages/fret && yarn test`
- Or single file: `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/profile.behavior.spec.ts" --timeout 30000`
