description: New tests prove a stalled near neighbor can no longer eat a whole background maintenance cycle; the review pass has confirmed the code is correct and has one test-quality fix left to apply and verify.
files: packages/fret/test/stabilize-concurrency.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: medium
---

<!-- resume-note -->
Two prior review runs each stopped on a `BUDGET_WARNING`. **No files have been changed in either
run** — both were read-only, nothing is half-applied, the working tree is as the implement stage
left it. This run completed the production-code audit that the first run deferred. Resume from
"What is still to do".

## The review surface

Seven commits carry the slug; **only `a16af9d7` touches code** — `+80` lines in
`packages/fret/test/stabilize-concurrency.spec.ts`, nothing else. Three new cases under a
`// ----- phase-2 reserve -----` heading (two share an `expectPhaseTwoKeepsItsTurn()` helper —
Core and Edge; the third is the "ping never answered → no fetch" case).

```
git show a16af9d7 -- packages/fret/test/stabilize-concurrency.spec.ts
```

## What has been checked and is settled — do not redo

- **The full diff, the shared harness (`test/helpers/maintenance-rig.ts`), and the spec's header
  comment block**, read with fresh eyes before the handoff summary.
- **The production code the tests claim to pin — audited directly, not through the handoff.**
  `stabilizeOnce` (~2234), `nearProbeTargets` (~2296), `probeAndFetch` (~2313),
  `probeNeighborLatency` (~2341), `phaseTwoTargets` (~2409), `fetchAndMergeSnapshot` (~2626) in
  `src/service/fret-service.ts`. All three mechanisms are present and correct as documented:
  phase 1 runs under a `deadline(STABILIZE_PHASE_ONE_BUDGET_MS, budget.signal)` child with a
  mandatory `cancel()` in a `finally`; phase 2 tests the **tick** signal and never phase 1's;
  `enforceCapacity` and the announce sit above phase 2's early return; `probeAndFetch`'s
  `wasCancelled` check sits ahead of the `!answered` gate so the two cannot disagree; the
  `timeoutMs: MAINTENANCE_SNAPSHOT_TIMEOUT_MS` override is on the `fetchNeighbors` call.
  **No production finding. This ticket has no production-code arm.**
- **The two label re-poses between ticks are correct and load-bearing.** Tick 1's phase-2 pings
  succeed, so `probeMembership` promotes the `unknown` peer to `member` and clears the `dead`
  peer's contact-failure run — both become live members and would be drawn into the *near* list on
  tick 2, where they are pinged *and* fetched, which is a different question. Re-posing makes tick 2
  ask the same question. Neither peer is left in backoff (backoff is recorded on failure only), so
  both are genuinely off-backoff selectable on tick 2.
- **Profile teardown ordering in the Edge case is correct.** `harness` is reassigned by `build`,
  so `afterEach(teardown)` tears down the Edge harness while the Core one was already stopped by
  the in-body `teardown()`; that same call restores the `STABILIZE_TICK_BUDGET_MS` static. No rig
  state leaks between the two.

## The one finding — minor, fix in this pass

**`expectPhaseTwoKeepsItsTurn()`'s wall-clock assertion does not discriminate, and is thin.**

```ts
expect(elapsed, 'phase 1 ended on the snapshot timeout, inside its own sub-budget').to.be.at.most(3000)
```

3000 is *exactly* `STABILIZE_PHASE_ONE_BUDGET_MS`. Remove the snapshot-timeout override and the
fetch falls back to the 5000 ms route-sized default, so phase 1 is cut by its own sub-budget at
3000 ms and the tick lands at ~3000–3013 ms — the assertion fails by ~13 ms, which is what the
implementer measured. That is a timing assertion whose entire discriminating power is ~13 ms on
shared CI hardware.

Note the behavioral assertions in the same helper still **pass** under that mutation (phase 2 does
get its turn — that is what the sub-budget buys), so this wall-clock bound is the *only* thing
pinning the snapshot-timeout half. It has to bite decisively.

The unmutated cost is ~1.05 s (the ping answers instantly against the stub; the fetch hangs to the
1000 ms `MAINTENANCE_SNAPSHOT_TIMEOUT_MS`; phase 2's two stub pings are instant). **Recommended
fix: `at.most(2000)`** — ~2x margin over the real cost, ~1000 ms of discrimination against the
mutation, and it asserts what the message already claims ("ended on the 1000 ms snapshot timeout,
*not* on the 3000 ms sub-budget"). Update the message if it needs to name the tighter number.

Verify before handing off: run the spec unmutated (must pass with room), then flip the fix —
remove `timeoutMs: FretService.MAINTENANCE_SNAPSHOT_TIMEOUT_MS` from the `fetchNeighbors` call in
`fetchAndMergeSnapshot`, confirm both cases fail, restore in the same chained shell invocation so
nothing is left in the tree.

## What is still to do

- Apply and verify the `at.most(2000)` fix above.
- **Judge coverage as a floor.** Cases *not* reached by the three new tests, to weigh (file only
  what is genuinely worth a ticket; the rest is a note or nothing):
  - a near peer answering `busy` — `probeNeighborLatency` returns `answered: true` for it, so the
    fetch proceeds. The rig's stub only ever replies `{ok: true}` to a ping, so exercising this
    needs a new rig behavior. Check whether `test/failure-recovery.spec.ts` already pins the busy
    arm before deciding it is a gap.
  - the "ping never answers" case asserts no fetch but not the contact strike the timeout leaves.
  - phase 1 truncating on the *tick* budget rather than its own, and phase 2 finding no targets,
    are both already exercised by the headline regression case above the new block — not gaps.
- **Source hygiene on the diff.** `stabilize-concurrency.spec.ts` is now 428 lines
  (`wc -l`); comment density in the new block is high relative to the surrounding file. Judge
  whether it earns its place.
- **Docs.** `docs/fret.md` already describes both mechanisms correctly (the *Two phases* bullet
  under *Stabilization and churn handling* names the phase-1 sub-budget, the 5000 − 3000 = 2000 ms
  reserve arithmetic, and the "ping did not answer → no fetch" rule). What is unverified: whether
  it names the new cases where it lists what `test/stabilize-concurrency.spec.ts` pins, and
  whether anything there is now stale.
- **Run the gate in the foreground with no redirection**: `cd packages/fret && yarn test` (the
  implementer reported `1217 passing (4m)`) and `npx tsc --noEmit`. No lint step exists — `yarn
  check` (typecheck + build + test) is the gate, and `yarn format` / `yarn format:check` must
  **not** be run (see AGENTS.md).
- Produce the `complete/` ticket with a `## Review findings` section: what was checked, what was
  found, what was done. Carry the "settled" list above into it — the production audit found
  nothing, and that must be stated explicitly with its reason, not left silent.

## Handoff claims from the implement stage, now corroborated by the audit

- Both mechanisms were already live in `fret-service.ts` from the prior
  `tick-budget-starves-phase-two` work; this ticket is tests only, no production change. **Confirmed
  by reading the code.**
- Each case was flip-the-fix verified by the implementer, each flip a single chained shell
  invocation ending in a restore.
- At today's constants the snapshot timeout is the load-bearing guard and the phase-1 sub-budget is
  belt-and-braces (a phase-1 task is a 2000 ms ping chained to a 1000 ms fetch, so ~3000 ms at
  worst regardless of how many peers stall). The sub-budget only starts earning its keep if either
  RPC timeout is raised later; that inequality is pinned separately by
  `test/stabilize-budget-invariants.spec.ts`. Case 1 tripping the sub-budget under mutation is a
  side effect of losing the primary guard, not evidence that case 1 pins the sub-budget — which is
  precisely why the wall-clock bound must be tightened rather than left at the sub-budget's value.
