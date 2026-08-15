----
description: Around ten tests wait by sleeping a fixed several seconds and then asserting the work must be done, which both wastes real time on every run and fails intermittently when a slow machine misses the deadline; a shared condition-based wait would fix both.
files: packages/fret/test/helpers, packages/fret/test
difficulty: easy
----
Multiple specs sleep a fixed duration — up to six seconds — on the real timer and then assert "should have resolved by now." Under CI load a missed tick fails a passing test, and even successful runs burn the full sleep every time. One membership spec already demonstrates the correct pattern: a condition-based wait that polls a predicate and returns as soon as it holds.

Approach:
- Extract a reusable wait-for-condition helper into the test helpers directory (predicate, timeout, poll interval).
- Replace the fixed sleeps across the affected specs with predicate waits keyed on the actual observable state.

References: review.html:437-441 "Fixed multi-second sleeps"; ring-membership.spec.ts:431/459/540, libp2p-memory.integration.spec.ts:104/132; existing pattern at membership-identify.spec.ts:29.

Additional arm (found during the `membership-classification-strength` review): `ring-membership.spec.ts`
now carries its own private copy of the same predicate-wait (`waitFor`, around line 425), a near-duplicate
of the one in `membership-identify.spec.ts`. The fixed sleeps that spec used to have are already gone —
converted to predicate waits by that ticket — so the remaining work there is purely the de-duplication:
fold both copies into the shared helper this ticket creates. One behavioural detail worth carrying into
the shared version: neither copy throws when the predicate never holds, so a spec chaining three waits
can silently consume its whole mocha budget and report an opaque timeout instead of the assertion that
follows the wait. The shared helper should either throw with the caller's label or keep a default timeout
small enough that several chained waits still fit inside a test's budget.
