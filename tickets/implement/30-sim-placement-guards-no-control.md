description: Two simulation tests claimed to prove placement strategies produce different ring shapes but would pass without that behavior; one of the two replacement checks now has a real measured threshold — the other passes today but its separation margin is thin and unverified across seeds, still needs that check before handoff, then the whole suite needs a run and a review handoff.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/churn-scenarios.spec.ts, packages/fret/test/simulation/placement-assertions.ts
difficulty: easy
tradeoffs: n/a (implement ticket)
---

**Rewritten 2026-08-21 by an interrupted run (BUDGET_WARNING), replacing the prior handoff.**
Step 1 is done (measured, not guessed) — do not re-verify it, no further action there. Step 2 was
reached this run but not finished: the test currently passes unmodified, but the margin is thin
and was not checked for robustness across seeds before budget ran out. Do not re-read this file's
own history further than what's below; it is complete.

## Verified state (this run confirmed by reading files directly and running tests)

- `test/simulation/placement-assertions.ts` exists and exports `coordToBigInt`,
  `maxPeersInOneSpacingArc`, `PLACEMENT_SEEDS = [8008, 8009, 8010, 4242, 99]`,
  `MAX_PEERS_IN_ONE_SPACING_ARC = 7`. Unchanged, correct, done — no further action.
- `test/message-bus.spec.ts` imports all three at L7 and both replacement cases are written into
  `describe('Placement distributions', ...)` (starts ~L293).
- `test/churn-scenarios.spec.ts` edit landed (per earlier handoff; not re-verified this run — no
  reason to doubt it, out of scope for this run's budget).

## Step 1 — DONE. Real measured threshold, not a guess

`test/message-bus.spec.ts` has `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC = 5` with a real
measured-table comment (worst uniform 1, best clustered 12 across all 5 `PLACEMENT_SEEDS` — 5
sits 5x above worst / 2.4x below best). Confirmed still passing this run:

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" --grep "peers cluster around centers" --timeout 60000
```

from `packages/fret/`. Passed. Leave as-is.

## Step 2 — hop statistic for case 2, reached but NOT finished this run

Test: `'clustered placement: inter-cluster routing takes more hops'` (~L347-395 in
`test/message-bus.spec.ts`). Ran this run:

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" --grep "inter-cluster routing takes more hops" --timeout 60000
```

from `packages/fret/`. Result: **passed**, but margin is thin:

```
clustered: avgRoutingHops 1, successfulRouteHops avg 1
uniform: avgRoutingHops 0.9, successfulRouteHops avg 0.9
```

10 routing attempts each, all 10 succeeded both times (so `avgRoutingHops` ==
`successfulRouteHops` average in this run — they only diverge when some attempts fail). The gap
is 10 total hops vs 9 total hops across 10 routes — i.e. exactly one route differing by one hop.
Unlike step 1 (which was checked across all 5 `PLACEMENT_SEEDS` and showed a clean worst-case/
best-case gap), **this test uses only one hardcoded seed (`seed: 42`) and was not checked for
robustness across seeds this run** — budget ran out before that check happened. A single-seed,
one-hop margin is exactly the kind of thing that can flip on unrelated changes or different seeds,
so do not treat this run's single green result as confirmation that the check is real.

**Next agent, do this:**

1. Write a throwaway script (scratchpad, not committed) that runs the same `avgHopsFor` logic
   from the test (lines ~348-390) across `PLACEMENT_SEEDS` (or several arbitrary seeds) instead of
   the single hardcoded `seed: 42`, and prints `clustered` vs `uniform` avgRoutingHops per seed —
   mirroring exactly what step 1's diagnostic run already proved out for the other test.
   - Note `n: 30, k: 15` in this test means half the ring is in-cluster, which is a weak setup for
     hop-count discrimination (most routes complete in 0-1 hops) — that may be *why* the margin is
     thin, not a fluke of seed 42 specifically.
2. **If separation holds cleanly across seeds** (clustered consistently > uniform, comfortable
   margin, not 1-vs-0 flukes): the test is fine as shipped — leave the code untouched, just note in
   the review ticket (see Handoff below) that the margin was checked and is real, with the numbers.
3. **If it does not hold** (flips sign on some seeds, or margin is inconsistently 0-1 hops): follow
   the original plan —
   - First try returning `successfulRouteHops` average instead of `metrics.avgRoutingHops`
     (already computed in the log line) as the returned/asserted statistic; add a one-line comment
     saying why, mirroring the `successfulRouteHops` doc comment in `sim-metrics.ts`; re-run across
     seeds again.
   - If **neither statistic separates**: the target loop (`target[j] = (seed * (j + 1) * 37) &
     0xff`) is not landing targets across cluster boundaries. Read `test/simulation/placement.ts`
     for where cluster centers come from (`clusterConfig: { numClusters: 3, spreadBits: 32 }`) and
     aim each target near a *different* cluster (e.g. bucket by `i % numClusters`). **Do not ship
     the case unseparating.** This is real investigation — if budget is short again, split it into
     its own follow-up ticket rather than rushing it.

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
