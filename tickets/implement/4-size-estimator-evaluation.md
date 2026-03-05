description: Size estimator accuracy evaluation on synthetic rings
dependencies: size-estimator.ts, digitree-store.ts, DeterministicRNG
files:
  - packages/fret/src/estimate/size-estimator.ts
  - packages/fret/src/store/digitree-store.ts
  - packages/fret/test/size-estimator.spec.ts
  - packages/fret/test/simulation/deterministic-rng.ts
----

### Overview

Expand the existing minimal `size-estimator.spec.ts` into a comprehensive evaluation suite.
The estimator (`estimateSizeAndConfidence`) uses median arc-gap to estimate ring size from
a `DigitreeStore`'s known peers. Tests exercise it against synthetic topologies without
needing the full simulation harness — just populate a `DigitreeStore` directly.

### Coordinate generation helpers

Build a small helper (inside the spec file) that generates 32-byte ring coordinates for N
peers under various distributions. Use `DeterministicRNG` for reproducibility.

- **Uniform**: evenly spaced coords `i * (2^256 / n)` for `i in [0, n)`.
- **Gapped**: place peers only in a fraction of the ring (e.g., 60% arc), leaving a large empty gap.
- **Skewed/clustered**: exponential distribution — most peers near one point, thinning out.
- **Random uniform**: random 32-byte coordinates (simulates realistic peer ID hashing).

### Phase 1: Parametric accuracy tests

For each topology and a range of N values (5, 10, 50, 100, 500, 1000, 5000):

1. Populate a `DigitreeStore` with all N peers.
2. Call `estimateSizeAndConfidence(store, m)` with `m = 8`.
3. Assert `|n_est - N| / N` is within tolerance:
   - Uniform: < 0.05 (5%)
   - Random uniform: < 0.30 (30%) — more variance expected
   - Gapped: < 0.50 (50%) — median helps but gaps are hard
   - Skewed: < 0.60 (60%) — estimator is biased toward dense region

These are not strict pass/fail gates; the tolerances document the estimator's current
behavior and will tighten as the estimator improves. Use `expect(...).to.be.lessThan(...)`.

### Phase 2: Partial-knowledge (subsampling) tests

Simulate a single peer's partial view: from an N-peer uniform ring, insert only K peers
(a contiguous window of successors/predecessors around a reference point) into the store.

- For K = m, 2*m, 4*m, 8*m with N = 1000:
  - Assert n_est is within 2x of actual N (order-of-magnitude correct).
  - Assert confidence increases with K (monotonic with sample count).

### Phase 3: Confidence properties

1. **Monotonicity with sample size**: for a fixed uniform ring of N=200, incrementally add
   peers 1..N to a store and record confidence at each step. Assert confidence is
   non-decreasing (allowing ties but no drops).

2. **Edge cases**:
   - Empty store: n=0, confidence=0.
   - Single peer: n=1, confidence=0.2.
   - Two peers: confidence > 0 and < 1.
   - All peers at same coordinate: n_est should be capped, confidence low.

### Phase 4: Convergence speed

For a uniform ring of N=500, incrementally add peers and track when confidence first
exceeds 0.5. Assert this happens before adding all N peers (i.e., the estimator converges
before seeing the whole ring).

### Key tests for later review

- Uniform N=100: relative error < 5%, confidence > 0.5
- Random N=100: relative error < 30%
- Partial view K=16, N=1000: n_est between 100 and 10000
- Confidence monotonic over incremental insertion
- Edge case: 0, 1, 2 peers return correct sentinel values

### TODO

Phase 1:
- Add coordinate generation helpers (uniform, gapped, skewed, random) to spec file
- Add parametric accuracy tests for each topology across N values
- Verify existing test still passes

Phase 2:
- Add partial-knowledge subsampling tests
- Assert confidence monotonicity with sample count

Phase 3:
- Add confidence property tests (monotonicity, edge cases)

Phase 4:
- Add convergence speed test
- Run full test suite, ensure build passes
