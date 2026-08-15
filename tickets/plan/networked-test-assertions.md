----
description: Several multi-node tests pass without proving anything meaningful — they check trivially-true conditions, allow any of several outcomes, or compute a result and never assert on it — so real regressions in those paths would go unnoticed.
files: packages/fret/test/churn.leave.spec.ts, packages/fret/test/iterative-lookup.spec.ts, packages/fret/test/proactive-announce.spec.ts, packages/fret/test/profile.behavior.spec.ts, packages/fret/test/fret.mesh.spec.ts
difficulty: medium
----
A meaningful fraction of the networked tests assert monotone counters (a value greater-or-equal to a prior read, which is trivially true), mere property existence, or "any of three outcomes." Some compute a value and never assert on it (the leftover-leaving check, the total-skipped count). The dedup integration test never proves the second call actually hit the cache. The preconnect-budget tests are tautological because they run against an empty store.

Strengthen each to assert the actual effect:
- Leave handling: the departing peer is removed from the recipient's table.
- Activity handler: invoked exactly once, not merely at least once.
- Bucket skip: the skip counter increments by the expected amount.
- Preconnect budget: with a store seeded past the budget, the ping count saturates at the budget rather than being trivially satisfied by an empty store.
- Dedup: the second identical call is served from cache (assert cache hit / no re-processing), not just that it returns.

References: review.html:431-435 "Weak assertions in networked tests" (churn.leave ~96-136, iterative-lookup ~51-157, proactive-announce ~134-174, profile.behavior ~359-382, fret.mesh ~47).
