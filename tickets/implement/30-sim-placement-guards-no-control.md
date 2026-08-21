description: A simulation test claims that grouping peers into clusters makes message routing take more steps, but it would pass whether or not that were true; two earlier attempts to fix it were aimed at the wrong cause, and the setup the last attempt proposed has now been shown not to work either.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/simulation/placement-assertions.ts, packages/fret/test/simulation/placement.ts, packages/fret/test/simulation/fret-sim.ts, packages/fret/test/churn-scenarios.spec.ts, docs/fret.md
difficulty: medium
tradeoffs: n/a (implement ticket)
---

Tenth run in this chain. No code changed this run — it ended on the token budget partway through
building the measurement sweep. What it did produce is a finding that **invalidates the
configuration the previous ticket told you to measure**, so read both "finding" sections before
writing any code.

## What is already done — do not touch, do not re-measure

- **Step 1 (the first placement test) is finished.** `test/message-bus.spec.ts` L296-345,
  `clustered placement: peers cluster around centers`: threshold
  `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC = 5`, measured table in a comment, both directions
  asserted over `PLACEMENT_SEEDS`. Correct as it stands.
- **`test/churn-scenarios.spec.ts` is finished** (L3 imports `MAX_PEERS_IN_ONE_SPACING_ARC`,
  L369-395 asserts both arms).
- **`test/simulation/placement-assertions.ts` is finished** — exports `coordToBigInt`,
  `maxPeersInOneSpacingArc`, `PLACEMENT_SEEDS = [8008, 8009, 8010, 4242, 99]`,
  `MAX_PEERS_IN_ONE_SPACING_ARC = 7`.
- **`CoordPlacement.centers` (`test/simulation/placement.ts` ~L69) and
  `FretSimulation.getClusterCenters()` (`test/simulation/fret-sim.ts` ~L908) exist and typecheck.**
  They are the cluster-center exposure needed to aim a target at a real cluster. Nothing consumes
  them yet. The working tree at the start of this run held exactly these two modified files.

## Finding A (confirmed at the code site): every route is one hop, and why

The second test (`clustered placement: inter-cluster routing takes more hops`,
`test/message-bus.spec.ts` L347-395) measured 0.9-1.0 average hops in *both* arms on *every* seed
with 10/10 successes. That is not "the targets landed in the wrong place" — it is "there is nowhere
to route to". The mechanism is now confirmed rather than inferred:

`FretSimulation.handleRoute` (`test/simulation/fret-sim.ts` L785-793) declares a route successful
the moment the peer currently holding the message is the target coordinate's **anchor in its own
store** (`neighborsRight(target, 1)` / `neighborsLeft(target, 1)`, or the successor/predecessor of
the coordinate). At n=30 with `capacity` unset, 5 s of stabilization leaves every peer holding
every other peer, so the originator's own store already names the globally-nearest peer to any
target: it delivers one hop and that peer is the anchor. No target-generation scheme can produce a
multi-hop route against a store that already contains the destination's neighbours. This matches
`docs/fret.md` under *Testing strategy* ("unbounded stores plus a per-tick gossip merge ... arrive
in one or two hops under any roughly-monotone metric").

So the root cause is the unbounded store, and aiming targets at real cluster centers is necessary
but not sufficient.

## Finding B (new this run): a store bound is unreachable at n=30 — you must raise n

The previous ticket said to "pick a capacity that is a small fraction of the population here". That
does not work, and the reason is structural rather than a matter of tuning.
`FretSimulation.enforceCapacity` (`test/simulation/fret-sim.ts` L701-721) mirrors production:
eviction skips a protection set, and **protection outranks the cap** — its own comment states that
with `capacity < 2m + 1` the evictable set runs out and the store simply stays over capacity. At
m = 8 that floor is 17. Any capacity that is a "small fraction" of n = 30 (about 3-4) is far below
17, so setting it changes nothing at all: `store.size()` stays at the full population and the test
still measures one hop.

Consequence: the second test needs its own, larger `n`. It does not have to share n=30 with the
first test — they are independent tests. The working reference is
`test/simulation.routing.spec.ts`, which gets p90 7-8 hops from `capacity: 32` on a 1000-peer ring
(3.2%); 32 is comfortably above the 2m+1 = 17 floor. Something in the n = 200-400 range with
`capacity: 32` is the obvious first configuration to measure, and it keeps runtime in the same
class as the routing spec's existing 200-peer case.

Note the interaction already recorded at `nearRadiusFor` (`fret-sim.ts` ~L860): the near radius is
`4k/store.size()` of maximum ring distance, so at k=15 and a 32-entry store the fraction is
60/32 > 1 and clamps to half the ring, putting every candidate in the selector's *near* branch.
That is fine for a hop-count measure, but it means the test discriminates the distance metric and
the placement, not the cost function's slack constants — say so in the test comment rather than
letting a future reader over-claim.

## What this needs

Both arms together — either alone still measures nothing:

- **Bound the store, which means raising `n`** (see Finding B). Report `store.size()` for one
  sender per run; it is the number that tells you at a glance whether the bound actually bit.
- **Aim targets at real clusters**, using `sim.getClusterCenters()` (already landed). Keep it
  symmetric so the `uniform` arm is a genuine control rather than a different experiment: take the
  centers from the `clustered` run once, then for `i` in 0..9 use `A = centers[i % numClusters]`,
  `B = centers[(i + 1) % numClusters]`, and in **both** arms route from "the alive peer nearest
  `A`" to coordinate `B`. Same two coordinates in both runs, same selection rule, so the only
  difference is where the placement put the peers. The "alive peer nearest a coordinate" helper
  belongs in `test/simulation/placement-assertions.ts` beside `maxPeersInOneSpacingArc`, so the
  scratch measurement and the eventual spec share one implementation.

## The outcome that is allowed to be "no"

With `clusterConfig: { numClusters: 3, spreadBits: 32 }` the spread is 2^32 against a 2^256 ring —
about 1 part in 10^67. Three clusters are, for routing purposes, three *points*, and a ring made of
three points may simply not produce longer paths than a uniform one however the store is bounded,
because there is nothing between the clusters to route through. Widening `spreadBits` (say 200-240,
giving clusters of real width) is a legitimate thing to try before concluding.

If, after raising `n`, bounding `capacity`, aiming at real centers **and** trying a wider spread,
the two arms still do not separate cleanly across all five `PLACEMENT_SEEDS`, the honest resolution
is to **delete the second test**, not to loosen it. It currently asserts `clustered > uniform` with
no margin on a single hardcoded seed and would pass on noise; a deleted vacuous test is strictly
better than a retained one. The first test already covers clustered placement's real, measured
effect. Deleting is a result to report plainly in the handoff, with the numbers behind it — not a
failure.

## How to measure without rediscovering the workflow

Prior runs burned themselves on this. Write **one** scratch script that measures every variant in a
single process run, then delete it:

- File: `test/simulation/seed-check.tmp.ts` (relative imports work from there; `git status` on that
  directory must be clean before handoff).
- Run: `node --import ./register.mjs test/simulation/seed-check.tmp.ts` from `packages/fret/`.
- **Time one run first** at the chosen `n` before sweeping — a 5x2x2x2 sweep at n=400 is 40 sims,
  and the runner kills on a 10-minute idle. Print per-variant as you go so output keeps streaming.
- Sweep: all 5 `PLACEMENT_SEEDS` x {clustered, uniform} x {capacity 32, capacity unset as a sanity
  control} x {spreadBits 32, spreadBits ~224}. Print `avgRoutingHops`, the success count, and
  `store.size()` for one sender per run.
- Ship a numeric margin only if separation is clean and consistent across all five seeds.
  1-vs-0.9 is noise.

TODO:
- Write and run the sweep script above; record the table.
- If it separates: add the shared "alive peer nearest a coordinate" helper to
  `placement-assertions.ts`, rewrite `test/message-bus.spec.ts` L347-395 to use it plus the raised
  `n` and the store bound, assert both `clustered > uniform` **and** a measured numeric margin over
  all 5 `PLACEMENT_SEEDS`, with the measured table in a comment — mirroring the
  `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC` pattern the first test already uses.
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
  justified deleting), and Findings A and B above so the reviewer understands why the earlier
  target-generation and small-capacity plans were both abandoned. Delete this file once the review
  ticket is written.

## Hygiene

The working tree at handoff should hold `test/simulation/placement.ts` and
`test/simulation/fret-sim.ts` (both additive getters, already there), whatever this ticket's work
changes, and nothing else. No scratch files, no logs.
