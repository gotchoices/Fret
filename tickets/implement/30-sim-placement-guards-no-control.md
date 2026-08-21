description: Two simulation tests claimed to prove placement strategies produce different ring shapes but would pass without that behavior; one of the two replacement checks now has a real measured threshold — the other passes today but its separation margin is thin and unverified across seeds, still needs that check before handoff, then the whole suite needs a run and a review handoff.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/churn-scenarios.spec.ts, packages/fret/test/simulation/placement-assertions.ts
difficulty: easy
tradeoffs: n/a (implement ticket)
---

<!-- resume-note -->
**Rewritten 2026-08-21 by a second interrupted run (BUDGET_WARNING).** This run only re-read
files — it ran no script and no test — and hit budget before doing new work. Do not re-read this
file's own history further than what's below; it is complete. Step 1 is done (measured, not
guessed) — do not re-verify it, no further action there. Step 2 is exactly where the prior run
left it: reachable, understood, but the seed-robustness check has still never been run.

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

**Next agent, do this — no further investigation needed, just execute:**

1. Write a throwaway script (scratchpad, not committed — do NOT put it under `packages/fret/`)
   that imports `FretSimulation` from `test/simulation/fret-sim.ts` and reproduces `avgHopsFor`
   exactly as written at `test/message-bus.spec.ts` L348-390, but looping over
   `PLACEMENT_SEEDS` (imported from `test/simulation/placement-assertions.ts`) instead of the
   hardcoded `seed: 42`. Print `clustered` vs `uniform` `avgRoutingHops` (and the
   `successfulRouteHops` average) per seed — mirroring exactly what step 1's diagnostic run
   already proved out for the other test. Run it with the project's TS loader:
   `node --import ./register.mjs <script>.ts` from `packages/fret/`.
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
