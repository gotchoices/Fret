----
description: The service's handling of unreachable peers — down-ranking on failed contact, distinguishing a brief hiccup from a real outage, giving up on a peer after repeated timeouts, and restoring a peer that comes back — has essentially no test coverage even though it is a core reliability contract.
prereq: dead-state-exclusion-recovery, relevance-scoring-tests
files: packages/fret/src/service/fret-service.ts, packages/fret/test
difficulty: medium
----
Nothing exercises the service's failure path: relevance decay on a failed ping, the soft-failure versus hard-failure distinction, dead-marking after repeated timeouts, or recovery reset on the peer's return — the doc's "Failure detection and recovery" contract. The failure-recording primitive is property-tested in isolation, but never through the live service.

What the tests should assert:
- A single failed ping decays the peer's relevance and schedules a backoff retry (soft failure), leaving the peer in the table.
- Repeated consecutive timeouts escalate to hard failure: the peer is removed from the neighbor sets and marked dead.
- On successful contact after a failure, the peer is restored to a live state and its failure run is cleared (recovery).

Approach: stubbed failing-ping unit tests for the state/relevance transitions, plus a two-node test where one peer becomes unreachable and the other's view is asserted to progress through the expected states.

Note (added by the `dead-state-liveness-seam` review): the dead-marking behavior now exists, so the doc/code divergence this ticket warned about is resolved — but *two* of the assertions above were written from the old design-document prose and no longer describe the shipped behavior. Write them against the code, not against the prose:
- "Repeated consecutive timeouts" is too broad. Only a failure to *reach* the peer counts; a peer that answers and refuses to negotiate this network's protocol is membership evidence and never contributes a strike, and failures closer together than 500 ms count once.
- Relevance is deliberately **not** reset to a baseline on recovery — wiping the health counters would erase the record of a peer that flaps. Recovery clears the failure counter and restores the peer's state; the ordinary success scoring is what up-ranks it.
Both are already covered at the unit level in `packages/fret/test/dead-state.spec.ts`; what is still missing is the live-service and two-node coverage this ticket is for.

References: docs/fret.md — "Stabilization and churn handling" / "Failure detection and recovery". review.html:419-423 "Failure machinery untested".
