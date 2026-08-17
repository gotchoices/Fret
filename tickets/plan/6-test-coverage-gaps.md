----
description: Several documented behaviors have no tests at all — saving and restoring the routing table, the rate limiter actually refilling over time, healing after a network split, client behavior when a peer stalls mid-response — and one property test checks a private copy of the cohort logic that can silently drift from the real one.
files: packages/fret/test, packages/fret/src/service/fret-service.ts, packages/fret/src/utils/token-bucket.ts, packages/fret/test/simulation/fret-sim.ts, packages/fret/test/cohort.properties.spec.ts
difficulty: medium
----
Named coverage gaps from the review:

- Table persistence: exporting and re-importing the routing table is untested. **The capacity arm of this — "importing a table larger than capacity evicts the lowest-relevance entries" — now belongs to `relevance-scoring-tests`**, which owns eviction victim selection end to end (neighbor protection, dead/foreign/unknown exclusion, tie handling) in a new `test/relevance.eviction.spec.ts`. What is left here is round-trip *fidelity*: that every field survives export → import unchanged, that older snapshots missing newer fields read back with the documented defaults, and that a malformed coordinate rejects the whole snapshot without writing anything. Do not re-derive the capacity assertions.
- Token bucket refill: only the configured rate is echoed back; the actual refill-over-time behavior is never exercised. This needs an injectable clock so time can be advanced deterministically.
- Partition/merge: no scenario splits the network and rejoins it, despite the doc's testing strategy naming it. The simulation message bus can already model link cuts, so this is buildable today.
- Stream errors: no client-side tests for a peer that aborts mid-stream or goes unresponsive partway through a response.
- Mirrored cohort logic: the cohort property test runs against a local reimplementation of the cohort-assembly algorithm, which can drift from production without failing. Point the property test at the real exported function instead.

References: review.html:443-446 "Gaps: service-level persistence, token refill, partition/merge, stream errors, mirrored cohort". docs/fret.md — "Routing table persistence", "Cohort assembly algorithm", "Testing strategy".
