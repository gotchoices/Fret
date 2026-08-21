description: Two simulation tests claimed to prove placement strategies produce different ring shapes but would pass without that behavior; one of the two replacement checks now has a real measured threshold — the other still needs its measurement, then the whole suite needs a run and a review handoff.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/churn-scenarios.spec.ts, packages/fret/test/simulation/placement-assertions.ts
difficulty: easy
tradeoffs: n/a (implement ticket)
---

**Rewritten 2026-08-21 by an interrupted run (BUDGET_WARNING), replacing the prior handoff.**
Step 1 below is now genuinely done (measured, not guessed). Steps 2 and 3 were not reached this
run. Do not re-read this file's own history further than what's below; it is complete.

## Verified state (this run confirmed by reading the files directly, and by running step 1)

- `test/simulation/placement-assertions.ts` exists and exports `coordToBigInt`,
  `maxPeersInOneSpacingArc`, `PLACEMENT_SEEDS = [8008, 8009, 8010, 4242, 99]`,
  `MAX_PEERS_IN_ONE_SPACING_ARC = 7`. Unchanged, correct, done — no further action.
- `test/message-bus.spec.ts` imports all three at L7 and both replacement cases are written into
  `describe('Placement distributions', ...)` (starts ~L293).
- `test/churn-scenarios.spec.ts` edit landed (per prior handoff; not re-verified this run — no
  reason to doubt it, out of scope for this run's budget).

## Step 1 — DONE this run. Real measured threshold, not a guess

Ran:
```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" --grep "peers cluster around centers" --timeout 60000
```
from `packages/fret/`. Result: passed, clean separation across all 5 `PLACEMENT_SEEDS` —

```
seed 8008: clustered 13, uniform 1
seed 8009: clustered 12, uniform 1
seed 8010: clustered 15, uniform 1
seed 4242: clustered 17, uniform 1
seed 99:   clustered 12, uniform 1
```

`test/message-bus.spec.ts` now has `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC = 5` (worst uniform 1,
best clustered 12 — 5 sits 5x above worst / 2.4x below best) with a real measured-table comment
replacing the old `UNVERIFIED PLACEHOLDER` one. Test re-run not yet done against the new constant
(it was passing against the old placeholder 10, and 5 is strictly stricter/still within the gap,
so it should still pass — but **confirm this by running it again** as part of step 3's gate below,
since it was not independently re-run after the edit this session).

## Step 2 — hop statistic for case 2, still unchecked (not reached this run)

`'clustered placement: inter-cluster routing takes more hops'` (~L339-387, line numbers may have
shifted slightly by the step-1 edit above) asserts `expect(clustered).to.be.greaterThan(uniform)`
on `avgRoutingHops` and logs both candidates plus `successfulRouteHops` average. Never run this
session.

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" --grep "inter-cluster routing takes more hops" --timeout 60000
```

Run from `packages/fret/` (if your shell is already sitting in `packages/fret/`, do **not**
prefix with `cd packages/fret &&` — that fails with "No such file or directory" since it's
relative to repo root, not idempotent).

- Passes with clean separation → done, leave as-is.
- Fails or numbers don't separate → return the `successfulRouteHops` average instead of
  `metrics.avgRoutingHops` (already computed in the log line), add a one-line comment saying why,
  mirroring the `successfulRouteHops` doc comment in `sim-metrics.ts`, and re-run.
- **Neither statistic separates** → the target loop (`target[j] = (seed * (j + 1) * 37) & 0xff`)
  is not landing targets across cluster boundaries. Read `test/simulation/placement.ts` for where
  cluster centers come from (`clusterConfig: { numClusters: 3, spreadBits: 32 }`) and aim each
  target near a *different* cluster (e.g. bucket by `i % numClusters`). **Do not ship the case
  unseparating.** This path is real investigation — if budget is short again, split it into its
  own follow-up ticket rather than rushing it alongside step 3.

## Step 3 — gate (only after step 2 is real, not skipped)

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
module; the measured threshold and its provenance (real numbers above, for step 1 — already
final); and which hop statistic case 2 used and why. Say so plainly if step 2 needed the
target-generation fix — that is a real change beyond the original snippet. Delete this file once
the review ticket is written.
