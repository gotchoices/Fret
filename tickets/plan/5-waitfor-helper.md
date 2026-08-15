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
