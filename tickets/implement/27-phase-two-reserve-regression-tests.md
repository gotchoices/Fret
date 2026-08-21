description: Two tests that prove a stalled neighbour can no longer eat a whole background maintenance cycle are now written and green; what is left is proving they would actually fail against the old code, running the full test suite, and handing the work to review.
files: packages/fret/test/stabilize-concurrency.spec.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/neighbors.ts, tickets/.logs/
difficulty: easy
---

<!-- resume-note -->
Prior run stopped on a BUDGET_WARNING again, this time **after** confirming case 1 and cleanly
restoring the tree. Resume from case 2 — do not re-run case 1, it is done.

**Confirmed this run: `fetchNeighbors`'s `timeoutMs` fallback.** `rpcRequest`
(`packages/fret/src/rpc/request.ts:245`) does `const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS`
— confirms the route-sized 5000ms default from `src/rpc/protocols.ts:27`, as the prior handoff
predicted.

**Confirmed this run: case 1 bites.** One chained shell invocation (sed delete line 2634 → run
both Core/Edge case-1 specs via `--grep "does not cost phase 2 its turn"` → `git checkout --
src/service/fret-service.ts` → `git status --short` to prove clean) —

- Before flip: `git status --short src/service/fret-service.ts` empty (confirmed clean, safe to
  use `git checkout --` as the restore).
- Flipped: deleted line 2634 (`timeoutMs: FretService.MAINTENANCE_SNAPSHOT_TIMEOUT_MS,`) from the
  options object passed to `fetchNeighbors` inside `fetchAndMergeSnapshot`.
- Result: **both Core and Edge case-1 tests failed**, i.e. the case bites. Actual failure shape
  was more informative than the ~5000ms-vs-1000ms guess: with the per-call override gone,
  `fetchNeighbors` falls back to the route-sized 5000ms, which *exceeds* phase 1's own
  `STABILIZE_PHASE_ONE_BUDGET_MS` (3000ms) sub-budget — so phase 1 now truncates on **its own**
  budget (assertion measured phase-1 wall time ≈3000–3013ms) rather than running the stalled fetch
  out to its full timeout. Either way the mechanism the test exists to catch is present: phase 1
  no longer ends on the intended 1000ms snapshot-timeout floor, so its budget accounting and
  phase-2 reserve arithmetic are off from what the shipped constants promise. This is *stronger*
  evidence for the fix than the originally-guessed failure mode, not weaker — say so plainly in
  the review handoff rather than restating the original (slightly wrong) prediction.
- After restore: `git status --short src/service/fret-service.ts` empty again — confirmed clean,
  tree is exactly as it was before the flip. The fix (line 2634) is back in place.

**Not yet done: case 2's flip.** Same one-shot pattern, not yet attempted this run:
1. `git status --short packages/fret/src/service/fret-service.ts` — confirm clean before flipping
   (expected: clean, nothing else has touched this file).
2. `sed -i '2323d' packages/fret/src/service/fret-service.ts` — deletes
   `if (!answered) return [];` inside `probeAndFetch`, so an unanswered ping no longer skips the
   snapshot fetch.
3. Run: `node --import ./register.mjs node_modules/mocha/bin/mocha.js
   "test/stabilize-concurrency.spec.ts" --timeout 30000 --grep "never answers is not
   snapshot-fetched at all"` (from `packages/fret/`).
4. `git checkout -- src/service/fret-service.ts` then `git status --short
   src/service/fret-service.ts` to confirm clean restore, chained in the **same** shell invocation
   as steps 2–3 with `;` so an interrupt cannot separate flip from restore (same rule case 1
   followed, and it worked cleanly).

Expect the test to fail while flipped (the point is proving it currently passes only because of
the `!answered` gate) and pass again once restored — don't stop to puzzle over the exact failure
shape, just record what it was, the way case 1's writeup above does.

**Then, in order:** `yarn test` from `packages/fret/` (foreground, no redirection — not run this
run either); write the review handoff into `tickets/review/` (fold in both case findings above,
plus the phase-1/phase-2 division-of-labour point from the original ticket body below — it is
still accurate and unchanged); delete this ticket.
<!-- /resume-note -->

## What landed earlier (do not redo)

The two regression cases the ticket asked for are **written, type-checked and passing**, in
`packages/fret/test/stabilize-concurrency.spec.ts` under a `// ----- phase-2 reserve -----`
section placed immediately after the headline-regression case. The file-header bullet list has
the two new properties. Nothing else in the tree has changed across any run of this ticket so far.

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

Last measured (from an earlier run, not this one — re-verify if in doubt), from `packages/fret/`:

```
npx tsc --noEmit                                  # clean
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/stabilize-concurrency.spec.ts" --timeout 30000
# 16 passing (7s) — the 3 new cases at 2024ms / 2020ms / 2004ms
```

## What is left

**Confirm each case bites.** The fix is already committed, so the evidence comes from temporarily
undoing the one line each case depends on, running that case, and putting it back. This must be
done as the flip and the restore in **one shell invocation** so an interrupt cannot separate them
— e.g. sed the line out, run mocha with `--grep`, sed it back, all chained with `;` in a single
command. This was deliberately not attempted across two prior runs now (once killed mid-plan by
context pressure, once stopped by budget warning before starting) — both times specifically to
avoid leaving the shipped fix reverted in the working tree.

- **Case 1's line** is the `timeoutMs: FretService.MAINTENANCE_SNAPSHOT_TIMEOUT_MS` on the
  `fetchNeighbors` call inside `fetchAndMergeSnapshot` (`src/service/fret-service.ts:2634`).
  Removing it falls back to the route-sized `RPC_TIMEOUT_MS` (5000), so the stalled fetch outruns
  the 5000ms tick budget, phase 2 hits its `budget.signal.aborted` early return, and the phase-2
  peers are never opened. Confirm the fallback value by reading `fetchNeighbors`'s options
  handling (`src/rpc/neighbors.ts:102`) first — see resume-note above.
- **Case 2's line** is `probeAndFetch`s `if (!answered) return [];` gate
  (`src/service/fret-service.ts:2323`).
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
  four-candidate-set disjointness assertion should still pass (verified in an earlier, not this,
  run) — keep them that way.

## TODO

- Confirm case 1 bites, via the `fetchNeighbors` `timeoutMs` flip; flip and restore in one shell
  invocation.
- Confirm case 2 bites, via the `!answered` gate flip; same single-invocation rule.
- `yarn test` from `packages/fret/`, foreground, no redirection.
- Write the review handoff (including the two points above) into `tickets/review/` and delete this
  ticket.
