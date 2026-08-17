----
description: Test housekeeping — the same multi-node setup and the same ring-coordinate arithmetic are copy-pasted across many specs, a shared teardown helper corrupts the caller's list, two specs are now redundant, and the test readme is out of date.
files: packages/fret/test, packages/fret/test/helpers/libp2p.ts, packages/fret/test/helpers/ring.ts
difficulty: easy
----
Accumulated test-suite cleanup called out by the review:

- Mesh/star setup boilerplate is re-implemented in at least six specs; consolidate it into shared helpers.
- The shared stop-all teardown helper mutates the caller's array in place by reversing it, which can surprise callers that reuse the list; make it non-mutating.
- The standalone cohort-assembly spec and the connected-first selector spec are subsumed by stronger suites; fold their unique cases in and delete them.
- The test readme is stale (claims a fixed passing count and lists already-shipped features as future work); update it.
  - Measured during the `failure-recovery-tests` review: it says "67 passing" against an actual 693,
    its coverage index names about 15 of the ~50 spec files (none added in the last several months),
    and its "Fixes Applied" section cites source line numbers that have long since moved. Decide the
    *shape* before rewriting: a hand-maintained index of every spec is what went stale, whereas the
    pattern that has stayed current is the one `docs/fret.md` uses — describe the behavior and name
    the spec that pins it, inline, at the place the behavior is described. Deleting the readme in
    favour of that is a legitimate outcome of this arm.
- Ring-coordinate arithmetic is hand-rolled once per spec. `test/helpers/ring.ts` now exists and
  owns two of these (`ringOffset`, `toBigInt`), but the conversion from a bigint to a 32-byte
  coordinate is still written out five separate times under four different names, and one of
  those sites duplicates the offset helper outright. Move them all into the shared helper.
  Sites: `pick-anchors.spec.ts:51` (`shiftCoord` — same operation as `ringOffset`, only with a
  bigint delta instead of a number; unifying the two means widening the helper's parameter type),
  `ring.properties.spec.ts:46` (`toCoord`), `size-estimator.spec.ts:11` (`bigIntToCoord`),
  `simulation/fret-sim.ts:683` (`bigintToCoord`), `seed-new-peers.spec.ts:334` (written inline).
  Why it matters beyond tidiness: a spec that hand-rolls this arithmetic and gets it subtly wrong
  does not fail loudly — it quietly seeds peers somewhere other than where the spec's own comments
  say they are, which is exactly how the `dialability-spec-self-position-premise` flake happened.
  The five sites above are all correct today, so this is prevention, not a bug fix.

- **The consolidated setup helper must own teardown too, and teardown must survive a failed
  assertion.** Today most multi-node specs stop their nodes on the *last line of the test body*,
  outside any `try`/`finally` and outside an `afterEach`. A failing assertion therefore skips the
  teardown entirely: the libp2p nodes and their stabilization timers stay live, and the mocha exit
  watchdog fails the run a second time with an open-handle dump that buries the assertion message
  the developer actually needs. Several also teardown via `await Promise.all(services.map(s =>
  s.stop()))`, where one rejecting stop strands every other service and the nodes underneath them.
  Measured by grepping for spec files that call `stopAll` with no `afterEach` anywhere in the file:
  `maybeact-dedup-phases.spec.ts` (7 teardown sites), `proactive-announce.spec.ts` (5),
  `network.isolation.spec.ts` (3), `route.maybeact.integration.spec.ts` (2), plus
  `profile.behavior.spec.ts`. The `lookup-profile-test-assertions` review fixed the three cases in
  `iterative-lookup.spec.ts` and the one in `fret.mesh.spec.ts` by hand; the point of this arm is
  that a shared `withMesh(n, fn)`-shaped helper makes the leak *unwritable* rather than fixed once
  per spec. Prefer that shape over asking each spec to remember a `finally`.

- **The simulation harness has outgrown one file and one class.** Measured after the
  `sim-partition-merge-tests` review: `packages/fret/test/simulation/fret-sim.ts` is 889 lines
  (`(Get-Content -LiteralPath packages\fret\test\simulation\fret-sim.ts).Count`), all of it one
  `FretSimulation` class that owns coordinate placement, event scheduling and dispatch, the
  stabilization tick, the partition/reachability model, contact-failure escalation and dead-entry
  re-probe, a routing model, and the coverage/dead-ratio metrics. The natural seams are visible
  in the code already — placement (`generateCoord` and its three strategies plus `bigintToCoord`,
  which the coordinate-arithmetic arm above also wants moved), the reachability model
  (`partition`/`heal`/`reachable`/`contactAllowed`), the liveness model (`contactSweep` /
  `reprobeDeadEntries`), and the measurement functions (`snapshotCoverage`,
  `deadNeighborRatio`). This is prevention rather than a bug: the file is correct today, but two
  planned tickets (`24-sim-router-realism`, and the simulator-invariants doc in `backlog/plan/`)
  both edit it next, and both would land cleaner against separated modules. Sequence this arm
  *before* `24-sim-router-realism` or accept that it rewrites the routing seam first.

References: review.html:454-456 "Test housekeeping"; helpers/libp2p.ts:64 (stopAll reverse), cohort.assembly.spec.ts, selector.connected-first.spec.ts, test/README.md. Coordinate-arithmetic arm added by the `dialability-spec-self-position-premise` review; harness-size arm added by the `sim-partition-merge-tests` review.
