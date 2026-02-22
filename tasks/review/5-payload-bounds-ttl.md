description: Payload bounds, TTL/timestamp validation, and busy responses in all RPC handlers
dependencies: none
----

### Summary

Hardened all RPC handlers with pre-deserialization payload size limits, timestamp freshness checks, and explicit `BusyResponseV1` backpressure signaling.

### Changes

**Shared bounded reader** (`rpc/protocols.ts`):
- Added `readAllBounded(stream, maxBytes)` — rejects payloads exceeding the limit before deserialization
- Added `toBytes()` helper — consolidated from 4 duplicate copies
- Added `validateTimestamp(ts, maxDriftMs)` — rejects timestamps outside ±5 min window
- Removed duplicate `readAll`/`toBytes` from `ping.ts`, `neighbors.ts`, `maybe-act.ts`, `leave.ts`

**BusyResponseV1** (`index.ts`):
- New type: `{ v: 1, busy: true, retry_after_ms: number }`
- Returned by rate-limited handlers instead of silently degraded responses

**Per-handler payload limits**:
- ping: 1 KB
- neighbors/announce: 64 KB (edge) / 128 KB (core)
- maybeAct: 256 KB (edge) / 512 KB (core)
- leave: 4 KB

**Timestamp validation** (`fret-service.ts`):
- `handleMaybeAct`: rejects messages with timestamps outside ±5 min
- `mergeAnnounceSnapshot`: ignores stale neighbor announcements
- `handleLeave`: ignores stale leave notices

**Rate limiting with busy responses** (`fret-service.ts`):
- `handleNeighborsRequest`: returns `BusyResponseV1` instead of empty snapshot
- `handleMaybeAct`: returns `BusyResponseV1` when bucket empty or in-flight cap hit
- New `bucketPing` and `bucketLeave` rate limiters with profile-tuned budgets
- `handlePingRequest`: rate limits pings with `BusyResponseV1`

**Client-side busy handling**:
- `sendPing`: detects busy response, returns `ok: false`
- `fetchNeighbors`: detects busy response, returns empty snapshot
- `sendMaybeAct`: return type includes `BusyResponseV1`
- `routeAct` forwarding: treats busy as backoff signal, tries fallback
- `iterativeLookup`: skips busy peers with backoff, continues routing

**Rejection diagnostics** (`fret-service.ts`):
- Extended `diag` with `rejected.{payloadTooLarge, timestampBounds, ttlExpired, rateLimited}`

### Testing

`test/payload-bounds-ttl.spec.ts` — 11 tests:
- `validateTimestamp`: accepts within window, rejects outside, supports custom drift
- `readAllBounded`: reads within limit, rejects single-chunk overflow, rejects multi-chunk overflow
- Oversized maybeAct payload at RPC layer rejected without crash
- Stale timestamp rejected with diagnostic counter
- Future timestamp rejected
- TTL ≤ 0 rejected with diagnostic counter
- BusyResponseV1 when maybeAct bucket exhausted
- BusyResponseV1 when neighbors bucket exhausted
- Valid message passes through normally
- Multiple rejection types tracked independently

### Validation

- TypeScript build passes (`npm run build`)
- All 58 tests pass (`npm test`), including 11 new tests
- All existing tests remain green (no regressions)
