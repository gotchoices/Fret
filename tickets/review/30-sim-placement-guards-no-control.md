description: A simulation test that checks whether grouping peers into clusters makes messages travel farther now takes so long it trips the test framework's five-minute limit and reports as failing, even though every measurement it makes is correct. The test needs to be made faster, and a few smaller clean-ups from the same review still need doing.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/simulation/placement-assertions.ts, packages/fret/test/simulation.routing.spec.ts, packages/fret/test/simulation/fret-sim.ts, docs/fret.md
difficulty: medium
---

Third review run for `sim-placement-guards-no-control`. The two prior runs each hit the runner's
soft token budget before validating anything. This run **ran the validation** and found one real,
blocking failure. Nothing below needs re-reading ticket history or re-running anything already
reported here.

## Validated this run (do not repeat)

- `npx tsc --noEmit` from `packages/fret/` — **clean**. This settles the prior run's open question
  about the API surface the new test leans on: `FretSimulation.getStores()`, `scheduler.peek()`,
  `scheduler.advanceTo()` and `SimConfig.capacity` all exist as used.
- The prior run's comment fix on `MAX_PEERS_IN_ONE_SPACING_ARC` is **committed** (a619d51) and the
  working tree is clean. Nothing is left uncommitted from earlier runs.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" "test/churn-scenarios.spec.ts" --timeout 300000`
  from `packages/fret/` — **28 passing, 1 failing, 7 minutes wall clock.**

## The blocking failure

```
1) Placement distributions
     clustered placement: inter-cluster routing takes more hops:
   Error: Timeout of 300000ms exceeded.
```

**Every measurement the test makes is correct.** It printed all five seeds and they reproduce the
table in its own comment essentially exactly:

```
seed 8008: clustered 4.90 uniform 2.30      (comment: 4.90 / 2.30)
seed 8009: clustered 5.00 uniform 2.60      (comment: 5.00 / 2.60)
seed 8010: clustered 7.10 uniform 2.00      (comment: 7.10 / 2.00)
seed 4242: clustered 4.80 uniform 2.00      (comment: 4.80 / 2.00)
seed   99: clustered 6.70 uniform 3.10      (comment: 6.70 / 3.10)
```

All arms 10/10 successful, store size 32 on every arm, and every assertion — attempts, successes,
store bound, hop margin — passes. The test body is synchronous, so mocha's timer fires only once
the body returns: the failure is elapsed wall time and nothing else.

So this is **not** a wrong threshold or a flaky measurement. It is the runtime tax the implement
stage flagged, now measured: the handoff estimated ~130 s for this test; it is actually over 300 s.
The failure is caused by this ticket's own diff, so it must be fixed here — it is not a
pre-existing failure and must not be reported as one.

**Do not fix it by raising the timeout.** A single test over five minutes is past the point where
it is agent-runnable, and the two-spec run is already at seven minutes.

The levers, in the order they should be tried:

- **Cut `centersFor`'s wasted work first, because it costs nothing in coverage.** `centersFor(seed)`
  constructs and `initialize()`s an entire extra 300-peer simulation per seed purely to read the
  cluster centers, and then `measure()` constructs another one for the clustered arm from the same
  config. That is 5 wholly redundant 300-peer initializations across the sweep — a third of all the
  sims the test builds. Have `measure()` return the centers from the clustered arm it already
  builds, and drive the uniform arm afterwards with them. **Do not** let the uniform arm derive its
  own centers: both arms must route between identical coordinates or the control is destroyed.
- **Only if that is not enough, cut `ROUTES` or the seed count.** If seeds are cut, the measured
  table in the test's comment must be **re-taken**, not trimmed — a table listing seeds the test no
  longer runs is a false claim about what was measured. The implementer kept five seeds
  deliberately because the whole point of the rewrite was to stop asserting on one seed, so prefer
  cutting `ROUTES` over cutting seeds.

Re-run the command above to confirm; it is the gate for this ticket.

## Confirmed hygiene finding — fix inline

`pump(sim, uptoMs)` now exists **byte-identically in two files**:

- `test/simulation.routing.spec.ts:86-91`
- `test/message-bus.spec.ts:401-406`

Same three-line body (`peek` / `nextEvent` / `advanceTo`), same doc intent. Extract it once into
`test/simulation/` — `placement-assertions.ts` is placement-specific, so a small shared module
(e.g. `test/simulation/pump.ts`) is the right home — and have both specs import it.

**A prior run mis-scoped this; the correction matters.** There is a *second*, different pump idiom
(`while (pending > 0) { const evt = nextEvent(); if (!evt || evt.time > bound) break; ... }`, which
pops an event and then discards it when it lands past the bound). That one is **pre-existing and
widespread** — `churn-scenarios.spec.ts` at six sites, `sim-profiles.spec.ts` at two, and
`message-bus.spec.ts:318` — and is not something this ticket's diff introduced. Do **not** fold it
into the inline fix. Record the dropped-event behavior as a tripwire at one of those sites, or file
it as a `debt-` ticket if it turns out to change any reading; it is out of scope here.

## Findings still needing a judgement call

These were listed by an earlier run and none has been dispositioned. None is believed to be a
correctness defect. The output ticket must state a decision for each, not leave them silent.

- **`storeSize` is sampled from the first sender only** (`firstSender ??= from`). One sample is
  enough to prove the store bound actually bit, which is the assertion's stated purpose — so this is
  very likely fine as shipped. Say so explicitly rather than leaving it unremarked.
- **`cfgFor` passes `clusterConfig` on the uniform arm too**, where it is unused. Harmless, and
  arguably right: it keeps the two configs identical but for `placement`, which is the point of the
  control. Decide and state it.
- **The roughly 90-line comment block** above the second test. Judge whether it would read better as
  shorter prose plus named constants, per the source-hygiene rule preferring naming and composition
  over comment blocks.

## Aspect angles still unexamined

- **Source file size — measured, needs a judgement.** `wc -l packages/fret/test/message-bus.spec.ts`
  reports **585 lines**; the other touched files are `simulation/fret-sim.ts` 923,
  `simulation/placement.ts` 135, `simulation/placement-assertions.ts` 81. Decide whether 585 lines in
  one spec warrants a split (the `Placement distributions` describe block is the natural seam) or is
  acceptable, and say which.
- **`docs/fret.md`'s *Testing strategy → Simulation* bullet** was read in the AGENTS.md context and
  looked accurate, but has never been diffed against the final shipped test body. Do that check —
  in particular confirm the numbers it quotes (n=300 / capacity 32, 4.8–7.1 versus 2.0–3.1 hops,
  1.5-hop margin) still match after whatever runtime fix lands above. If `ROUTES` or the seed set
  changes, this bullet changes with it.
- **Resource cleanup.** The sims are local and dropped, but confirm nothing arms a timer the mocha
  exit watchdog would catch. The run above exited cleanly with the watchdog armed, which is
  suggestive but was not the thing being tested.

## Tripwires already parked at their code sites — do not re-file

- `spreadBits` is exact only to about 52 bits because `CoordPlacement.clusteredCoord` scales its
  Gaussian offset through a JS float. Noted at that site.
- The sim's near radius clamps to half the ring at a 32-entry store, so every candidate takes the
  selector's near branch. Noted at `nearRadiusFor` in `test/simulation/fret-sim.ts` and restated in
  the test's comment.

## Output

The `complete/` ticket must carry a `## Review findings` section listing what was checked, what was
found, and what was done — empty categories stated explicitly and with a reason, not omitted. The
"Validated this run" section above can be carried into it verbatim as the "what was checked" half.
