description: New peers are seeded with a ring-diverse sample of known peers, and each peer now folds neighbors' reported network-size estimates into its own size estimate.
files:
  - packages/fret/src/service/fret-service.ts (selectDiverseSample, calibrateSizeFromSnapshot, snapshot, mergeAnnounceSnapshot, mergeNeighborSnapshots)
  - packages/fret/src/store/relevance.ts (sparsityBonus, normalizedLogDistance)
  - packages/fret/test/seed-new-peers.spec.ts
  - docs/fret.md (Join and bootstrap; Network size estimation)
----

## Summary

Two improvements to new-peer seeding in FRET, implemented and now reviewed.

### 1. Sparsity-aware sample selection (`selectDiverseSample`)

`snapshot()` previously sampled the first 4 successors + first 4 predecessors, which both clustered the sample near the sender and was redundant with the snapshot's own `successors`/`predecessors` fields. It is replaced by an exported `selectDiverseSample(store, selfCoord, sparsity, excludeIds, cap)` that scores every store entry by `sparsityBonus(model, normalizedLogDistance(self, candidate))`, sorts by bonus descending, and returns the top `cap`. Self and S/P members are excluded.

### 2. Estimator calibration from received snapshots

When a `NeighborSnapshotV1` carries positive `size_estimate` and `confidence`, the receiver folds them into its local estimator via `reportNetworkSize(..., 'snapshot:<peerId>')`, on both the announce path (`mergeAnnounceSnapshot`) and the fetched-neighbor path (`mergeNeighborSnapshots`). Snapshots advertise the sender's *raw* FRET-local estimate, not its blended estimate, so this does not re-amplify already-blended values.

## Review findings

Reviewed the implement diff (`d896459`) with fresh eyes against the current tree, then the handoff summary.

**Checked — correctness.** `selectDiverseSample` exclusion, cap, descending sort, and empty-store handling all verified against the data structures (`DigitreeStore.list`, `sparsityBonus`). It reads but does not mutate the sparsity model — correct, since selection should not perturb occupancy (occupancy is maintained by `applyTouch`). The new path also removes a latent defect in the old code: missing entries used to be emitted as `{ coord: '', relevance: 0 }`, which a receiver would `u8FromString('')` into a zero-length coordinate; the new path never emits empty coords.

**Checked — calibration safety.** `reportNetworkSize` observations are bounded by a sliding time window and a max-count cap, so per-peer `snapshot:<id>` sources cannot grow unbounded. Confirmed no feedback amplification: `snapshot()` sends `estimateSizeAndConfidence(...).n` (raw local), not `getNetworkSizeEstimate()` (blended).

**Checked — type safety / style.** No `any`; signatures use `DigitreeStore`/`SparsityModel`/`Set<string>`. Imports present. Clean.

**Minor — fixed in this pass.**
- *DRY*: the 3-line calibration guard was duplicated verbatim in both merge paths. Extracted to a private `calibrateSizeFromSnapshot(snap, sourceId)` and called from both sites.
- *Weak test*: the test named "returns entries sorted by sparsity bonus descending" asserted only length and non-empty coords — it never checked sorting. Strengthened it to recompute each returned entry's bonus from its coord and assert monotonic non-increase.
- *Docs*: `docs/fret.md` "Join and bootstrap" still described the sample as "proximal nodes"; updated to describe sparsity-weighted selection and S/P exclusion. Added a "Network size estimation" bullet documenting peer-reported calibration (and the raw-vs-blended detail).

**Major — none.** No new fix/plan/backlog tickets filed.

**Tripwire (conditional — not a ticket).** `selectDiverseSample` scans + scores + sorts the entire store (bounded by capacity C, default 2048) on every snapshot build, versus the old O(8) selection. Fine at current scale. Recorded as a `NOTE:` comment at the function site: if C grows or snapshots become hot, switch to a bounded top-k heap (partial selection, no full sort).

**Security (already tracked — not a new ticket).** Snapshot-reported size estimates are unauthenticated; any peer can inject arbitrary `size_estimate`/`confidence`. This is the same exposure already captured by `tickets/backlog/plan/3-size-consensus-bounded-gossip` and threat-analysis.md §2.4. Noted in the docs bullet; no new ticket.

**Tests.** Full suite: `231 passing`, all 9 seed-new-peers tests green (including the strengthened sort assertion). `npx tsc --noEmit` clean. One unrelated failure — `message-bus.spec.ts` "Deterministic replay › two runs with same seed produce identical metrics" — times out under full-suite load against mocha's 2000ms default; it passes in isolation at ~1166ms (`--timeout 30000` → 20 passing). It is outside this ticket's diff (simulation harness) and flagged in `tickets/.pre-existing-error.md` for the runner's triage pass.
