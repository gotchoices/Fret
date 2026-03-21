description: Comprehensive size estimator accuracy evaluation on synthetic rings
dependencies: size-estimator.ts, digitree-store.ts, DeterministicRNG
files:
  - packages/fret/src/estimate/size-estimator.ts
  - packages/fret/src/store/digitree-store.ts
  - packages/fret/test/size-estimator.spec.ts
  - packages/fret/test/simulation/deterministic-rng.ts
----

### What was built

Expanded `size-estimator.spec.ts` from 1 test to 39 tests across 4 phases, exercising
`estimateSizeAndConfidence` against synthetic ring topologies without the full simulation harness.

### Coordinate generation helpers (in spec file)

- `uniformCoords(n)` — evenly spaced `i * (2^256 / n)`
- `gappedCoords(n, fraction)` — peers in 60% of the ring arc
- `skewedCoords(n, rng)` — exponential distribution (dense near origin)
- `randomUniformCoords(n, rng)` — random 32-byte coords via `DeterministicRNG`

### Phase 1: Parametric accuracy

Tests across N = {5, 10, 50, 100, 500, 1000, 5000} for each topology:
- **Uniform**: relative error < 5% — estimator is exact for evenly spaced peers
- **Random uniform**: relative error < 50% (N≥10) — median gap has significant variance with random placement
- **Gapped**: relative error < 70% — large empty arcs bias the median gap downward
- **Skewed**: relative error < 5x — estimator biased toward dense region; median gap is much smaller than true average

These tolerances document current estimator behavior and should tighten as the estimator improves.

### Phase 2: Partial-knowledge subsampling

From a 1000-peer uniform ring, insert only K contiguous peers (K = 8, 16, 32, 64):
- All estimates within 2x of actual N
- Confidence monotonically increases with K

### Phase 3: Confidence properties

- **Monotonicity**: incrementally adding peers to a uniform N=200 ring — confidence never drops (tracked from 2+ peers; single-peer sentinel 0.2 is a special case)
- **Edge cases**: empty (n=0, conf=0), single (n=1, conf=0.2), two peers (0 < conf < 1), all-same-coord (conf < 0.5)

### Phase 4: Convergence speed

For uniform N=500, confidence exceeds 0.5 before all peers are added.

### Key tests for review validation

- Uniform N=100: relative error < 5%, confidence > 0.5
- Random N=100: relative error < 50%
- Partial view K=16, N=1000: estimate between 500 and 2000
- Confidence monotonic over incremental insertion (2+ peers)
- Edge cases: 0, 1, 2 peers return correct sentinel values
- All 222 tests in the suite pass; build clean
