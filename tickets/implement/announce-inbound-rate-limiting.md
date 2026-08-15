----
description: Incoming peer-list announcements are processed with no rate limit and no cap on how many peers each one carries, so a single large announcement can force the node into thousands of expensive cryptographic operations.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/test/announce-rate-limit.spec.ts (new)
----
The inbound announce handler has no token bucket, and `mergeAnnounceSnapshot` iterates every remote-supplied successor, predecessor, and sample entry with no caps — unlike the neighbor-fetch merge path, which caps at 16 successors / 16 predecessors / 8 sample. Because the RPC layer accepts up to a 128 KB message, a single crafted announce can carry thousands of ids, and processing each one costs a `peerIdFromString` parse, a SHA-256 hash, and an upsert. The outbound `bucketNeighbors` and `bucketAnnounce` buckets do not help — they guard *outbound* work only.

This covers review finding M-core-2: apply the fetch-path caps to the announce merge, and gate the inbound announce handler on a token bucket.

### Expected behavior
- Inbound announce processing is rate-limited by a global token bucket, profile-tuned (Edge lower than Core), checked before any merge work. On rejection, the diagnostics rate-limited counter increments and the message is dropped without merging.
- `mergeAnnounceSnapshot` slices remote `successors`/`predecessors`/`sample` to the same profile caps the neighbor-fetch merge uses before iterating.

### Design
Add a per-profile inbound-announce token bucket to `FretService`, initialized in the constructor alongside the other buckets. Check it in the announce callback before calling `mergeAnnounceSnapshot`; on rejection increment the rate-limited diagnostics counter and return.

In `mergeAnnounceSnapshot`, apply profile caps matching the neighbor-fetch merge path (Core 16/16/8, Edge 8/8/6 for successors/predecessors/sample) — slice each list before the ingest loop.

### Edge cases & interactions
- Bucket exhaustion must drop, not throw, and must not desync any inflight counters.
- Caps apply per message; a peer sending many small announces is still governed by the bucket.
- Keep the caps in sync with the neighbor-fetch merge constants (single source of truth if practical).

### TODO
- Add the inbound-announce token bucket field, initialized per-profile in the constructor.
- Gate the announce callback on the bucket before `mergeAnnounceSnapshot`; increment the rate-limited counter and return on rejection.
- Apply profile caps to successors, predecessors, and sample in `mergeAnnounceSnapshot`.
- Add `test/announce-rate-limit.spec.ts`: bucket exhaustion drops and increments the counter; edge capacity lower than core; caps enforced when a snapshot exceeds them (30/30/20 in → capped ingest); cap values match the neighbor-fetch merge.
- Type-check (`cd packages/fret && npx tsc --noEmit`) and `yarn test` pass.

References: fret-service.ts announce callback and `mergeAnnounceSnapshot` (~757-775); neighbors.ts inbound announce handler; the neighbor-fetch merge caps in `mergeNeighborSnapshots`. Review "Core service" major finding (announce path unbounded and unbucketed); threat-analysis.md §3.4.
