description: Proactive neighbor announcements on topology change with profile-aware rate limiting
dependencies: FRET core (fret-service.ts, neighbors.ts, token-bucket.ts, digitree-store.ts)
----

## Context

Currently, proactive announcements exist in limited form:
- `proactiveAnnounceOnStart()` fires immediately on start (before stabilization has populated the table)
- `postBootstrapAnnounced` triggers once on first peer connection
- `handleLeave()` announces replacements on graceful departure
- `peer:disconnect` only marks state and applies failure — no announcement to remaining neighbors

Connected peers already learn about topology via normal snapshot exchange in the stabilization loop. The gap is that **non-connected** peers and **neighbors of departed peers** don't get notified promptly about topology changes, slowing convergence.

## Design

### 1. Dedicated announcement rate bucket (`bucketAnnounce`)

Add a profile-aware `TokenBucket` for outbound announcements in `FretService`:

| Profile | Capacity | Refill/sec |
|---------|----------|------------|
| Core    | 16       | 8          |
| Edge    | 6        | 2          |

All announcement sends (start, topology change, new discovery) must pass through this bucket before sending. This replaces the ad-hoc approach where announcements consume from `bucketNeighbors` or have no limit.

### 2. Bounded fanout per profile

| Profile | Max fanout per event |
|---------|---------------------|
| Core    | 8                   |
| Edge    | 4                   |

Apply in `announceNeighborsBounded` (and any new announce paths).

### 3. Non-connected peer filter

Change `announceNeighborsBounded` to prefer non-connected peers. Connected peers learn via normal exchange; announcements should target peers we know about but aren't connected to:

```
filter: !isConnected(id) && hasAddresses(id)
fallback: isConnected(id) (if no non-connected reachable peers exist)
```

### 4. Topology change triggers

#### 4a. Peer departure (ungraceful disconnect)

In the `peer:disconnect` handler, after marking the peer as disconnected and applying failure, check if the departed peer was a **near neighbor** (within S/P range). If so, trigger a bounded announcement to remaining neighbors around that coordinate — same pattern as `announceReplacementsToNeighbors` but for ungraceful departures.

Add debounce: track recent departure-triggered announcements to avoid storms when multiple peers disconnect in quick succession (e.g., 2s cooldown per coordinate region).

```typescript
// In peer:disconnect handler, after existing logic:
if (wasNearNeighbor(id, coord)) {
  void this.announceOnDeparture(coord);
}
```

New private method `announceOnDeparture(coord)`:
- Check `bucketAnnounce`
- Get S/P neighbors around coord (excluding self and departed)
- Filter to non-connected peers with addresses (fallback to connected)
- Slice to profile fanout limit
- Send snapshot via existing `announceNeighbors()` RPC

#### 4b. New peer discovery

When `mergeAnnounceSnapshot` or `mergeNeighborSnapshots` discovers new peers (the `discovered` array is non-empty), announce self to a bounded subset of the newly discovered non-connected peers.

```typescript
// At end of mergeAnnounceSnapshot / mergeNeighborSnapshots, after emitDiscovered:
if (discovered.length > 0) {
  void this.announceToNewPeers(discovered);
}
```

New private method `announceToNewPeers(ids)`:
- Check `bucketAnnounce`
- Filter to non-connected peers with addresses
- Slice to min(profile fanout, ids.length)
- Send snapshot via existing `announceNeighbors()` RPC

### 5. Improve on-start announce timing

Delay `proactiveAnnounceOnStart` to fire after the first stabilization tick completes (or on first peer connection, whichever comes first). Currently it fires before any stabilization, so the snapshot may be nearly empty and useless.

Keep the existing `postBootstrapAnnounced` one-shot as a safety net.

### 6. Diagnostics

Add to `diag`:
- `announcementsSkipped`: incremented when `bucketAnnounce` rejects
- Update existing `announcementsSent` counter consistently across all paths

## Key Files

- `packages/fret/src/service/fret-service.ts` — primary changes (rate bucket, triggers, methods)
- `packages/fret/src/utils/token-bucket.ts` — existing, no changes needed
- `packages/fret/src/rpc/neighbors.ts` — existing announce RPC, no changes needed
- `packages/fret/src/rpc/protocols.ts` — existing protocol, no changes needed

## Testing

- Unit test: `bucketAnnounce` rate limiting — verify announcements are throttled per profile
- Integration test: peer disconnect triggers announcement to remaining neighbors
- Integration test: new peer discovery triggers announcement to discovered peers
- Integration test: on-start announce fires after stabilization, not before
- Integration test: fanout bounded by profile (edge sends fewer than core)

Test file: `packages/fret/test/proactive-announce.spec.ts`

## TODO

### Phase 1: Rate limiting and fanout
- Add `bucketAnnounce` token bucket in constructor with profile rates
- Add `announcementsSkipped` to diagnostics
- Update `announceNeighborsBounded` to use `bucketAnnounce` and respect profile fanout
- Update non-connected filter in `announceNeighborsBounded`

### Phase 2: Topology change triggers
- Add `announceOnDeparture(coord)` method with debounce
- Wire `peer:disconnect` handler to call `announceOnDeparture` for near neighbors
- Add `announceToNewPeers(ids)` method
- Wire `mergeAnnounceSnapshot` and `mergeNeighborSnapshots` to call `announceToNewPeers`

### Phase 3: On-start timing
- Defer `proactiveAnnounceOnStart` to after first stabilization tick
- Keep `postBootstrapAnnounced` as fallback

### Phase 4: Tests
- Write `proactive-announce.spec.ts` covering rate limiting, departure triggers, discovery triggers, fanout bounds, and on-start timing
