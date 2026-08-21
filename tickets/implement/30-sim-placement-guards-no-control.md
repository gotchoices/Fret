description: Two simulation tests claimed to prove placement strategies produce different ring shapes but would pass without that behavior; the replacement checks are written and only need one threshold measured and the suite run.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/churn-scenarios.spec.ts, packages/fret/test/simulation/placement-assertions.ts
difficulty: easy
tradeoffs: n/a (implement ticket)
---

**Rewritten 2026-08-21 by the gardener, replacing 202 lines with the three steps that remain.**
Twelve runs, the last several killed on `BUDGET_WARNING` after spending the whole budget
re-reading the ticket's own preserved context and re-confirming state that was already confirmed.
Nothing below needs re-deriving; the removed material was history, not instruction.

## Verified state — all code edits are done

- `test/simulation/placement-assertions.ts` exists and exports `coordToBigInt`,
  `maxPeersInOneSpacingArc`, `PLACEMENT_SEEDS = [8008, 8009, 8010, 4242, 99]`,
  `MAX_PEERS_IN_ONE_SPACING_ARC = 7`.
- `test/message-bus.spec.ts` imports all three at L7 and both replacement cases are written into
  `describe('Placement distributions', ...)`.
- `test/churn-scenarios.spec.ts` edit landed.

**No Edit or Write call is needed except the one number in step 1.** Do not read these files to
re-verify — that is what killed the last several runs.

## Step 1 — measure `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC`

In `message-bus.spec.ts`, the `'clustered placement: peers cluster around centers'` case holds
`const CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC = /* MEASURE AND FILL IN */ 0`.

```
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" --grep "peers cluster around centers" --timeout 60000
```

It will fail at threshold 0 — that is expected; the point is the `clustered X, uniform Y` lines
logged for all five `PLACEMENT_SEEDS`. Pick a threshold strictly between the worst (highest)
uniform reading and the best (lowest) clustered reading, with margin, the same way
`MAX_PEERS_IN_ONE_SPACING_ARC` was picked (see its doc comment: ~1.75× above the worst fixed
reading, ~1.57× below the best buggy one). Replace the `0` and the `MEASURE FIRST` comment above
it with the measured table.

## Step 2 — settle the hop statistic for case 2

`'clustered placement: inter-cluster routing takes more hops'` asserts
`expect(clustered).to.be.greaterThan(uniform)` on `avgRoutingHops` and logs both candidates.

```
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" --grep "inter-cluster routing takes more hops" --timeout 60000
```

- Passes with clean separation → done, leave as-is.
- Fails or the numbers do not separate → return the `successfulRouteHops` average instead of
  `metrics.avgRoutingHops` (already computed in the log line), add a one-line comment saying why,
  mirroring the `successfulRouteHops` doc comment in `sim-metrics.ts`, and re-run.
- **Neither statistic separates** → the target loop (`target[j] = (seed * (j + 1) * 37) & 0xff`)
  is not landing targets across cluster boundaries. Read `test/simulation/placement.ts` for where
  cluster centers come from (`clusterConfig: { numClusters: 3, spreadBits: 32 }`) and aim each
  target near a *different* cluster (e.g. bucket by `i % numClusters`). **Do not ship the case
  unseparating.** This path is real investigation — if budget is short, hand it to its own
  follow-up rather than rushing it alongside steps 1 and 3.

## Step 3 — gate

```
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" "test/churn-scenarios.spec.ts" --timeout 60000
cd packages/fret && npx tsc --noEmit
```

An unrelated failure follows the pre-existing-failure protocol in the workflow rules rather than
being chased here.

## Handoff

Write the `review/` ticket (slug `sim-placement-guards-no-control`) covering: the two vacuous
tests replaced with both-directions clustered-vs-uniform checks following the
`assertPlacementSeparates` pattern already proven in `churn-scenarios.spec.ts`; the new shared
module; the measured threshold and its provenance; and which hop statistic case 2 used and why.
Say so plainly if step 2 needed the target-generation fix — that is a real change beyond the
original snippet. Delete this file once the review ticket is written.
