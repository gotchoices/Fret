description: Two simulation tests claimed to prove placement strategies produce different ring shapes but would pass without that behavior; the replacement checks are written and only need one threshold measured and the suite run.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/churn-scenarios.spec.ts, packages/fret/test/simulation/placement-assertions.ts
difficulty: easy
tradeoffs: n/a (implement ticket)
---

**Rewritten 2026-08-21 by an interrupted run (BUDGET_WARNING), replacing the prior handoff.**
No code edits happened this run — only read-only verification. Do not re-read this file's own
history further than what's below; it is complete.

## Verified state (this run confirmed by reading the files directly)

- `test/simulation/placement-assertions.ts` exists and exports `coordToBigInt`,
  `maxPeersInOneSpacingArc`, `PLACEMENT_SEEDS = [8008, 8009, 8010, 4242, 99]`,
  `MAX_PEERS_IN_ONE_SPACING_ARC = 7`. Unchanged, correct, done — no further action.
- `test/message-bus.spec.ts` imports all three at L7 and both replacement cases are written into
  `describe('Placement distributions', ...)` (starts ~L293).
- `test/churn-scenarios.spec.ts` edit landed (per prior handoff; not re-verified this run — no
  reason to doubt it, out of scope for this run's budget).

## Step 1 — NOT done. `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC` is a placeholder guess, not a measurement

At `test/message-bus.spec.ts` L320-325, the `'clustered placement: peers cluster around centers'`
case currently reads:

```
// UNVERIFIED PLACEHOLDER — not yet measured against a real run (budget cut off before the
// test could be executed). Run this case once with the threshold set very loose (e.g. 0),
// capture the printed clustered/uniform readings across PLACEMENT_SEEDS from the console.log
// below, then replace this with a real measured table...
const CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC = 10
```

A prior run guessed `10` and left it explicitly marked unverified. **Nobody has actually run this
test and looked at the printed numbers yet.** That is the one required action:

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" --grep "peers cluster around centers" --timeout 60000
```

Run from `packages/fret/` (if your shell is already sitting in `packages/fret/`, do **not**
prefix with `cd packages/fret &&` — that fails with "No such file or directory" since it's
relative to repo root, not idempotent).

At threshold 10 the test may pass or fail depending on actual readings — either way, read the
`clustered X, uniform Y` lines logged for all five `PLACEMENT_SEEDS` (stderr/stdout console.log).
Pick a threshold strictly between the worst (highest) uniform reading and the best (lowest)
clustered reading, with margin, the same way `MAX_PEERS_IN_ONE_SPACING_ARC` was picked (see its
doc comment in `placement-assertions.ts`: ~1.75x above the worst fixed reading, ~1.57x below the
best buggy one). Replace the `10` and delete the `UNVERIFIED PLACEHOLDER` comment above it with a
real measured table in the same comment style as `placement-assertions.ts`'s doc comment.

If the guessed `10` genuinely does NOT separate the two distributions (uniform sometimes exceeds
it, or clustered sometimes doesn't) — that's real signal, not just "pick a better number in the
same run"; note it plainly in the review handoff.

## Step 2 — hop statistic for case 2, still unchecked

`'clustered placement: inter-cluster routing takes more hops'` (~L339-387) asserts
`expect(clustered).to.be.greaterThan(uniform)` on `avgRoutingHops` and logs both candidates plus
`successfulRouteHops` average. This was never run this session either.

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" --grep "inter-cluster routing takes more hops" --timeout 60000
```

- Passes with clean separation → done, leave as-is.
- Fails or numbers don't separate → return the `successfulRouteHops` average instead of
  `metrics.avgRoutingHops` (already computed in the log line), add a one-line comment saying why,
  mirroring the `successfulRouteHops` doc comment in `sim-metrics.ts`, and re-run.
- **Neither statistic separates** → the target loop (`target[j] = (seed * (j + 1) * 37) & 0xff`)
  is not landing targets across cluster boundaries. Read `test/simulation/placement.ts` for where
  cluster centers come from (`clusterConfig: { numClusters: 3, spreadBits: 32 }`) and aim each
  target near a *different* cluster (e.g. bucket by `i % numClusters`). **Do not ship the case
  unseparating.** This path is real investigation — if budget is short again, split it into its
  own follow-up ticket rather than rushing it alongside step 1 and step 3.

## Step 3 — gate (only after steps 1 and 2 are both real, not placeholder)

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
module; the measured threshold and its provenance (actual numbers, not the guessed 10); and which
hop statistic case 2 used and why. Say so plainly if step 2 needed the target-generation fix —
that is a real change beyond the original snippet. Delete this file once the review ticket is
written.
