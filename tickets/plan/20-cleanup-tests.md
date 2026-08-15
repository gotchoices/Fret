----
description: Test housekeeping — the same multi-node setup is copy-pasted across many specs, a shared teardown helper corrupts the caller's list, two specs are now redundant, and the test readme is out of date.
files: packages/fret/test, packages/fret/test/helpers/libp2p.ts
difficulty: easy
----
Accumulated test-suite cleanup called out by the review:

- Mesh/star setup boilerplate is re-implemented in at least six specs; consolidate it into shared helpers.
- The shared stop-all teardown helper mutates the caller's array in place by reversing it, which can surprise callers that reuse the list; make it non-mutating.
- The standalone cohort-assembly spec and the connected-first selector spec are subsumed by stronger suites; fold their unique cases in and delete them.
- The test readme is stale (claims a fixed passing count and lists already-shipped features as future work); update it.

References: review.html:454-456 "Test housekeeping"; helpers/libp2p.ts:64 (stopAll reverse), cohort.assembly.spec.ts, selector.connected-first.spec.ts, test/README.md.
