description: The real networking code that finds a peer and delivers work to it is only ever exercised with three nodes; there is no test that runs a few dozen real instances talking to each other, so bugs that only appear at that size would ship unnoticed.
files: packages/fret/test/helpers/libp2p.ts, packages/fret/test/route.maybeact.integration.spec.ts, packages/fret/test/fret.mesh.spec.ts, packages/fret/test/iterative-lookup.spec.ts, packages/fret/src/service/fret-service.ts
tradeoffs: A few dozen real libp2p nodes per test case is slow and prone to timing flakiness, and the deterministic simulator already covers ring maintenance — a maintainer could reasonably say the three-node integration tests plus the simulator are enough and spend the budget elsewhere.
----

Split out while planning `15.5-sim-router-realism`, which makes the deterministic simulator route
through the shipped next-hop selector. That closes the "the simulator cannot detect a broken
distance metric" gap, but it closes it against the simulator's own simplified peers — the
simulator holds no `FretService` instances and speaks no wire protocol.

The production paths that carry a real lookup end to end — `iterativeLookup`, `routeAct`'s
forward-and-answer flow, and the heuristic that decides whether to attach the payload to a
message or send a digest-only probe first — are exercised today only by small integration tests,
typically three nodes over the in-memory transport. Three nodes is below the size at which any of
those paths does anything interesting: a lookup completes in one hop, no message is ever
forwarded by an intermediate node, and the payload heuristic's distance-versus-cluster-span
comparison is never near its threshold.

### What would close it

A middle tier between the three-node integration tests and the deterministic simulator: on the
order of 15–30 real `FretService` instances on in-memory libp2p nodes, allowed to converge, then
driven with real lookups and real activity-bearing messages. What it would measure that nothing
measures now:

- lookups that genuinely traverse intermediate nodes (hop counts > 1, and the breadcrumb/TTL
  guards actually doing something),
- the payload-inclusion decision landing on both sides of its threshold in one run,
- the two-phase probe-then-resend flow completing against a *remote* anchor rather than against
  the originator itself,
- membership classification and dialability filtering under a population large enough that some
  peers are known only through gossip.

### Why it is not part of `15.5-sim-router-realism`

Different subsystem, different failure modes, and a very different cost profile. The simulator
work is a single-file deterministic change; this is a new harness with real async lifecycles,
real timeouts, and a wall-clock budget that has to stay well inside the test suite's limits. The
open question a human should weigh before it is promoted is whether the run time and flakiness
risk are worth it, or whether the coverage is better bought by extending the deterministic
simulator further toward the production service.
