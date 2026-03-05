description: Improve new-peer seeding with sparsity-aware sampling and estimator calibration
dependencies: FRET core (DigitreeStore, SparsityModel, size-estimator, neighbor snapshots)
files:
  - packages/fret/src/service/fret-service.ts (snapshot ~L789, mergeAnnounceSnapshot ~L590, mergeNeighborSnapshots ~L750)
  - packages/fret/src/store/relevance.ts (sparsityBonus, normalizedLogDistance)
  - packages/fret/src/store/digitree-store.ts (list, getById)
  - packages/fret/src/estimate/size-estimator.ts (estimateSizeAndConfidence)
  - packages/fret/src/index.ts (NeighborSnapshotV1 interface — already has sample/size_estimate/confidence)
----

The snapshot infrastructure (sample field, size_estimate, confidence, profile caps, merge logic) is already in place. Two gaps remain:

### 1. Sparsity-aware sample selection in `snapshot()`

Currently `snapshot()` (fret-service.ts ~L799) picks sample entries naively: first 4 successors + first 4 predecessors, deduped and capped. This clusters samples near self, providing poor ring diversity for the receiving peer.

**Change**: Replace naive selection with a sparsity-biased sampler that picks entries spread across diverse ring positions. The approach:

- Gather all entries from the Digitree (or a bounded subset like the top-N by relevance).
- Exclude self and entries already listed in successors/predecessors (they're redundant).
- Score each candidate by its sparsity bonus `sparsityBonus(model, normalizedLogDistance(selfCoord, candidateCoord))` — peers in sparser ring regions get higher scores.
- Sort by sparsity bonus descending, take top `capSample` entries.
- This reuses the existing SparsityModel infrastructure (relevance.ts) without new data structures.

Extract this into a small helper function `selectDiverseSample(store, selfCoord, sparsity, excludeIds, cap)` within fret-service.ts (or as a module-level function) to keep `snapshot()` clean.

### 2. Calibrate estimator from received snapshots

When `mergeAnnounceSnapshot()` or `mergeNeighborSnapshots()` processes a snapshot containing `size_estimate` and `confidence`, the receiving peer should feed those values into its network size estimator via `reportNetworkSize()`. This lets a brand-new peer immediately have a useful size estimate before it has enough local data.

**Change**: In both `mergeAnnounceSnapshot()` (~L590) and `mergeNeighborSnapshots()` (~L750), after merging entries, check if `snap.size_estimate` and `snap.confidence` are present and positive, and call `this.reportNetworkSize(snap.size_estimate, snap.confidence, 'snapshot:' + from)`.

### Profile caps (no change needed)

Export caps are already profile-bounded:
- Edge: succ ≤ 6, pred ≤ 6, sample ≤ 6
- Core: succ ≤ 12, pred ≤ 12, sample ≤ 8

Receive caps are also enforced:
- Edge: succ ≤ 8, pred ≤ 8, sample ≤ 6
- Core: succ ≤ 16, pred ≤ 16, sample ≤ 8

### Testing notes

- **Sparsity-aware sampling**: With 20+ peers inserted at known coordinates, the sample should contain entries from diverse ring regions, not just near-self neighbors. Compare ring-position variance of new sample vs. old naive sample.
- **Estimator calibration**: After merging a snapshot with `size_estimate=100, confidence=0.8`, `getNetworkSizeEstimate()` should reflect the externally reported size (especially when the local store is nearly empty).
- **Profile cap tests**: Existing tests in `profile.behavior.spec.ts` already cover export/receive caps — ensure they still pass.
- **Snapshot round-trip**: Verify that the sample entries have valid base64url coords and non-zero relevance scores.

## TODO

### Phase 1: Sparsity-aware sample selection
- Extract `selectDiverseSample(store, selfCoord, sparsity, excludeIds, cap)` helper
- Replace naive sample selection in `snapshot()` with the new helper
- Ensure existing profile cap tests still pass

### Phase 2: Estimator calibration from snapshots
- In `mergeAnnounceSnapshot()`, call `reportNetworkSize()` when snapshot has size_estimate + confidence
- In `mergeNeighborSnapshots()`, same treatment for each fetched snapshot
- Add guard: only calibrate if confidence > 0 and size_estimate > 0

### Phase 3: Tests
- Unit test for `selectDiverseSample` verifying ring-position diversity
- Test that merging a snapshot with size_estimate seeds the local estimator
- Run full test suite to verify no regressions
