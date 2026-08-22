description: A simulation test that checks whether grouping peers into clusters makes messages travel farther now takes so long it trips the test framework's five-minute limit and reports as failing, even though every measurement it makes is correct. Most of the speed-up work is now written but has not yet been run, so the next step is to check it compiles, time it, and finish a few smaller clean-ups.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/simulation/pump.ts, packages/fret/test/simulation.routing.spec.ts, packages/fret/test/simulation/placement-assertions.ts, packages/fret/test/simulation/fret-sim.ts, packages/fret/test/churn-scenarios.spec.ts, docs/fret.md
difficulty: medium
---

Fifth review run for `sim-placement-guards-no-control`. Runs 1, 2 and 4 hit the soft token budget
before landing anything. Run 3 ran the validation and found the blocking failure recorded below.
**Run 5 (the previous one) landed real edits and then hit the budget warning before it could run
anything.** Nothing below needs re-reading ticket history.

## Working tree state — read this first

Run 5 modified three files. **They are unvalidated: no type-check and no test run has touched
them.** Start by type-checking, then re-time.

- **`packages/fret/test/simulation/pump.ts` — new file.** Exports the shared
  `pump(sim, uptoMs)`, doc sentence preserved verbatim: "Drive every event scheduled up to
  `uptoMs`, then park the clock there."
- **`packages/fret/test/simulation.routing.spec.ts`** — local `pump` deleted, now imports the
  shared one.
- **`packages/fret/test/message-bus.spec.ts`** — local `pump` deleted, now imports the shared one.
  `centersFor` deleted entirely; `measure(seed, placement, given?)` now derives the centers on the
  clustered arm (keeping the `expect(..., 'clustered placement must expose its centers').to.exist`)
  and *requires* the caller-supplied ones on the uniform arm, returning `centers` in its result.
  The sweep loop runs clustered first, then `measure(seed, 'uniform', clustered.centers)`. Also
  added two decision comments (see *Findings decided in run 5* below).

The one thing to double-check by eye, since nothing has compiled it: `FretSimulation` is still
*used* (not merely imported) in both specs after the pump deletions — confirm neither import went
unused, since `verbatimModuleSyntax` is on.

## The blocking failure (unchanged — this is what must now be re-timed)

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
nothing else. Not a wrong threshold, not a flaky measurement. Caused by this ticket's own diff, so
it must be fixed here; it is **not** a pre-existing failure and must not be reported as one.

**Do not fix it by raising the timeout.** A single test over five minutes is past agent-runnable.

## Remaining work, in order

**Step A — type-check.** `cd packages/fret && npx tsc --noEmit`. Fix whatever the run-5 edits broke.

**Step B — re-time.** Run 5's edit removes 5 of the 15 300-peer sim initializations the sweep built
(one per seed), so expect roughly 300 s -> ~200 s. **That may not be enough on its own.**

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" "test/churn-scenarios.spec.ts" --timeout 300000
```

Run it in the foreground with no redirection (or `| tee tickets/.logs/30-sim-placement.test.log`
if you need to grep it). Gate: 29 passing, 0 failing, comfortably inside the timeout.

**Step C — only if step B is still too slow, cut `ROUTES` (currently 10), not the seed count.** The
implementer kept five seeds deliberately: the whole point of the rewrite was to stop asserting on one
seed. If seeds are cut anyway, the measured table in the test's comment must be **re-taken**, not
trimmed — a table listing seeds the test no longer runs is a false claim about what was measured.
The same applies to the numbers in `docs/fret.md` (see step E).

**Step D — park the second pump idiom as a tripwire.** There is a *second*, different pump idiom
(`while (pending > 0) { const evt = nextEvent(); if (!evt || evt.time > bound) break; ... }`, which
pops an event and then discards it when it lands past the bound). It is **pre-existing and
widespread** — `churn-scenarios.spec.ts` at six sites, `sim-profiles.spec.ts` at two,
`message-bus.spec.ts` at one — and this ticket's diff did not introduce it. Do **not** fold it into
the shared `pump`. Add one `NOTE:` tripwire at a single one of those sites recording the
dropped-event behavior, or file a `debt-` ticket if it turns out to change any reading.

**Step E — verify `docs/fret.md`.** The *Testing strategy -> Simulation* bullet beginning
"**Placement is guarded by two tests**". Never diffed against the final shipped test body. Confirm
the numbers it quotes (n=300 / capacity 32, 4.8-7.1 versus 2.0-3.1 hops, 1.5-hop margin, 2m+1 = 17)
still match. If `ROUTES` or the seed set changed in step C, this bullet changes with it.

## Findings decided in run 5 — carry these verdicts into the `complete/` ticket

- **`storeSize` sampled from the first sender only** — **accepted as shipped.** One sample proves
  the store bound bit, which is the assertion's stated purpose, and every peer in the sweep is
  enforced against the same capacity. Recorded as a `NOTE:` at the sample site in `measure`.
- **`cfgFor` passes `clusterConfig` on the uniform arm too**, where it is unused — **accepted as
  shipped, and arguably right**: it keeps the two configs identical but for `placement`, which is
  the point of the control. Recorded as a comment at that field.

## Findings still needing a judgement call

- **The ~90-line comment block** above the second test. Judge whether it reads better as shorter
  prose plus named constants, per the source-hygiene rule preferring naming and composition over
  comment blocks. Run 5 did not touch it (it only added the two short decision comments above).
  Weigh carefully before trimming: the block carries a *measured* seed table that is load-bearing
  evidence for the thresholds, so shorten the prose, not the tables.

## Aspect angles still unexamined

- **Source file size — measured, needs a judgement.** Before run 5's edits
  `wc -l packages/fret/test/message-bus.spec.ts` reported **585 lines** (run 5's net change is
  roughly -10). Other touched files: `simulation/fret-sim.ts` 923, `simulation/placement.ts` 135,
  `simulation/placement-assertions.ts` 81, the new `simulation/pump.ts` ~9. Re-measure with `wc -l`
  and decide whether it warrants a split (the `Placement distributions` describe block is the
  natural seam) or is acceptable, and say which.
- **Resource cleanup.** Sims are local and dropped; confirm nothing arms a timer the mocha exit
  watchdog would catch. Run 3's run exited cleanly with the watchdog armed — suggestive, but that
  was not what was being tested.

## Validated (do not repeat)

- `npx tsc --noEmit` from `packages/fret/` — clean **at run 3's tree**, i.e. *before* run 5's edits.
  `FretSimulation.getStores()`, `scheduler.peek()`, `scheduler.advanceTo()` and `SimConfig.capacity`
  all exist as the test uses them. This does **not** cover run 5's edits — see step A.
- The two-spec command above at run 3's tree — **28 passing, 1 failing, 7 minutes wall clock.**
- **Confirmed by reading (run 4):** `pump` was byte-identical in both specs. Resolved by run 5.
- **Confirmed by reading (run 4):** `centersFor` built and `initialize()`d a full 300-peer clustered
  sim purely to read `getClusterCenters()`, i.e. 5 redundant initializations of 15. Resolved by
  run 5.

## Tripwires already parked at their code sites — do not re-file

- `spreadBits` is exact only to ~52 bits because `CoordPlacement.clusteredCoord` scales its Gaussian
  offset through a JS float. Noted at that site.
- The sim's near radius clamps to half the ring at a 32-entry store, so every candidate takes the
  selector's near branch. Noted at `nearRadiusFor` in `test/simulation/fret-sim.ts` and restated in
  the test's comment.

## Output

The `complete/` ticket must carry a `## Review findings` section listing what was checked, what was
found, and what was done — empty categories stated explicitly with a reason, not omitted. The
"Validated" section above and the run-5 verdicts can be carried into it as the "what was checked"
and "what was decided" halves.
