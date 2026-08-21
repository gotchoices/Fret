description: New tests prove a stalled or unresponsive near neighbor can no longer eat a whole background maintenance cycle; this review pass is partly done and needs finishing.
files: packages/fret/test/stabilize-concurrency.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: medium
---

<!-- resume-note -->
A prior review run stopped on a `BUDGET_WARNING` before finishing. No log file was written and
**no files were changed** — the run was read-only. Nothing is half-applied; the working tree is
as the implement stage left it. Resume from "What is still to do" below.

## What the implement stage actually shipped

Seven commits carry the slug; **only `a16af9d7` touches code** — `+80` lines in
`packages/fret/test/stabilize-concurrency.spec.ts` and nothing else. The other six are edits to
the ticket file itself. So the whole review surface is those 80 test lines plus whatever
production code and docs they should have dragged along. Confirm with:

```
git show a16af9d7 -- packages/fret/test/stabilize-concurrency.spec.ts
```

The three new cases sit under a `// ----- phase-2 reserve -----` heading after the headline
regression case:

- `Core: a near peer that stalls its snapshot fetch does not cost phase 2 its turn, tick after tick`
- `Edge: …` — same body, via a shared `expectPhaseTwoKeepsItsTurn()` helper
- `a near peer whose ping never answers is not snapshot-fetched at all`

## What the first review pass covered

Read with fresh eyes, before the handoff summary: the full diff, the shared harness
(`test/helpers/maintenance-rig.ts`), and the spec's file-header comment block. No production
file was re-read in depth; the relevant symbols were located but not audited
(`stabilizeOnce` ~2234, `nearProbeTargets` ~2296, `probeAndFetch` ~2313, `phaseTwoTargets`
~2409, `fetchAndMergeSnapshot` ~2626 in `src/service/fret-service.ts`).

Nothing was fixed and nothing was filed. Everything below is an **unverified observation** to
re-check, not a finding.

## Observations to re-check (none confirmed)

- **The wall-clock assertion may not discriminate.** `expectPhaseTwoKeepsItsTurn()` asserts
  `expect(elapsed).to.be.at.most(3000)` — but 3000 is also exactly the phase-1 sub-budget, so a
  tick that truncates on the sub-budget instead of ending on the 1000 ms snapshot timeout lands
  right on the boundary. The handoff itself reports that the deliberate mutation produced
  measured wall times of ~3000–3013 ms, i.e. the test failed by ~13 ms. That is a thin margin
  for a timing assertion running at real, unmutated constants on shared CI hardware. Consider
  whether a tighter bound (the expected cost is ~1.1 s) would bite decisively without becoming
  flaky, or whether the case should assert on something other than wall time.
- **Both label re-poses between ticks are load-bearing and worth a second look.** The helper
  calls `store.setMembership(unknown!, 'unknown')` and `store.update(dead!, { state: 'dead' })`
  between tick 1 and tick 2, because tick 1's successful probes promote both peers to live
  members and they would otherwise be drawn into the *near* list on tick 2 (a different
  question). The comment says this; check the reasoning holds and that the second tick really
  still exercises the phase-2 arms rather than something adjacent.
- **Profile teardown ordering.** The Edge case calls `teardown()` then `build('edge')` inside
  the test body while `afterEach(teardown)` is also registered. Looked correct on reading
  (`harness` is reassigned, so `afterEach` tears down the Edge harness and the Core one was
  already stopped) — confirm rather than assume, and check no rig state leaks between the two.

## What is still to do

- Audit the production code these tests claim to pin — `probeAndFetch`'s `!answered` gate, the
  `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` override in `fetchAndMergeSnapshot`, the phase-1 sub-budget
  wiring in `stabilizeOnce` — with fresh eyes, not through the handoff's account of them.
- Judge test coverage as a floor: the implementer verified exactly two mutated lines. Consider
  error paths and interactions the three cases do not reach (a near peer answering `busy`; a
  phase-1 that truncates on the *tick* budget rather than its own; phase 2 finding no targets).
- Source hygiene on the diff: `stabilize-concurrency.spec.ts` is now 428 lines; comment density
  in the new block is high relative to the surrounding file — judge whether it earns its place.
- **Docs.** `docs/fret.md` already describes both mechanisms (the *Two phases* bullet under
  *Stabilization and churn handling* names the phase-1 sub-budget, the reserve arithmetic and
  the "ping did not answer → no fetch" rule). Verify it names the new cases where it lists what
  `test/stabilize-concurrency.spec.ts` pins, and that nothing there is now stale.
- Run the gate in the foreground with no redirection: `cd packages/fret && yarn test` (the
  implementer reported `1217 passing (4m)`) and `npx tsc --noEmit`. There is no lint step in
  this repo — `yarn check` (typecheck + build + test) is the gate, and `yarn format` /
  `yarn format:check` must **not** be run (see AGENTS.md).
- Produce the `complete/` ticket with a `## Review findings` section: what was checked, what was
  found, what was done. Empty categories stated explicitly with a reason.

## Handoff claims worth keeping (from the implement stage)

- Both new mechanisms were already live in `fret-service.ts` from the prior
  `tick-budget-starves-phase-two` work; this ticket is tests only, no production change.
- Each case was flip-the-fix verified: removing `timeoutMs:
  FretService.MAINTENANCE_SNAPSHOT_TIMEOUT_MS` from the `fetchNeighbors` call failed both case-1
  tests; removing `if (!answered) return [];` from `probeAndFetch` failed case 2. Each flip was
  a single chained shell invocation ending in a restore, so nothing was left in the tree.
- The implementer's own stated division of labour: at today's constants the snapshot timeout is
  the load-bearing guard and the phase-1 sub-budget is belt-and-braces (a phase-1 task is a
  2000 ms ping chained to a 1000 ms fetch, so ~3000 ms at worst regardless of how many peers
  stall). The sub-budget only starts earning its keep if either RPC timeout is raised later, and
  that inequality is pinned separately by `test/stabilize-budget-invariants.spec.ts`. Case 1
  tripping the sub-budget under mutation is a side effect of losing the primary guard, not
  evidence that case 1 pins the sub-budget.
