----
description: The service's handling of unreachable peers — down-ranking on failed contact, distinguishing a brief hiccup from a real outage, giving up on a peer after repeated timeouts, and restoring a peer that comes back — has essentially no test coverage even though it is a core reliability contract.
prereq: dead-state-transition, relevance-scoring-tests
files: packages/fret/src/service/fret-service.ts, packages/fret/test
difficulty: medium
----
Nothing exercises the service's failure path: relevance decay on a failed ping, the soft-failure versus hard-failure distinction, dead-marking after repeated timeouts, or recovery reset on the peer's return — the doc's "Failure detection and recovery" contract. The failure-recording primitive is property-tested in isolation, but never through the live service.

What the tests should assert:
- A single failed ping decays the peer's relevance and schedules a backoff retry (soft failure), leaving the peer in the table.
- Repeated consecutive timeouts escalate to hard failure: the peer is removed from the neighbor sets and marked dead.
- On successful contact after a failure, the peer's relevance resets to baseline (recovery).

Approach: stubbed failing-ping unit tests for the state/relevance transitions, plus a two-node test where one peer becomes unreachable and the other's view is asserted to progress through the expected states.

This depends on the dead-marking behavior actually existing (see prereq); if three-strikes dead-marking is not implemented, that is a doc/code divergence to resolve first.

References: docs/fret.md — "Stabilization and churn handling" / "Failure detection and recovery". review.html:419-423 "Failure machinery untested".
