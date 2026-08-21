description: A simulation test claims that grouping peers into clusters makes message routing take more steps, but it would pass whether or not that were true; the previous attempt to fix it turned out to be aimed at the wrong cause, and the real cause is now identified but not yet fixed.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/simulation/placement-assertions.ts, packages/fret/test/simulation/placement.ts, packages/fret/test/simulation/fret-sim.ts, packages/fret/test/churn-scenarios.spec.ts, docs/fret.md
difficulty: medium
tradeoffs: n/a (implement ticket)
---

Ninth run in this chain. **Read this section before anything else — it overturns the plan the
previous eight runs were following.** Two small edits landed this run and typecheck clean; the
rest is a re-aimed plan, not a re-verification request.

## What is already done — do not touch, do not re-measure

- **Step 1 (the first placement test) is finished.** `test/message-bus.spec.ts` L293
  `describe('Placement distributions', ...)`, first test `clustered placement: peers cluster
  around centers` (L296-345): threshold `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC = 5`, measured
  table in a comment, both directions asserted in a loop over `PLACEMENT_SEEDS`. Correct.
- **`test/churn-scenarios.spec.ts` is finished** — verified present this run (L3 imports
  `MAX_PEERS_IN_ONE_SPACING_ARC`, L369-395 asserts both arms). Not reverted.
- **`test/simulation/placement-assertions.ts` is finished** — exports `coordToBigInt`,
  `maxPeersInOneSpacingArc`, `PLACEMENT_SEEDS = [8008, 8009, 8010, 4242, 99]`,
  `MAX_PEERS_IN_ONE_SPACING_ARC = 7`.
- **New this run:** `CoordPlacement.centers` getter (`test/simulation/placement.ts` ~L69) and
  `FretSimulation.getClusterCenters()` (`test/simulation/fret-sim.ts` ~L908). These are the
  "option 1" cluster-center exposure the previous ticket asked for. `npx tsc --noEmit` passes.
  Nothing consumes them yet.

## The finding that changes the plan

The previous ticket concluded that the second test
(`clustered placement: inter-cluster routing takes more hops`, `test/message-bus.spec.ts`
L347-395) fails to separate because its target coordinates are synthetic — hashed from `seed`,
with no idea where the cluster centers landed — so routes never reliably cross a cluster
boundary. It measured this across all five seeds and got, for both `clustered` and `uniform`:

```
seed 8008: clustered 1    | uniform 0.9      seed 4242: clustered 0.9 | uniform 0.9
seed 8009: clustered 0.9  | uniform 1        seed 99:   clustered 1   | uniform 0.9
seed 8010: clustered 1    | uniform 1
```

**Those numbers say something the previous ticket did not read out of them: every route is
completing in one hop or zero, in both arms, on every seed, with 10/10 successes.** That is not
"targets landed in the wrong place". That is "there is nowhere to route to" — the sender already
knows a peer adjacent to the target, so it hands the message over directly and the walk ends.

That is a documented property of this harness, not a surprise. `docs/fret.md`, under *Testing
strategy*, says of the routing spec's unbounded cases: "unbounded stores plus a per-tick gossip
merge of every neighbour's window leave each peer a large near-uniform slice of the ring (63% at
n=200, 19% at n=1000) over which greedy routing arrives in one or two hops under any
roughly-monotone metric". This test runs at **n=30 with no `capacity` set**, so that slice is
essentially the whole ring: after 5 s of stabilization every peer holds every other peer. No
target-generation scheme can produce a multi-hop route against a store that already contains the
destination's neighbours.

So aiming targets at real cluster centers is **necessary but not sufficient**, and it was never
the root cause. The root cause is the unbounded store.

## What this needs

Both arms, together — either alone still measures nothing:

- **Bound the store.** `SimConfig` already has `capacity?: number`
  (`test/simulation/fret-sim.ts` L83); `test/simulation.routing.spec.ts` uses `capacity: 32` on a
  1000-peer ring for exactly this reason (3.2% of the ring) and gets p90 7-8 hops out of it. Pick a
  capacity that is a small fraction of the population here, or raise `n`, or both. Note the
  interaction recorded at `FretSimulation.nearRadiusFor` (fret-sim.ts ~L860): the near radius is
  `4k/store.size()` of maximum ring distance, so a small store clamps every candidate into the
  selector's *near* branch. That is fine for a hop-count measure, but it means the test
  discriminates the distance metric and placement, not the cost function's slack constants — say so
  in the test comment rather than letting a future reader over-claim.
- **Aim targets at real clusters**, using `sim.getClusterCenters()` (already landed). Suggested
  shape, kept symmetric so the `uniform` arm is a genuine control rather than a different
  experiment: take the centers from the `clustered` run once, then for `i` in 0..9 use
  `A = centers[i % numClusters]`, `B = centers[(i + 1) % numClusters]`, and in **both** arms route
  from "the alive peer nearest `A`" to coordinate `B`. Same two coordinates in both runs, same
  selection rule, so the only difference is where the placement put the peers. A helper for this
  belongs in `test/simulation/placement-assertions.ts` beside `maxPeersInOneSpacingArc`, so a
  scratch measurement script and the eventual spec share one implementation.

## The outcome that is allowed to be "no"

Be prepared for this to still not separate, and do not force it if so. With
`clusterConfig: { numClusters: 3, spreadBits: 32 }`, the spread is 2^32 against a 2^256 ring —
about 1 part in 10^67. The three clusters are, for routing purposes, three *points*. A ring made of
three points may simply not produce longer paths than a uniform one no matter how the store is
bounded, because there is nothing between the clusters to route through. Widening `spreadBits`
(say to 200-240, giving clusters of real width) is a legitimate thing to try before concluding.

If, after bounding capacity **and** aiming at real centers **and** trying a wider spread, the two
arms still do not separate cleanly across all five `PLACEMENT_SEEDS`, then the honest resolution is
to **delete the second test**, not to loosen it. It currently asserts `clustered > uniform` with no
margin on a single hardcoded seed and would pass on noise; a deleted vacuous test is strictly
better than a retained one. The first test already covers clustered placement's real, measured
effect (peers pack into one spacing arc), which is the property that actually holds. Deleting is a
result to report plainly in the handoff, with the numbers behind it — not a failure.

## How to measure without rediscovering the workflow

Prior runs burned themselves on this. Write **one** scratch script that measures every variant in a
single process run, then delete it:

- File: `test/simulation/seed-check.tmp.ts` (relative imports work from there; `git status` on that
  directory must be clean before handoff).
- Run: `node --import ./register.mjs test/simulation/seed-check.tmp.ts` from `packages/fret/`.
- Sweep in one go: all 5 `PLACEMENT_SEEDS` x {clustered, uniform} x {capacity unset, capacity
  ~10-15% of n} x {spreadBits 32, spreadBits ~224}. Print `avgRoutingHops`, the success count, and
  `store.size()` for one sender per run — `store.size()` is the number that tells you at a glance
  whether the store bound actually bit.
- Ship a numeric margin only if separation is clean and consistent across all five seeds. 1-vs-0.9
  is noise, as established above.

TODO:
- Write and run the sweep script above; record the table.
- If it separates: add the shared target helper to `placement-assertions.ts`, rewrite
  `test/message-bus.spec.ts` L347-395 to use it plus a store bound, assert both
  `clustered > uniform` **and** a measured numeric margin over all 5 `PLACEMENT_SEEDS`, with the
  measured table in a comment — mirroring the `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC` pattern from
  the first test.
- If it does not separate: delete that test, and delete `CoordPlacement.centers` /
  `FretSimulation.getClusterCenters()` if nothing else consumes them.
- Delete the scratch script either way.
- Gate, both from `packages/fret/`:
  ```
  node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" "test/churn-scenarios.spec.ts" --timeout 60000
  npx tsc --noEmit
  ```
- Write the `review/` ticket (slug `sim-placement-guards-no-control`): the first test's measured
  threshold, what happened to the second test (fixed with numbers, or deleted with the numbers that
  justified deleting), and the one-hop finding above so the reviewer understands why the earlier
  target-generation plan was abandoned. Delete this file once the review ticket is written.

## Hygiene

Working tree at handoff holds exactly two modified files — `test/simulation/placement.ts` and
`test/simulation/fret-sim.ts`, both additive getters — plus this ticket rewrite. No scratch files,
no logs.
