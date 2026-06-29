description: Comprehensive size estimator accuracy evaluation on synthetic rings
files:
  - packages/fret/src/estimate/size-estimator.ts
  - packages/fret/src/store/digitree-store.ts
  - packages/fret/test/size-estimator.spec.ts
  - packages/fret/test/simulation/deterministic-rng.ts
----

### What was built

Expanded `size-estimator.spec.ts` from 1 test to 39 tests across 4 phases, exercising
`estimateSizeAndConfidence` against synthetic ring topologies (uniform, random-uniform,
gapped, skewed) without the full simulation harness. The estimator and store sources
were not modified — this is a pure test-expansion / characterization ticket.

- **Phase 1 — Parametric accuracy** across N = {5…5000} per topology, with tolerances
  that document current median-gap estimator behavior (uniform <5%, random <50%,
  gapped <70%, skewed <5×).
- **Phase 2 — Partial-knowledge subsampling** from a contiguous K-peer window.
- **Phase 3 — Confidence properties**: ordered-insertion monotonicity + edge cases
  (0/1/2 peers, all-same-coordinate).
- **Phase 4 — Convergence speed**: confidence crosses 0.5 before all peers seen.

## Review findings

**Scope.** Read the implement diff (`f59f26b`) first, then the estimator
(`size-estimator.ts`), the store (`digitree-store.ts` upsert/list/makeKey), and the RNG
helper. The diff touches only the test file; no production code changed.

**Correctness — verified by hand-tracing the estimator against each test:**
- *All-same-coordinate edge case* — confirmed genuine. `makeKey` is `coordHex|id`, so 10
  distinct IDs at one coordinate stay as 10 entries (they do NOT collapse). Traced:
  gaps = [0×9, ring] → medGap 0 → safeGap ring/10 → n=10, varianceFactor 0,
  confidence ≈ 0.31 < 0.5. Passes for the right reason.
- *Edge cases (0/1/2 peers), Phase 2 "confidence increases with K", Phase 3
  monotonicity* — each hand-traced through the estimator's `sizeFactor`/`varianceFactor`
  formula; all assert real properties of the current implementation, not tautologies.

**Tests run:** `tsc --noEmit` clean (serves as the lint gate — repo has no separate lint
script); full suite `232 passing` (grew past the ticket's stated "222" as sibling tickets
landed), spec alone `39 passing`. No regressions.

**Minor — fixed inline (this pass):** added two `NOTE:` tripwire comments at the exact
test sites so future readers don't over-read the coverage:
- Phase 2 subsamples a *uniform* ring only, so a contiguous window's median gap exactly
  equals the global step and the estimator returns ≈N exactly — the "within 2x" bound is
  slack and the realistic *non-uniform* partial-knowledge case is not yet exercised.
- The monotonicity test holds *only* because peers are inserted in ring order; confidence
  is not monotonic for arbitrary insertion order. The test asserts the ordered case, not a
  general property.

**Major:** none. No new tickets filed.

**Tripwires (conditional, parked as the NOTE comments above, not tickets):** the two
coverage caveats are knowledge for a future reader, and only become work *if* the
estimator gains topology-aware logic worth stress-testing — recorded at their code sites
rather than queued.

**Observations not actioned (out of scope):** `docs/fret.md` "Network size estimation"
describes a weighted average of arc-length *and* finger-sampling methods, but the shipped
estimator implements only the median-gap arc method. This is a pre-existing doc/impl gap,
not introduced here, and the estimator is explicitly slated to improve (loose tolerances
are placeholders) — left for the estimator-improvement work rather than churned now.
