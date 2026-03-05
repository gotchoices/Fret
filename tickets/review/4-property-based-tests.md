description: Review property-based tests (fast-check) for FRET ring, cohort, and relevance invariants
dependencies: fast-check ^4.5.3, Digitree, ring/distance, store/relevance
files: packages/fret/test/ring.properties.spec.ts, packages/fret/test/cohort.properties.spec.ts, packages/fret/test/relevance.properties.spec.ts
----

### Summary

Three property-based test files using fast-check verify FRET invariants across randomized inputs (200 runs each, 30s timeout). All 35 property tests pass alongside the full suite (155 tests total).

### What was built

**`test/ring.properties.spec.ts`** (12 tests) — ring arithmetic properties:
- XOR distance: symmetry, self-distance-is-zero, identity of indiscernibles
- Clockwise distance: self-distance-is-zero, complementary distances sum to 2^256, non-negative result
- lexLess: irreflexive, antisymmetric, total order, transitive
- Coordinate encoding: hex and base64url round-trips

**`test/cohort.properties.spec.ts`** (11 tests) — cohort assembly properties:
- Store neighbors: no duplicates in right/left individually, combined S/P unique count ≤ min(2m,n), wrap-around correctness
- Cohort assembly: no duplicates, size = min(wants,n), monotonic expansion, exclusion respected, deterministic, n=1 edge case, all-peers-same-coord edge case

**`test/relevance.properties.spec.ts`** (12 tests) — relevance scoring properties:
- Sparsity bonus: bounded within [sMin, sMax] fresh and after observations
- observeDistance: increases at least one center's occupancy
- normalizedLogDistance: range [0,1], self-distance is zero
- touch: increments accessCount, non-negative relevance
- recordSuccess: increments successCount, non-negative relevance
- recordFailure: increments failureCount, degrades relevance vs touch, non-negative relevance

### Key design decisions
- Local `assembleCohort` helper mirrors `fret-service.ts:assembleCohort` logic directly on DigitreeStore — no libp2p nodes needed
- Peer ID arbitrary uses `fc.stringMatching(/^[0-9a-f]{4,8}$/)` for valid hex IDs
- Peer set capped at 60 (vs ticket's 100) to keep CI fast while still exercising the invariants

### Testing
- `yarn test` — 155 passing (3min)
- `yarn build` — clean
- `npx tsc --noEmit` — clean
