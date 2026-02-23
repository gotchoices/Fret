description: Payload bounds, TTL/timestamp validation, and busy responses in all RPC handlers
dependencies: none
----

### Summary

Hardened all RPC handlers with pre-deserialization payload size limits, timestamp freshness checks, and explicit `BusyResponseV1` backpressure signaling.

### Key Interfaces

**`readAllBounded(stream, maxBytes)`** (`rpc/protocols.ts`): Reads all chunks from an async iterable, rejecting with `payload too large` if cumulative size exceeds `maxBytes`. Applied at every RPC ingress point.

**`validateTimestamp(ts, maxDriftMs?)`** (`rpc/protocols.ts`): Returns `false` if `|Date.now() - ts| > maxDriftMs` (default 5 min). Used in `handleMaybeAct`, `handleLeave`, and `mergeAnnounceSnapshot`.

**`BusyResponseV1`** (`index.ts`): `{ v: 1, busy: true, retry_after_ms: number }` — returned by rate-limited handlers. Clients detect via `isBusy()` guard and apply exponential backoff.

### Per-Handler Payload Limits
| Handler | Edge | Core |
|---------|------|------|
| ping | 1 KB | 1 KB |
| neighbors/announce | 64 KB | 128 KB |
| maybeAct | 256 KB | 512 KB |
| leave | 4 KB | 4 KB |

### Rate Limiting
Token buckets per handler (`bucketNeighbors`, `bucketMaybeAct`, `bucketPing`, `bucketLeave`) with profile-tuned capacity/refill. In-flight cap on `handleMaybeAct` (core: 16, edge: 4).

### Client-Side Busy Handling
- `sendPing`: returns `ok: false` on busy
- `fetchNeighbors`: returns empty snapshot on busy
- `routeAct` forwarding: records backoff, tries fallback peers
- `iterativeLookup`: skips busy peers, continues routing

### Rejection Diagnostics
`diag.rejected.{payloadTooLarge, timestampBounds, ttlExpired, rateLimited}` — counters accessible via `getDiagnostics()`.

### Testing (11 tests in `test/payload-bounds-ttl.spec.ts`)
- `validateTimestamp`: within window, outside window, custom drift
- `readAllBounded`: within limit, single-chunk overflow, multi-chunk overflow
- Oversized maybeAct payload at RPC layer rejected without crash
- Stale timestamp, future timestamp, TTL=0 rejection with diagnostic counters
- `BusyResponseV1` for exhausted maybeAct and neighbors buckets
- Valid message passes through normally
- Multiple rejection types tracked independently

### Validation
- TypeScript build passes
- All 67 tests pass (including 11 new)
- No regressions
- Test README updated
