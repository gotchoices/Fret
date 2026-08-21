---
description: Measured how small each simulated peer's memory limit has to be before test routes take several hops instead of arriving immediately, and recorded that number for the follow-up test that needs it.
files: tickets/implement/28.5-sim-metric-guard-case.md, tickets/.logs/28-sim-capacity-sweep.log
difficulty: easy
---

Phase B of `sim-relevance-scoring`. Measurement-only: no shipped code, no test, no `packages/`
file touched. The deliverable is a number, recorded in `28.5-sim-metric-guard-case.md` under
`## Measured inputs`.

## Result

**`capacity: 24` on the n=1000 all-edge ring** (`profileMix: { edge: 1, core: 0 }`, k 15, m 8,
`churnRatePerSec: 0`, 4 s convergence, 100 routes). Across seeds 1 / 4242 / 99 / 20260820:
knowledge 2.4%, success 99–100%, p90 hops 12–15, max 17–23. Smallest capacity clearing the source
ticket's three criteria (knowledge in low single-digit percent, p90 >= 3, success >= 95%) on every
seed. Full per-capacity table is in `28.5`.

The ring selection is correct: at n=200 the store saturates at `capacity / 200`, and the 17-id
protection floor (`2*max(2, m) + 1` at m 8) puts the floor at 8.5% — never "low single-digit", so
the three criteria are jointly satisfiable only on the n=1000 ring.

## Review findings

**What was checked.** The implement diff read first, before the handoff. Every number in the
handoff table and in `28.5` was checked line-by-line against the retained raw output
(`tickets/.logs/28-sim-capacity-sweep.log`), including the max-hop column and the phase-A
cross-check (cap 32 seed 4242: n=200 p90 3, n=1000 p90 8 — both present and matching). The
decision rule was re-derived independently and agrees with the chosen capacity and the chosen
ring. Tree hygiene checked: `git status` clean apart from the runner's own `.in-progress`, the
scratch driver is gone as required, and the only artifact left is the git-ignored, auto-pruned
log the handoff names.

**Minor — fixed in this pass (2 findings).** Both are annotations added to `28.5`, since that is
where the next reader meets the number:
- *Cap-17 row is unbacked by the retained log.* The log covers caps 20–48 only; cap 17 came from a
  separate earlier invocation whose output was not kept, so those figures (n=200 p90 11–12, n=1000
  success 40–52%) cannot be reproduced from the artifact. Not a wrong number — an unverifiable one.
  Annotated as indicative-only, and noted that the cliff argument survives without it: the cap-20
  drop to 89% success *is* in the log.
- *The chosen capacity has thin success margin for a shipped assertion.* Cap 24 clears the 95%
  floor by 4 points, and one seed at cap 20 is already at 89%. A guard asserting `success >= 95%`
  at cap 24 is one parameter shift (churn, route count, a different seed set) from flaking, while
  cap 28 (98–100%, p90 9–12) and cap 32 (100%, p90 7–8) sit far above the p90 >= 3 requirement with
  real margin. The handoff framed 32 only as "margin over bite"; the sharper point is flake risk.
  Recommendation recorded in `28.5` for the guard's author to act on.

**Major — none.** The measurement is reproducible from the retained artifact for every capacity it
covers, the arithmetic checks out, and the judgement calls the handoff flagged (which ring; smallest
vs. margin; coarse grid below 24) were each re-derived and found sound. The coarse grid is a stated
limit, not a defect: the follow-up needs a capacity that clears the bar, not the infimum.

**Tripwires — none recorded.** There is no code site to hang one on; every conditional concern here
(does the number transfer under churn, does the metric actually bite at cap 24) is already an
explicit open item in `28.5`'s own body, which is where the next agent will read it.

**Accepted tradeoffs — none encountered.** No `NOTE:` sites were in scope; the diff touches no code.

**Lint and tests — deliberately not run, and this ticket contributes no evidence about suite
health.** The diff changes zero files under `packages/`, so a suite run would be testing whatever
the previous ticket left behind, not this work. There is no lint step in this repo (`yarn check` is
the gate; see AGENTS.md). Stated rather than skipped silently. `28.5` is the ticket that runs the
full suite, since it is the one that touches the tree.

## Known gaps carried forward (all owned by `28.5`)

- No test guards this capacity yet — until `28.5` lands it is a number in a ticket, not an
  invariant.
- `churnRatePerSec: 0` throughout; the capacity says nothing about behavior under churn.
- The bite claim is inferential. That a worse metric actually fails at cap 24 was **not** measured;
  it is `28.5`'s explicit "must bite" step and remains genuinely open. If it does not bite, the
  table gives every neighbouring capacity's numbers to move to.
