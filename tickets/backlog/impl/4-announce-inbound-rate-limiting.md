description: Add rate limiting and array caps to inbound announce handler (closes §3.4 gap)
dependencies: none — standalone fix
files: src/service/fret-service.ts, src/rpc/neighbors.ts, test/announce-rate-limit.spec.ts (new)
----

### Overview

The inbound announce handler (`neighbors.ts:34`) has zero rate limiting. The `bucketNeighbors` guards outbound snapshot responses and `bucketAnnounce` limits outbound announcements — neither limits inbound announce processing. Additionally, `mergeAnnounceSnapshot` processes all successor/predecessor/sample entries without the profile-bounded caps that `mergeNeighborSnapshots` applies.

This ticket adds:
1. A global inbound announce token bucket checked before `mergeAnnounceSnapshot`
2. Profile-bounded array caps in `mergeAnnounceSnapshot` matching the caps already used in `mergeNeighborSnapshots`

Closes threat-analysis.md §3.4 (High): No rate limit on inbound announcements.

### Design

#### Inbound announce rate limiting

Add `bucketAnnounceInbound` to FretService, configured per-profile:
- Core: capacity 20, refill 10/s (matches `bucketNeighbors` — announce is similarly costly)
- Edge: capacity 8, refill 3/s

Check in the `onAnnounce` callback (fret-service.ts ~line 301) before calling `mergeAnnounceSnapshot`. On rejection, increment `diag.rejected.rateLimited` and return without processing.

#### Array caps in `mergeAnnounceSnapshot`

Currently (line 633):
```typescript
for (const pid of [...(snap.successors ?? []), ...(snap.predecessors ?? [])]) {
```

Change to slice with profile caps before iterating, matching `mergeNeighborSnapshots` (line 788-802):
```typescript
const capSucc = this.cfg.profile === 'core' ? 16 : 8;
const capPred = this.cfg.profile === 'core' ? 16 : 8;
const capSample = this.cfg.profile === 'core' ? 8 : 6;
const succList = (snap.successors ?? []).slice(0, capSucc);
const predList = (snap.predecessors ?? []).slice(0, capPred);
for (const pid of [...succList, ...predList]) {
```

And for sample (line 644):
```typescript
for (const s of (snap.sample ?? []).slice(0, capSample)) {
```

### Test plan (`test/announce-rate-limit.spec.ts`)

**Announce inbound rate limiting — bucket exhaustion:**
- Create a FretService (core profile)
- Drain `bucketAnnounceInbound` by calling the announce handler rapidly
- Verify that once exhausted, subsequent announces are rejected (not merged)
- Verify `diag.rejected.rateLimited` increments

**Announce inbound rate limiting — edge profile lower capacity:**
- Create a FretService (edge profile)
- Verify edge capacity is lower than core (8 vs 20)

**Array caps applied in mergeAnnounceSnapshot:**
- Create a FretService
- Call `mergeAnnounceSnapshot` with a snapshot containing 30 successors, 30 predecessors, 20 sample entries
- Verify the store only ingested entries up to the profile cap (not all 30+30+20)

**Array caps match mergeNeighborSnapshots:**
- Core: capSucc=16, capPred=16, capSample=8
- Edge: capSucc=8, capPred=8, capSample=6

### TODO

- [ ] Add `bucketAnnounceInbound` field to FretService, initialized per-profile in constructor
- [ ] Add rate limit check in the `onAnnounce` callback (~line 301) before calling `mergeAnnounceSnapshot`
- [ ] Add profile-bounded array caps to `mergeAnnounceSnapshot` for successors, predecessors, and sample
- [ ] Create `test/announce-rate-limit.spec.ts` with tests per plan above
- [ ] Verify existing tests pass (`yarn test`)
- [ ] Type-check passes (`cd packages/fret && npx tsc --noEmit`)
