description: Two simulation tests claimed to prove placement strategies produce different ring shapes but would pass without that behavior; one of the two replacement checks now has a real measured threshold — the other passes today but its separation margin is thin and unverified across seeds, still needs that check before handoff, then the whole suite needs a run and a review handoff.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/churn-scenarios.spec.ts, packages/fret/test/simulation/placement-assertions.ts
difficulty: easy
tradeoffs: n/a (implement ticket)
---

<!-- resume-note -->
**Rewritten 2026-08-21 by a sixth interrupted run (BUDGET_WARNING).** Same failure shape as every
prior run — died before executing the script, only reading/confirming. One new fact confirmed
this run, cheaply, before stopping: `packages/fret/register.mjs` is `register('ts-node/esm',
import.meta.url)` — a real ts-node ESM loader, not a bespoke per-file type-stripper (that
description in this ticket's file-level `files:`/general framing was this run's own prior
assumption, now checked against the actual file). Practical consequence: the `.js`-suffixed
relative imports in the script below (`'../../packages/fret/test/simulation/fret-sim.js'` etc.)
resolve exactly the way every other test file's imports already do — ts-node/esm maps `.js` back
to the sibling `.ts` file. No path-shape change needed to the script; this just removes one
unstated assumption the prior five runs were carrying silently.

**Next run: first action is pasting and running the script. Do not re-read fret-sim.ts,
sim-metrics.ts, event-scheduler.ts, placement.ts, placement-assertions.ts, or message-bus.spec.ts
again — six runs running now have confirmed them unchanged and API-compatible. If tempted to
re-verify "just to be sure," don't — that verification is what has burned every prior run's
budget. Run the script.**

Previous run's confirmation (still valid, restated for continuity): it read the four sim-harness
files the step-2 script imports/depends on (`fret-sim.ts`, `sim-metrics.ts`, `event-scheduler.ts`,
`placement.ts`) end-to-end and confirmed **every API the script below calls exists with exactly
the signature the script assumes** — no adjustment needed to the script body itself:
- `FretSimulation` constructor takes `SimConfig` (seed/n/k/m/churnRatePerSec/
  stabilizationIntervalMs/durationMs/placement/clusterConfig) — matches.
- `sim.initialize()`, `sim.scheduler.advanceTo(ms)` (returns fired events, also advances current
  time), `sim.processEvent(evt)`, `sim.scheduler.pending()`, `sim.scheduler.nextEvent()`,
  `sim.getPeers()` (→ `ReadonlyMap<string, SimPeer>`, each with `.alive`, `.id`, `.coord`),
  `sim.scheduleRoute(fromId, targetCoord, atMs)` — all present, all match the script's usage.
- `sim.metrics.finalize()` → `SimMetrics` with `avgRoutingHops`, `successfulRouteHops: number[]`,
  `routingAttempts` — all present, matches the script's return shape.
- `PLACEMENT_SEEDS` import from `placement-assertions.js` — confirmed present (step 1, done).

**One thing worth knowing before attempting the target-generation fallback fix (script step 3,
"neither statistic separates" branch):** `CoordPlacement.clusterCenters` (`placement.ts` L44) is
a **private** field with no getter — the cluster centers `clusteredCoord()` draws from are not
exposed anywhere outside that class. So the fallback fix sketched in the prior version of this
note ("aim each target near a *different* cluster, e.g. bucket by `i % numClusters`") cannot read
real cluster centers directly. If that branch is reached, the practical option is: after
`sim.initialize()` + advancing, read actual peer coordinates via `sim.getPeers()` (which are
already clustered per the placement strategy), pick one alive peer's coordinate per bucket
(`i % numClusters`, using peers sorted by coordinate or just distinct sampled peers) as each
target instead of hashing `seed`. This still needs verifying once reached — do not assume it
works without running it. This is a fallback path only reached if the primary statistic swap
(returning `successfulRouteHops` average) also fails to separate; most likely the primary swap
alone resolves it and this paragraph is never needed.

Step 1 is done (measured, not guessed) — no further action there. Step 2 is exactly where every
prior run left it: reachable, understood, script content fully specified below, and now doubly
confirmed to match the actual harness API with zero adjustments needed — **the next run's first
action must be pasting and running the script**, not reading any of the four sim files above
again (all four fully read and confirmed this run — do not re-read them) and not re-reading
`placement-assertions.ts` or `message-bus.spec.ts` (confirmed unchanged five runs running now).

## Verified state (this run re-confirmed by reading files directly; ran nothing)

- `test/simulation/placement-assertions.ts` exists and exports `coordToBigInt`,
  `maxPeersInOneSpacingArc`, `PLACEMENT_SEEDS = [8008, 8009, 8010, 4242, 99]`,
  `MAX_PEERS_IN_ONE_SPACING_ARC = 7`. Unchanged, correct, done — no further action.
- `test/message-bus.spec.ts` imports all three at L7. `describe('Placement distributions', ...)`
  starts at L293.
- Step 1 test (`'clustered placement: peers cluster around centers'`, L296-345) has
  `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC = 5` with a measured-table comment (worst uniform 1,
  best clustered 12 across all 5 `PLACEMENT_SEEDS` — 5 sits 5x above worst / 2.4x below best) and
  asserts both directions in a loop over `PLACEMENT_SEEDS`. Leave as-is.
- Step 2 test (`'clustered placement: inter-cluster routing takes more hops'`, L347-395) is
  UNCHANGED from the prior run's description: single hardcoded `seed: 42` (L350), returns
  `metrics.avgRoutingHops` (L389), asserts only `clustered > uniform` with no numeric margin
  (L394). `n: 30, k: 15` (half the ring in-cluster). Prior run's measured single-seed result
  (not re-run this session): clustered avgRoutingHops 1 vs uniform 0.9 — a one-hop gap out of 10
  routes, all 10 succeeding both times.
- `test/churn-scenarios.spec.ts` edit landed per earlier handoffs; still not re-verified this run
  — no reason to doubt it, out of scope for this ticket's remaining budget.

## Step 2 — hop statistic for case 2, still not seed-verified

**Next agent, do this — no further investigation needed, just execute. Three runs in a row died
of BUDGET_WARNING before running anything, only re-reading files, so the script is now spelled
out verbatim below — paste it and run it, first action of the run.**

1. Write this exact file to the scratchpad (NOT under `packages/fret/` — do not commit it) as
   `seed-check.ts`, then run `node --import ./register.mjs <path-to>/seed-check.ts` from
   `packages/fret/`:

   ```ts
   import { FretSimulation } from '../../packages/fret/test/simulation/fret-sim.js' // adjust relative path to wherever the scratchpad file lands
   import { PLACEMENT_SEEDS } from '../../packages/fret/test/simulation/placement-assertions.js'

   function avgHopsFor(seed: number, placement?: 'clustered') {
   	const sim = new FretSimulation({
   		seed,
   		n: 30,
   		k: 15,
   		m: 8,
   		churnRatePerSec: 0,
   		stabilizationIntervalMs: 500,
   		durationMs: 8000,
   		...(placement ? { placement, clusterConfig: { numClusters: 3, spreadBits: 32 } } : {}),
   	})
   	sim.initialize()
   	for (const evt of sim.scheduler.advanceTo(5000)) sim.processEvent(evt)
   	const alivePeers = Array.from(sim.getPeers().values()).filter((p) => p.alive)
   	for (let i = 0; i < 10; i++) {
   		const from = alivePeers[i % alivePeers.length]!
   		const target = new Uint8Array(32)
   		const s = seed + i * 13
   		for (let j = 0; j < 32; j++) target[j] = (s * (j + 1) * 37) & 0xff
   		sim.scheduleRoute(from.id, target, 5001 + i)
   	}
   	while (sim.scheduler.pending() > 0) {
   		const evt = sim.scheduler.nextEvent()
   		if (!evt || evt.time > 8000) break
   		sim.processEvent(evt)
   	}
   	const metrics = sim.metrics.finalize()
   	const successAvg =
   		metrics.successfulRouteHops.length > 0
   			? metrics.successfulRouteHops.reduce((a, b) => a + b, 0) / metrics.successfulRouteHops.length
   			: NaN
   	return { avgRoutingHops: metrics.avgRoutingHops, successAvg, attempts: metrics.routingAttempts }
   }

   for (const seed of PLACEMENT_SEEDS) {
   	const c = avgHopsFor(seed, 'clustered')
   	const u = avgHopsFor(seed)
   	console.log(
   		`seed ${seed}: clustered avgRoutingHops=${c.avgRoutingHops} successAvg=${c.successAvg} | ` +
   			`uniform avgRoutingHops=${u.avgRoutingHops} successAvg=${u.successAvg}`
   	)
   }
   ```

   (Fix the two relative import paths to match wherever the scratchpad file actually lands
   relative to `packages/fret/test/simulation/` — the paths above assume a sibling-of-repo-root
   layout and must be adjusted to the real scratchpad path before running.)

2. **If separation holds cleanly across all 5 seeds** (clustered consistently > uniform,
   comfortable margin, not 1-vs-0 flukes): the test is fine as shipped — leave the code
   untouched. Just record in the review ticket (see Handoff below) that the margin was checked
   and is real, with the per-seed numbers.
3. **If it does not hold** (flips sign on some seeds, or margin is inconsistently 0-1 hops):
   - First try returning `successfulRouteHops` average instead of `metrics.avgRoutingHops`
     (already computed in the existing log line at L384-388) as the returned/asserted statistic;
     add a one-line comment saying why, mirroring the `successfulRouteHops` doc comment in
     `sim-metrics.ts`; re-run across seeds again.
   - If **neither statistic separates**: the target-generation loop (`target[j] = (seed * (j + 1)
     * 37) & 0xff`, L372) is not reliably landing targets across cluster boundaries. Read
     `test/simulation/placement.ts` for where cluster centers come from (`clusterConfig: {
     numClusters: 3, spreadBits: 32 }`) and aim each target near a *different* cluster (e.g.
     bucket by `i % numClusters`). **Do not ship the case unseparating.** This is real
     investigation — if budget is short again, split it into its own follow-up ticket rather
     than rushing it, and say so plainly in the handoff.

## Step 3 — gate (only after step 2 is genuinely resolved, not left on an unchecked single-seed pass)

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" "test/churn-scenarios.spec.ts" --timeout 60000
npx tsc --noEmit
```

Both from `packages/fret/`. An unrelated failure follows the pre-existing-failure protocol in the
workflow rules rather than being chased here.

## Handoff

Write the `review/` ticket (slug `sim-placement-guards-no-control`) covering: the two vacuous
tests replaced with both-directions clustered-vs-uniform checks following the
`assertPlacementSeparates` pattern already proven in `churn-scenarios.spec.ts`; the new shared
module; the measured threshold and its provenance for step 1 (final); and for step 2, which hop
statistic was used, whether it needed the target-generation fix, and the actual per-seed numbers
that justify calling the separation real (not just "it passed once at seed 42"). Say plainly if
step 2 needed the target-generation fix — that is a real change beyond the original snippet.
Delete this file once the review ticket is written.
