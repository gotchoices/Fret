----
description: The routing table's peer-quality scoring and its choice of which peer to drop when full are barely tested, so a regression in ranking or eviction could silently corrupt routing without any test noticing.
files: packages/fret/src/store/relevance.ts, packages/fret/src/store/digitree-store.ts, packages/fret/test
----
Relevance scoring drives both routing preference and eviction victim selection, yet only fragments are covered today. This partially addresses review findings T1 (failure-driven score decay) and T5 (fill-to-capacity victim selection).

What the tests should assert:
- Failures and timeouts down-rank a peer's score; consistent successful access up-ranks it (monotonicity under a fixed access pattern).
- Neighbor set members (successors/predecessors) carry effectively infinite eviction weight and are never chosen as victims unless explicitly dead.
- Decay is bounded: scores never go negative or overflow.
- The sparsity bonus favors under-represented ring-distance bands over over-represented ones.
- When the table exceeds capacity, eviction removes the lowest-scoring entry, not a neighbor.

Approach: unit tests over the score calculation across input combinations, property tests for score monotonicity, and an integration test that fills the table past capacity and verifies the correct victim is evicted.

References: docs/fret.md — "Relevance scoring and table management" and "Relevance score calculation (bucketless sparsity model)". review.html:417 (property coverage strengths), findings T1/T5.
