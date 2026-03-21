description: Sparsity-aware sample selection and estimator calibration from snapshots
dependencies: FRET core (DigitreeStore, SparsityModel, size-estimator, neighbor snapshots)
files:
  - packages/fret/src/service/fret-service.ts (selectDiverseSample helper ~L53, snapshot ~L817, mergeAnnounceSnapshot ~L627, mergeNeighborSnapshots ~L812)
  - packages/fret/src/store/relevance.ts (sparsityBonus, normalizedLogDistance)
  - packages/fret/test/seed-new-peers.spec.ts
----

## Summary

Two improvements to new-peer seeding in FRET:

### 1. Sparsity-aware sample selection (`selectDiverseSample`)

Replaced the naive sample selection in `snapshot()` (which took first 4 successors + first 4 predecessors, clustering samples near self) with a sparsity-biased sampler:

- New exported function `selectDiverseSample(store, selfCoord, sparsity, excludeIds, cap)` in `fret-service.ts`
- Gathers all entries from the Digitree, excludes self and S/P members (redundant)
- Scores each candidate by `sparsityBonus(model, normalizedLogDistance(selfCoord, candidateCoord))`
- Sorts by sparsity bonus descending, takes top `cap` entries
- Returns entries with base64url-encoded coords and relevance scores

### 2. Estimator calibration from received snapshots

When processing snapshots containing `size_estimate` and `confidence`, the receiving peer now feeds those values into its network size estimator:

- In `mergeAnnounceSnapshot()`: calls `reportNetworkSize(snap.size_estimate, snap.confidence, 'snapshot:' + from)` when both values are present and positive
- In `mergeNeighborSnapshots()`: same treatment for each fetched snapshot
- Guarded: only calibrates if `confidence > 0` and `size_estimate > 0`

### No changes needed

Profile caps (export and receive) remain unchanged and enforced as before.

## Testing / validation

9 new tests in `test/seed-new-peers.spec.ts`:

**selectDiverseSample (6 tests):**
- Returns entries sorted by sparsity bonus
- Excludes specified peer IDs
- Respects cap parameter
- Returns empty when all entries excluded
- Prefers entries in sparse ring regions over dense ones (key behavioral test)
- Sample entries have valid base64url coords

**Estimator calibration (3 tests):**
- `mergeAnnounceSnapshot` feeds `size_estimate` into local estimator
- Does not calibrate when `size_estimate` or `confidence` is zero/missing
- `reportNetworkSize` reflects externally reported size on near-empty store

Full test suite: 163 passing (2 pre-existing failures in proactive-announce stream teardown, unrelated).

## Usage

No API changes. The improvements are internal:
- Snapshots sent to new peers now contain ring-diverse sample entries
- New peers receiving snapshots immediately calibrate their size estimator
