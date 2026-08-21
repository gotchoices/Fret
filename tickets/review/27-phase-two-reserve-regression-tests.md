description: New tests prove a stalled or unresponsive near neighbor can no longer eat a whole background maintenance cycle, and both tests are confirmed to catch the bug they were written for.
files: packages/fret/test/stabilize-concurrency.spec.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/neighbors.ts
---

## What shipped

Three new cases in `packages/fret/test/stabilize-concurrency.spec.ts`, under a
`// ----- phase-2 reserve -----` section right after the headline-regression case (file-header
bullet list updated to match):

- `Core: a near peer that stalls its snapshot fetch does not cost phase 2 its turn, tick after
  tick`
- `Edge: ...` (same body via shared `expectPhaseTwoKeepsItsTurn()` helper)
- `a near peer whose ping never answers is not snapshot-fetched at all`

No production code changed — this ticket is tests only. Both new mechanisms were already live in
`fret-service.ts` from prior work; this ticket's job was proving they hold and handing off.

## Both cases confirmed to bite (flip-the-fix, run, restore — done for each)

**Case 1 — phase-1 snapshot timeout.** Removed line 2634's
`timeoutMs: FretService.MAINTENANCE_SNAPSHOT_TIMEOUT_MS` from the `fetchNeighbors` call inside
`fetchAndMergeSnapshot`. Result: both Core and Edge case-1 tests failed. Failure shape was more
informative than a simple "runs to full 5000ms timeout" guess: with the per-call override gone,
`fetchNeighbors` falls back to the route-sized `RPC_TIMEOUT_MS` (5000ms) — which *exceeds* phase
1's own `STABILIZE_PHASE_ONE_BUDGET_MS` sub-budget (3000ms) — so phase 1 now truncates on **its
own** budget (measured wall time ≈3000–3013ms) rather than running the stalled fetch out to its
full timeout. Either way, the mechanism the test exists to catch is present: phase 1 no longer
ends on the intended 1000ms snapshot-timeout floor, so its budget accounting and the phase-2
reserve arithmetic are off from what the shipped constants promise. Restored; tree confirmed
clean before and after.

**Case 2 — the `!answered` gate.** Removed line 2323's `if (!answered) return [];` inside
`probeAndFetch`. Result: test failed. Assertion expected the protocol list to be `["…/ping"]`
only (no fetch attempted after an unanswered ping) but got `["…/ping", "…/neighbors"]` — i.e.
with the gate gone, a near peer whose ping never answers still gets its snapshot fetched, wasting
up to `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` of phase-1 wall time on a fetch that could only fail too.
Restored; tree confirmed clean before and after.

Neither flip was left in the tree at any point — each was done as a single chained shell
invocation (flip → test → `git checkout --` restore → `git status --short` to confirm clean), so
an interrupt between steps was never possible.

## Division of labour — read this before touching either constant

At today's constants, the phase-1 sub-budget (`STABILIZE_PHASE_ONE_BUDGET_MS` = 3000) is
belt-and-braces, not the load-bearing fix: a phase-1 task is a ping (capped at
`MAINTENANCE_RPC_TIMEOUT_MS` = 2000) chained to a fetch (capped at
`MAINTENANCE_SNAPSHOT_TIMEOUT_MS` = 1000), so one task costs ~3000ms at worst regardless of how
many near peers stall — phase 1's wall clock is already bounded without the sub-budget doing
anything. **The snapshot timeout is the load-bearing change for this regression.** The sub-budget
is what keeps the guarantee true *if* either RPC timeout is ever raised later, and that inequality
is already pinned separately by `test/stabilize-budget-invariants.spec.ts`. Say this plainly
because case 1's failure mode (phase 1 truncating on its own sub-budget once the snapshot timeout
override was removed) could be misread as "case 1 pins the sub-budget" — it does not; it happens
to trip the sub-budget as a side effect of losing the primary guard.

## Full suite

`yarn test` from `packages/fret/`, foreground, no redirection:

```
1217 passing (4m)
```

Zero failing, zero pending, no errors in output. `test/mocha-exit-watchdog.ts` did not report any
handle held open at exit, so no timer leak from the two `deadline()` handles now live per tick.

## What a reviewer should treat as a floor, not a finish line

- Only the two flipped lines were verified to make their respective test fail. No other mutation
  testing was done against the surrounding logic (e.g. the exact sub-budget/tick-budget numbers,
  the disjointness of the four candidate sets) — those are covered by pre-existing specs
  (`test/stabilize-budget-invariants.spec.ts`, the disjointness case in
  `test/stabilize-concurrency.spec.ts`) that were not touched or re-audited this round beyond
  confirming they still pass in the full suite run above.
- The existing high-water-mark assertion (pool concurrency *equals* the cap) and the
  four-candidate-set disjointness assertion were not individually re-verified in isolation this
  round — only as part of the full 1217-passing run.
- Type-check (`npx tsc --noEmit`) was run clean in an earlier session on this ticket (not
  re-verified this run, but nothing has touched typed surface since — only test-file additions
  land in this diff, and the full suite compiling and running is sufficient evidence).
