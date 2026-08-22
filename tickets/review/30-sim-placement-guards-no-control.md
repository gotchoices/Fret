description: A simulation test that checks whether grouping peers into clusters makes messages travel farther now takes so long it trips the test framework's five-minute limit and reports as failing, even though every measurement it makes is correct. The test needs to be made faster, and a few smaller clean-ups from the same review still need doing.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/simulation/placement-assertions.ts, packages/fret/test/simulation.routing.spec.ts, packages/fret/test/simulation/fret-sim.ts, docs/fret.md
difficulty: medium
---

Fourth review run for `sim-placement-guards-no-control`. Runs 1 and 2 hit the soft token budget
before validating anything. Run 3 ran the validation and found the blocking failure recorded below.
Run 4 (this one) re-read the two specs and **confirmed the two code-level facts the fix depends on**,
then hit the budget warning with no edits landed. Nothing below needs re-reading ticket history.
**No source file has been modified by any review run except the committed comment fix at a619d51;
the working tree is clean of review edits.**

## Validated (do not repeat)

- `npx tsc --noEmit` from `packages/fret/` — **clean**. `FretSimulation.getStores()`,
  `scheduler.peek()`, `scheduler.advanceTo()` and `SimConfig.capacity` all exist as the new test
  uses them.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" "test/churn-scenarios.spec.ts" --timeout 300000`
  from `packages/fret/` — **28 passing, 1 failing, 7 minutes wall clock.**
- **Confirmed by reading (run 4):** `pump` is byte-identical in
  `test/simulation.routing.spec.ts:86-91` and `test/message-bus.spec.ts:401-406` — same three-line
  body, same doc-comment intent.
- **Confirmed by reading (run 4):** in `test/message-bus.spec.ts`, `centersFor(seed)` builds and
  `initialize()`s a full 300-peer clustered sim purely to call `sim.getClusterCenters()`, and then
  `measure(seed, 'clustered', centers)` builds a *second* sim from the identical
  `cfgFor(seed, 'clustered')`. Over `PLACEMENT_SEEDS` (5 seeds) that is 5 redundant 300-peer
  initializations out of 15 sims built.

## The blocking failure

```
1) Placement distributions
     clustered placement: inter-cluster routing takes more hops:
   Error: Timeout of 300000ms exceeded.
```

**Every measurement the test makes is correct.** All five seeds printed and reproduce the table in
the test's own comment essentially exactly:

```
seed 8008: clustered 4.90 uniform 2.30      (comment: 4.90 / 2.30)
seed 8009: clustered 5.00 uniform 2.60      (comment: 5.00 / 2.60)
seed 8010: clustered 7.10 uniform 2.00      (comment: 7.10 / 2.00)
seed 4242: clustered 4.80 uniform 2.00      (comment: 4.80 / 2.00)
seed   99: clustered 6.70 uniform 3.10      (comment: 6.70 / 3.10)
```

All arms 10/10 successful, store size 32 on every arm, every assertion passes. The test body is
synchronous, so mocha's timer fires only once the body returns: the failure is elapsed wall time and
nothing else. Not a wrong threshold, not a flaky measurement — the runtime tax the implement stage
estimated at ~130 s is actually over 300 s. Caused by this ticket's own diff, so it must be fixed
here; it is **not** a pre-existing failure and must not be reported as one.

**Do not fix it by raising the timeout.** A single test over five minutes is past agent-runnable.

## The fix, in the order to try it

**Step 1 — drop the redundant `centersFor` sim.** Costs nothing in coverage. Change `measure` so the
clustered arm returns the centers it already has, and drive the uniform arm afterwards with them:

```
function measure(seed, placement, centers?) -> { hops, succeeded, attempts, storeSize, centers }
```

For `placement === 'clustered'`, take `centers` from `sim.getClusterCenters()` after `initialize()`
(keeping the existing `expect(centers, 'clustered placement must expose its centers').to.exist`);
for `'uniform'`, require the caller-supplied `centers`. The loop body then runs clustered first,
uniform second. Delete `centersFor` entirely.

**Do not** let the uniform arm derive its own centers — both arms must route between identical
coordinates or the control is destroyed. This removes a third of the sims the sweep builds, so
expect roughly 300 s -> ~200 s. **That may not be enough on its own; re-time before stopping.**

**Step 2 — only if step 1 is not enough, cut `ROUTES` (currently 10), not the seed count.** The
implementer kept five seeds deliberately: the whole point of the rewrite was to stop asserting on one
seed. If seeds are cut anyway, the measured table in the test's comment must be **re-taken**, not
trimmed — a table listing seeds the test no longer runs is a false claim about what was measured.
The same applies to the numbers in `docs/fret.md` (see below).

Gate: re-run the two-spec command above and confirm green.

## Confirmed hygiene finding — fix inline

Extract the duplicated `pump(sim, uptoMs)` into a small shared module, e.g.
`test/simulation/pump.ts` (`placement-assertions.ts` is placement-specific, so not there), and have
both specs import it. Keep the existing doc sentence: "Drive every event scheduled up to `uptoMs`,
then park the clock there."

**Scope correction — a prior run mis-scoped this.** There is a *second*, different pump idiom
(`while (pending > 0) { const evt = nextEvent(); if (!evt || evt.time > bound) break; ... }`, which
pops an event and then discards it when it lands past the bound). It is **pre-existing and
widespread** — `churn-scenarios.spec.ts` at six sites, `sim-profiles.spec.ts` at two,
`message-bus.spec.ts:318` — and this ticket's diff did not introduce it. Do **not** fold it into the
inline fix. Park the dropped-event behavior as a `NOTE:` tripwire at one of those sites, or file a
`debt-` ticket if it turns out to change any reading.

## Findings still needing a judgement call

None is believed to be a correctness defect. The output `complete/` ticket must state a decision for
each — explicitly, with a reason, not silently.

- **`storeSize` is sampled from the first sender only** (`firstSender ??= from`). One sample proves
  the store bound actually bit, which is the assertion's stated purpose, so this is very likely fine
  as shipped. Say so rather than leaving it unremarked.
- **`cfgFor` passes `clusterConfig` on the uniform arm too**, where it is unused. Harmless and
  arguably right: it keeps the two configs identical but for `placement`, which is the point of the
  control. Decide and state it.
- **The ~90-line comment block** above the second test. Judge whether it reads better as shorter
  prose plus named constants, per the source-hygiene rule preferring naming and composition over
  comment blocks.

## Aspect angles still unexamined

- **Source file size — measured, needs a judgement.** `wc -l packages/fret/test/message-bus.spec.ts`
  reports **585 lines**; other touched files: `simulation/fret-sim.ts` 923,
  `simulation/placement.ts` 135, `simulation/placement-assertions.ts` 81. Decide whether 585 lines
  warrants a split (the `Placement distributions` describe block is the natural seam) or is
  acceptable, and say which.
- **`docs/fret.md`'s *Testing strategy -> Simulation* bullet** — the paragraph beginning "**Placement
  is guarded by two tests**". It was read in the AGENTS.md context and looked accurate, but has never
  been diffed against the final shipped test body. Confirm the numbers it quotes (n=300 / capacity
  32, 4.8-7.1 versus 2.0-3.1 hops, 1.5-hop margin, 2m+1 = 17) still match after the runtime fix. If
  `ROUTES` or the seed set changes, this bullet changes with it.
- **Resource cleanup.** Sims are local and dropped; confirm nothing arms a timer the mocha exit
  watchdog would catch. The run above exited cleanly with the watchdog armed — suggestive, but that
  was not what was being tested.

## Tripwires already parked at their code sites — do not re-file

- `spreadBits` is exact only to ~52 bits because `CoordPlacement.clusteredCoord` scales its Gaussian
  offset through a JS float. Noted at that site.
- The sim's near radius clamps to half the ring at a 32-entry store, so every candidate takes the
  selector's near branch. Noted at `nearRadiusFor` in `test/simulation/fret-sim.ts` and restated in
  the test's comment.

## Output

The `complete/` ticket must carry a `## Review findings` section listing what was checked, what was
found, and what was done — empty categories stated explicitly with a reason, not omitted. The
"Validated" section above can be carried into it verbatim as the "what was checked" half.
