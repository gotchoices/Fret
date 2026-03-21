description: Per-peer token buckets on all inbound RPC handlers with violation tracking and temporary blocking
dependencies: 5-transport-identity-verification (need remotePeer from connection), 4-announce-inbound-rate-limiting (array caps)
files: src/utils/peer-rate-limiter.ts (new), src/service/fret-service.ts, docs/fret.md, test/per-peer-rate-limit.spec.ts (new)
----

### Overview

All token buckets are global per-node. A single attacker can exhaust any bucket in ~2 seconds, causing `BusyResponseV1` for all legitimate peers. This ticket adds per-peer rate limiting keyed by the transport-authenticated `connection.remotePeer` identity (provided by the transport-identity-verification prerequisite).

Closes threat-analysis.md §4.1 (High): Global rate limit exhaustion — single peer DoS.
Partially addresses §2.5 (Medium): Backoff exploitation via rate limit consumption.

### Architecture

```
Inbound RPC request
  │
  ├─ Is peer blocked? ──yes──► drop / BusyResponseV1
  │
  ├─ Per-peer bucket ──deny──► record violation, BusyResponseV1
  │        │                    (if violations ≥ threshold → block peer)
  │       allow
  │        │
  ├─ Global bucket ──deny──► BusyResponseV1 (as today)
  │        │
  │       allow
  │        │
  └─ Process request
```

Per-peer check happens first. If a single peer is rate-limited, only that peer sees `BusyResponseV1` — global tokens are not consumed. Global buckets remain as a secondary ceiling to bound total load regardless of peer count.

### `PeerRateLimiter` class (`src/utils/peer-rate-limiter.ts`)

```typescript
interface PeerRateLimiterConfig {
  perPeerCapacity: number;       // tokens per peer bucket
  perPeerRefillPerSec: number;   // refill rate per peer bucket
  maxTrackedPeers: number;       // LRU bound on tracked peers
  violationThreshold: number;    // violations before temporary block
  blockDurationMs: number;       // how long to block (default 60_000)
}

interface TrackedPeer {
  bucket: TokenBucket;
  lastAccess: number;
  violations: number;
  blockedUntil: number;          // 0 = not blocked
}
```

Public API:
- `tryTake(peerId: string, cost?: number): boolean` — lazily creates bucket; returns false if blocked or bucket exhausted. On denial, increments violations; if violations reach threshold, sets `blockedUntil`.
- `retryAfterMs(peerId: string, cost?: number): number` — returns ms until the peer's bucket can serve the request, or `blockDurationMs` remaining if blocked.
- `isBlocked(peerId: string): boolean` — true if `blockedUntil > Date.now()`.
- `prune(): void` — evicts entries not accessed within 2× blockDurationMs, then LRU-evicts down to `maxTrackedPeers`. Called periodically from stabilization tick.

Implementation notes:
- Uses a `Map<string, TrackedPeer>` with LRU eviction when exceeding `maxTrackedPeers`.
- `violations` reset to 0 when a successful `tryTake()` occurs (the peer is behaving again).
- Blocked peers have their `tryTake()` return false without consuming any bucket tokens.
- The class is protocol-agnostic and reusable — one instance per protocol in FretService.

### Profile-tuned per-peer rates

Per-peer capacity is a fraction of the global bucket, ensuring no single peer can monopolize more than ~25-33% of the node's total capacity.

| Protocol | Global (Core) | Per-Peer (Core) | Global (Edge) | Per-Peer (Edge) |
|---|---|---|---|---|
| neighbors | 20 / 10/s | 5 / 3/s | 8 / 4/s | 3 / 1.5/s |
| announceInbound | 20 / 10/s | 5 / 3/s | 8 / 3/s | 3 / 1/s |
| maybeAct | 32 / 16/s | 8 / 4/s | 8 / 4/s | 3 / 1.5/s |
| ping | 30 / 15/s | 8 / 4/s | 10 / 5/s | 4 / 2/s |
| leave | 20 / 10/s | 5 / 3/s | 8 / 4/s | 3 / 1.5/s |

Shared config across all protocol limiters:
- `maxTrackedPeers`: Core 512, Edge 128
- `violationThreshold`: 10 (consecutive per-protocol violations before block)
- `blockDurationMs`: 60_000 (1 minute)

### FretService integration

#### New fields

```typescript
private readonly peerLimitNeighbors: PeerRateLimiter;
private readonly peerLimitAnnounce: PeerRateLimiter;
private readonly peerLimitMaybeAct: PeerRateLimiter;
private readonly peerLimitPing: PeerRateLimiter;
private readonly peerLimitLeave: PeerRateLimiter;
```

Initialize in constructor with profile-tuned configs from the table above.

#### Handler changes

All handler methods gain a `remotePeer: string` parameter (threaded from `connection.remotePeer` via the transport-identity-verification work).

Pattern for each handler (example: `handleMaybeAct`):
```typescript
private async handleMaybeAct(
  msg: RouteAndMaybeActV1,
  remotePeer: string,      // added
): Promise<NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }> {
  // Per-peer check first
  if (!this.peerLimitMaybeAct.tryTake(remotePeer)) {
    this.diag.rejected.perPeerRateLimited++;
    return { v: 1, busy: true, retry_after_ms: this.peerLimitMaybeAct.retryAfterMs(remotePeer) };
  }
  // Global check second (existing)
  if (!this.bucketMaybeAct.tryTake()) { ... }
  // ... rest unchanged
}
```

Same pattern for `handleNeighborsRequest`, `handlePingRequest`, `handleLeave`, and the `onAnnounce` callback.

#### Periodic maintenance

Add `this.pruneAllPeerLimiters()` call in the stabilization tick (runs every Ts). This calls `.prune()` on each per-peer limiter to evict stale entries and keep memory bounded.

#### Diagnostics

Add to `diag.rejected`:
- `perPeerRateLimited: 0` — per-peer bucket denied
- `peerBlocked: 0` — temporarily blocked peer attempted request

### docs/fret.md update

In the "Not yet implemented" section, remove or update the "Per-peer rate limiting alongside global buckets; rate limit inbound announce handler" bullet. Add a brief note under "Current state" about per-peer rate limiting being in place.

### Test plan (`test/per-peer-rate-limit.spec.ts`)

**PeerRateLimiter unit tests:**
- `tryTake` creates bucket lazily, returns true up to capacity
- `tryTake` returns false after capacity exhausted for one peer
- Different peers have independent buckets
- Violations increment on denial; block triggers at threshold
- Blocked peer's `tryTake` returns false even after bucket refill
- Block expires after `blockDurationMs`
- Successful `tryTake` resets violation count
- `prune` evicts stale entries; respects `maxTrackedPeers`
- `retryAfterMs` returns correct value for exhausted vs blocked peers

**Integration with FretService:**
- Single peer exhausting per-peer bucket gets BusyResponseV1; other peers still served
- Per-peer denial does not consume global tokens
- Global bucket still applies as secondary ceiling
- Diagnostics: `perPeerRateLimited` and `peerBlocked` counters increment correctly
- Blocked peer cannot use any protocol (all limiters check independently)
- After block expires, peer can resume normal operation

**Profile differentiation:**
- Core per-peer capacity > Edge per-peer capacity
- Core maxTrackedPeers > Edge maxTrackedPeers

### TODO

Phase 1: PeerRateLimiter class
- [ ] Create `src/utils/peer-rate-limiter.ts` with `PeerRateLimiter` class per design above
- [ ] Export from `src/utils/` (or directly — no barrel needed)

Phase 2: FretService integration
- [ ] Add per-peer limiter fields to FretService, initialized per-profile in constructor
- [ ] Add `remotePeer` parameter to `handleNeighborsRequest`, `handlePingRequest`, `handleMaybeAct`, `handleLeave`, and the `onAnnounce` callback
- [ ] Add per-peer check before global check in each handler
- [ ] Add `perPeerRateLimited` and `peerBlocked` to `diag.rejected`
- [ ] Add `pruneAllPeerLimiters()` call in stabilization tick
- [ ] Wire `remotePeer` from RPC registration callbacks (relies on transport-identity-verification having threaded it)

Phase 3: Tests
- [ ] Create `test/per-peer-rate-limit.spec.ts` with unit and integration tests per plan above
- [ ] Verify existing tests pass (`yarn test`)
- [ ] Type-check passes (`cd packages/fret && npx tsc --noEmit`)

Phase 4: Documentation
- [ ] Update `docs/fret.md` — move per-peer rate limiting from "Not yet implemented" to "Current state"
