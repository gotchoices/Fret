description: Two simulation tests now check that grouping peers into clusters really does change the network's shape and slow down message routing; the second one used to pass no matter what the answer was, and has been rewritten around a measurement that finally shows a difference.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/simulation/placement-assertions.ts, packages/fret/test/simulation/fret-sim.ts, packages/fret/test/churn-scenarios.spec.ts, docs/fret.md
difficulty: medium
---

Thirteen prior runs went into this; the last three produced no source edits, only measurement. What
finally landed is below, along with the three findings that explain why the earlier shapes of the
second test were abandoned — read those before questioning the design, because each one was
re-derived more than once.

## What shipped

Two tests in `test/message-bus.spec.ts`, under `describe('Placement distributions')`, plus a
supporting module and two small harness additions.

**Test 1 — `clustered placement: peers cluster around centers`** (unchanged this run; finished
earlier). Geometric: counts the most peers falling inside any one average-spacing arc of the ring.
Threshold `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC = 5`, asserted in **both** directions over all
five `PLACEMENT_SEEDS`, so the threshold's separating power is re-proved every run rather than
measured once. Latest run: clustered 13/12/15/17/12, uniform 1/1/1/1/1.

**Test 2 — `clustered placement: inter-cluster routing takes more hops`** (rewritten this run).
Behavioural: routes between real cluster centers and compares average hop count against a uniform
control routing between the *same two coordinates* under the *same* sender-selection rule. Measured
2026-08-21, all five seeds, every arm 10/10 successful with store size exactly 32:

| seed | clustered | uniform | margin |
|---|---|---|---|
| 8008 | 4.90 | 2.30 | 2.60 |
| 8009 | 5.00 | 2.60 | 2.40 |
| 8010 | 7.10 | 2.00 | 5.10 |
| 4242 | 4.80 | 2.00 | 2.80 |
| 99   | 6.70 | 3.10 | 3.60 |

Asserted per seed: `clustered > uniform + 1.5`, plus `attempts == 10`, `successes == 10`, and
`storeSize == 32` on **both** arms. Smallest observed margin is 2.40, so 1.5 sits 1.6x inside it.

The store-size assertion is not decoration — it is the guard against the exact failure this ticket
existed to fix (Finding A). If the bound stops biting, the test fails loudly instead of quietly
measuring one hop in both arms and passing.

Supporting code (all landed in earlier runs, all now consumed):
`test/simulation/placement-assertions.ts` exports `coordToBigInt`, `maxPeersInOneSpacingArc`,
`nearestAlivePeerTo`, `PLACEMENT_SEEDS = [8008, 8009, 8010, 4242, 99]`,
`MAX_PEERS_IN_ONE_SPACING_ARC = 7`; `CoordPlacement.centers` and
`FretSimulation.getClusterCenters()` expose the cluster centers. `nearestAlivePeerTo` and
`getClusterCenters` had no consumer until this run — test 2 is now it, so nothing in that set is
dead code any more.

`test/churn-scenarios.spec.ts` consumes `MAX_PEERS_IN_ONE_SPACING_ARC` for its own two placement
guards (batch-burst and steady-trickle joiners); unchanged this run, passing.

`docs/fret.md` gained a bullet under *Testing strategy -> Simulation* recording both guards, their
measured numbers, and the bounded-store precondition.

## Why the old test measured nothing — the three findings

These are the reviewer's context for why the obvious simpler designs were tried and abandoned.

**Finding A — the unbounded store made every route one hop.** `FretSimulation.handleRoute`
(`test/simulation/fret-sim.ts` L785-793) declares a route successful the moment the peer holding
the message is the target coordinate's anchor *in its own store*. At n=30 with `capacity` unset,
5 s of stabilization leaves every peer holding every other peer, so the originator's own store
already names the globally-nearest peer to any target: it delivers in one hop and that peer is the
anchor. The old test measured 0.9-1.0 average hops in *both* arms on *every* seed with 10/10
successes, and asserted `clustered > uniform` with no margin on a single hardcoded seed — it would
have passed or failed on floating-point noise. No target-generation scheme can fix this; the store
has to be bounded. `docs/fret.md` records the same degeneracy for the three unbounded routing cases
in `simulation.routing.spec.ts`.

**Finding B — a store bound is unreachable at n=30, which is why n is 300.**
`FretSimulation.enforceCapacity` (`fret-sim.ts` L701-721) mirrors production: eviction skips a
protection set and **protection outranks the cap**, so with `capacity < 2m + 1` the evictable set
runs out and the store simply stays over capacity. At m = 8 that floor is 17 — far above any
"small fraction of 30". So test 2 does not share test 1's n. At n = 300, `capacity: 32` is ~10.7%
of the population and is comfortably above the floor; it is also the same bounded regime
`simulation.routing.spec.ts` already measures (cap 32 at n=1000 -> 100% success, p90 7-8 hops).

**Finding C — the sweep that "timed out" was draining a config field nothing simulates.** An
earlier run's sweep pumped the scheduler all the way to `durationMs` (30 s, i.e. 60 stabilization
ticks over 300 peers) and blew its budget, which nearly got the whole test deleted as unmeasurable.
`simulation.routing.spec.ts` never does that: it pumps only to a fixed convergence time and its
doc-block records why — store contents measured flat from t=2000 through t=20000. Using that pump
(`pump(sim, uptoMs)`, inlined in the test) each sim costs ~11 s instead of minutes, and the whole
10-sim sweep runs in ~2 minutes. The "delete it because measuring is unaffordable" outcome is
therefore withdrawn; it was affordable all along.

## Validation

Both from `packages/fret/`:

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" "test/churn-scenarios.spec.ts" --timeout 300000
npx tsc --noEmit
```

**29 passing (3m), typecheck clean.** No pre-existing failures surfaced. Full `yarn test` was NOT
run this run — see gaps.

Console output is deliberately verbose (one line per seed per test) so a future reader who has to
re-tune a threshold can read the current numbers straight off a CI log rather than re-deriving
them.

## Use cases for the reviewer to poke at

- **Does the second test actually bite?** Set `capacity: undefined` in `cfgFor` — the store-size
  assertion should fail at 300, and if you also drop that assertion the hop counts should collapse
  to ~1.0 in both arms and the margin assertion should fail. That is the Finding A regression.
- **Is the control a real control?** The centers are drawn once from a `clustered` sim and reused
  by the `uniform` arm (`centersFor`), so both arms route between identical coordinates. Check that
  reuse survived the rewrite — deriving centers separately per arm would silently make the arms
  differ by more than placement.
- **Is 1.5 the right margin?** Smallest observed margin is 2.40. Argue it up or down; the numbers
  to argue against are in the table above and in the test's comment.
- **Runtime.** Test 2 takes ~121 s. It sets its own `this.timeout(300000)`, overriding the
  describe's 60 s. That is roughly 2.5x headroom on the measured time, on this machine.

## Known gaps — flagged, not papered over

- **Runtime is the main cost of this change.** `test/message-bus.spec.ts` went from a few seconds
  to ~130 s. That is a real tax on every full test run and a reviewer may reasonably want it cut —
  the honest levers are fewer seeds (say 3 of 5, halving the time and the evidence) or a smaller
  `ROUTES`. It was left at five seeds because the whole point of the rewrite was to stop asserting
  on one seed. Not filed as a ticket: it is a judgement call for the reviewer, not a defect.
- **Only the two spec files this ticket touches were run.** The full suite was not run this run
  (budget). The changed files are one test spec and a docs file, so the blast radius is that spec —
  but that is reasoning, not a green run.
- **`spreadBits` is pinned at 32 and the wider-cluster case was never measured.** The prior plan
  listed widening to ~224 as the fallback if 32 did not separate. It separated, so 224 was never
  run. Note `CoordPlacement.clusteredCoord` scales its Gaussian offset through a JS float, so it is
  exact only to ~52 bits — raising `spreadBits` past 52 in a shipped test needs that scaling moved
  into BigInt first. This is recorded at the code site already.
- **The test does not discriminate the cost function's slack constants**, and says so in its
  comment. The sim's near radius is `4k/store.size()` of maximum ring distance, so at k=15 over a
  32-entry store the fraction is 60/32 > 1 and clamps to half the ring, putting every candidate in
  the selector's *near* branch. What is discriminated is the distance metric and the placement.
  A reviewer should check the comment does not over-claim beyond that.
- **No property/generalized test was added**, only two point measurements over five fixed seeds.
  A generator over (n, capacity, numClusters, spreadBits) asserting the ordering would be the
  stronger guard. Not filed — the class has exactly two instances today and both are now covered;
  file it if a third placement guard appears.

## Tripwires

None recorded this run. The two conditional concerns that would have qualified — the `spreadBits`
~52-bit precision limit and the near-radius clamp — already have comments at their code sites
(`CoordPlacement.clusteredCoord`, `nearRadiusFor` in `fret-sim.ts`) from earlier runs, and are
restated in the test's own comment where a future reader will meet them.

## Hygiene

Scratch sweep script (`test/simulation/seed-check.tmp.ts`) was written and deleted this run; not in
the tree. No logs written. Working tree at handoff holds only `packages/fret/test/message-bus.spec.ts`
and `docs/fret.md`.
