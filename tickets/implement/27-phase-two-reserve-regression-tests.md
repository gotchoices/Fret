---
description: Two tests that prove a stalled neighbour can no longer eat a whole background maintenance cycle are now written and green; what is left is proving they would actually fail against the old code, running the full test suite, and handing the work to review.
files: packages/fret/test/stabilize-concurrency.spec.ts, packages/fret/src/service/fret-service.ts, tickets/.logs/
difficulty: easy
---

## What landed this run (do not redo)

The two regression cases the ticket asked for are **written, type-checked and passing**, in
`packages/fret/test/stabilize-concurrency.spec.ts` under a new `// ----- phase-2 reserve -----`
section placed immediately after the headline-regression case. The file-header bullet list gained
the two new properties. Nothing else in the tree changed (`git status` also shows the untracked
`tickets/.in-progress`, which is not ours).

Three cases, not two — case 1 is run under both profiles:

- `Core: a near peer that stalls its snapshot fetch does not cost phase 2 its turn, tick after tick`
- `Edge: ...` (same body via the shared `expectPhaseTwoKeepsItsTurn()` helper; teardown + rebuild
  on `edge`, matching the existing Edge pool-cap case)
- `a near peer whose ping never answers is not snapshot-fetched at all`

Design decisions already made and worth not relitigating:

- Both run at the **real, unmutated budgets** (no `setTickBudget`) — the point is the arithmetic
  between the shipped constants.
- Case 1 re-poses the two phase-2 labels between the two ticks (`store.setMembership(unknown,
  'unknown')`, `store.update(dead, { state: 'dead' })`). Without that, tick 1s successful probes
  promote both peers into the near list and the tick-2 assertion measures promotion instead.
- Per-case `this.timeout(20000)` with `function` callbacks (arrows have no `this`), as insurance
  on a slow CI box.

Measured, ran from `packages/fret/`:

```
npx tsc --noEmit                                  # clean
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/stabilize-concurrency.spec.ts" --timeout 30000
# 16 passing (7s) — the 3 new cases at 2024ms / 2020ms / 2004ms
```

A tick costs ~1.0s (phase 1 ends on `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` = 1000ms, well inside its
own 3000ms sub-budget), so case 1s two ticks are ~2.0s. That is the measured cost, replacing the
~1.1s-per-tick estimate an earlier run predicted.

## What is left

**Confirm each case bites.** The fix is already committed, so the evidence comes from temporarily
undoing the one line each case depends on, running that case, and putting it back. This was
deliberately **not** attempted last run: a run killed between the flip and the restore leaves the
shipped fix reverted in the working tree, which is worse than an unproven test. Do the flip and
the restore in **one shell invocation** so an interrupt cannot separate them, e.g. sed the line
out, run mocha with `--grep`, sed it back, all chained with `;` in a single command.

- **Case 1s line** is the `timeoutMs: FretService.MAINTENANCE_SNAPSHOT_TIMEOUT_MS` on the
  `fetchNeighbors` call inside `fetchAndMergeSnapshot` (`src/service/fret-service.ts`, grep the
  symbol). Removing it falls back to the route-sized `RPC_TIMEOUT_MS` (5000), so the stalled fetch
  outruns the 5000ms tick budget, phase 2 hits its `budget.signal.aborted` early return, and the
  phase-2 peers are never opened.
- **Case 2s line** is `probeAndFetch`s `if (!answered) return []` gate.
- It is **not** the phase-1 sub-budget signal. Swapping that does not bite, because per-RPC
  timeouts already cap a phase-1 task at ~3000ms — see the handoff finding below.

**Run the full suite.** `yarn test` from `packages/fret/`, foreground, no redirection (the runner
idle timer needs the streaming output). This has not been run since the implementation landed.

**Write the review handoff** into `tickets/review/`, and delete this ticket. Two things belong in
it that a reader will not otherwise reconstruct:

- **Which flip confirmed which case**, stated plainly.
- **The division of labour between the two halves of the fix.** At todays constants the phase-1
  sub-budget (`STABILIZE_PHASE_ONE_BUDGET_MS` = 3000) is belt-and-braces: a phase-1 task is a ping
  (capped at `MAINTENANCE_RPC_TIMEOUT_MS` = 2000) chained to a fetch (capped at
  `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` = 1000), so one task costs ~3000ms at worst and phase 1s wall
  clock is ~3000ms however many near peers stall. The **snapshot timeout is the load-bearing
  change** for this regression; the sub-budget is what keeps the guarantee true if either RPC
  timeout is ever raised, and it is already pinned as an inequality over the declared defaults by
  `test/stabilize-budget-invariants.spec.ts`. Say that, rather than claiming case 1 pins the
  sub-budget — it does not.

## Things to check rather than assume

- **Timer leaks.** Two `deadline()` handles are live per tick now. `test/mocha-exit-watchdog.ts`
  (10s grace, no `--exit`) is the detector — if the full run hangs at the end, that is the signal,
  not a flake.
- The existing high-water-mark assertion (pool concurrency *equals* the cap) and the
  four-candidate-set disjointness assertion still pass — verified in the 16-passing run above; keep
  them that way.

## TODO

- Confirm case 1 bites, via the `fetchNeighbors` `timeoutMs` flip; flip and restore in one shell
  invocation.
- Confirm case 2 bites, via the `!answered` gate flip; same single-invocation rule.
- `yarn test` from `packages/fret/`, foreground, no redirection.
- Write the review handoff (including the two points above) into `tickets/review/` and delete this
  ticket.
