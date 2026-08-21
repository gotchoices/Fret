description: Two simulation tests claimed to prove placement strategies produce different ring shapes but would pass without that behavior; one of the two replacement checks now has a real measured threshold — the other still needs a working check before handoff, then the whole suite needs a run and a review handoff.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/churn-scenarios.spec.ts, packages/fret/test/simulation/placement-assertions.ts, packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation/placement.ts
difficulty: medium
tradeoffs: n/a (implement ticket)
---

Eighth run in this ticket's chain (prior seven: six died re-reading/confirming without writing
the check script, one wrote and ran it but hit BUDGET_WARNING right after getting the result —
this run). **The measurement is now done — do not re-run it.** What's left is a real fix, not
more verification.

## Step 1 — DONE, do not touch

`test/simulation/placement-assertions.ts` exports `coordToBigInt`, `maxPeersInOneSpacingArc`,
`PLACEMENT_SEEDS = [8008, 8009, 8010, 4242, 99]`, `MAX_PEERS_IN_ONE_SPACING_ARC = 7`.
`test/message-bus.spec.ts` L293 `describe('Placement distributions', ...)`; the first test
(`'clustered placement: peers cluster around centers'`, L296-345) has
`CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC = 5` with a measured-table comment and asserts both
directions in a loop over `PLACEMENT_SEEDS`. Correct and complete. Leave alone.

## Step 2 — the actual finding: hop-count separation does not hold, needs a real fix

The second test (`'clustered placement: inter-cluster routing takes more hops'`,
`test/message-bus.spec.ts` L347-395) currently hardcodes `seed: 42` and asserts only
`clustered > uniform` with no margin (L394), `n: 30, k: 15`.

This run measured all 5 `PLACEMENT_SEEDS` (script + exact numbers below — reproducible, not
guessed) with **both** `avgRoutingHops` and `successfulRouteHops` average as the candidate
statistic:

```
seed 8008: clustered avgRoutingHops=1   successAvg=1   attempts=10 | uniform avgRoutingHops=0.9 successAvg=0.9 attempts=10
seed 8009: clustered avgRoutingHops=0.9 successAvg=0.9 attempts=10 | uniform avgRoutingHops=1   successAvg=1   attempts=10
seed 8010: clustered avgRoutingHops=1   successAvg=1   attempts=10 | uniform avgRoutingHops=1   successAvg=1   attempts=10
seed 4242: clustered avgRoutingHops=0.9 successAvg=0.9 attempts=10 | uniform avgRoutingHops=0.9 successAvg=0.9 attempts=10
seed 99:   clustered avgRoutingHops=1   successAvg=1   attempts=10 | uniform avgRoutingHops=0.9 successAvg=0.9 attempts=10
```

**Result: does not separate.** Sign flips across seeds (8008 clustered wins, 8009 uniform wins,
8010/4242 tie, 99 clustered wins) — a coin flip, not a real effect. All 10/10 routes succeed
every time, so `successfulRouteHops` average is numerically identical to `avgRoutingHops` here —
switching statistics buys nothing, contrary to the fallback this ticket's prior notes assumed
would help. **Per the ticket's own decision rule, this means the target-generation approach is
broken and needs the fallback fix, not the seed swap.**

Root cause (inferred, not yet confirmed by reading — next agent should verify): the target
coordinates are synthetic, hashed from `seed` (`target[j] = (s * (j + 1) * 37) & 0xff`) with no
knowledge of where the actual cluster centers landed on the ring. They are not reliably landing
on opposite sides of a cluster boundary, so "clustered" and "uniform" routes end up choosing
similar-length paths by chance.

### The fix this needs

`CoordPlacement.clusterCenters` (`test/simulation/placement.ts` ~L44) is a **private** field with
no getter — cluster centers `clusteredCoord()` draws from are not exposed outside that class. Two
options, in order of preference:

1. **Add a getter/export for cluster centers** (or a way to construct target coordinates near a
   given cluster index) on `CoordPlacement`, and have the check script/test aim each target at
   a *different* cluster (e.g. bucket by `i % numClusters`, using real center coordinates ± small
   offset). This is the clean fix — it makes the test's intent (routes that cross cluster
   boundaries take more hops) actually true of the generated targets.
2. **Fallback if (1) turns out awkward**: after `sim.initialize()` + advancing, read actual peer
   coordinates via `sim.getPeers()` (already clustered per the placement strategy in the
   `clustered` run), and pick one alive peer's coordinate per bucket (`i % numClusters`) as each
   target instead of hashing `seed`. Needs its own re-verification once written — do not assume
   it separates without measuring across all 5 seeds again.

Either way: **re-run the per-seed measurement after the fix**, using the same shape as the
numbers above (all 5 `PLACEMENT_SEEDS`, both `clustered` and `uniform`, `n: 30, k: 15, m: 8,
durationMs: 8000`), and only ship the test with a numeric margin if the separation is clean and
consistent (not 1-vs-0.9 noise) across all 5 seeds. If neither the getter approach nor the
peer-coordinate fallback produces clean separation, that is itself a real finding — write it up
plainly in the next handoff rather than shipping a loosened assertion.

**Do not repeat the "write scratch script → run → delete" cycle from scratch if avoidable** — the
numbers above are already representative of the *current* (broken) target generation; the next
run's job is to change target generation and re-measure, not to re-confirm today's numbers.

TODO:
- Read `test/simulation/placement.ts` `CoordPlacement` class fully (not yet re-read this run —
  confirmed by two runs prior; layout may still have shifted, verify `clusterCenters` field name
  and `clusteredCoord()` still match this description before editing).
- Implement option 1 (preferred) or option 2 above in `test/simulation/placement-assertions.ts`
  (add a shared helper there, mirroring how `maxPeersInOneSpacingArc` already lives there) so both
  the eventual spec and any scratch verification script can import it.
- Update `test/message-bus.spec.ts` L347-395 to use the fixed target generation, assert both
  `clustered > uniform` **and** a numeric margin measured across all 5 `PLACEMENT_SEEDS`, mirroring
  the `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC` pattern from step 1.
- Verify `test/churn-scenarios.spec.ts` edit (from earlier handoffs in this ticket's history) is
  still present and correct — not re-checked this run, no reason to doubt it but flag if it looks
  reverted.
- Gate, both from `packages/fret/`:
  ```
  node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" "test/churn-scenarios.spec.ts" --timeout 60000
  npx tsc --noEmit
  ```
- Write `review/` ticket (slug `sim-placement-guards-no-control`): cover step 1's final measured
  threshold, step 2's fix (which option taken, why), the actual per-seed numbers post-fix that
  justify calling the separation real, and explicitly note the pre-fix numbers above showed no
  separation (so the reviewer understands what changed and why it was necessary). Delete this
  file once the review ticket is written.

## Gitignore / hygiene note

Nothing to commit from this run except this ticket rewrite — the verification script was written
to `test/simulation/seed-check.tmp.ts`, run, and deleted before this handoff; `git status` on
`test/simulation/` is clean.
