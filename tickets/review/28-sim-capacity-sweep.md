---
description: Measured how small each simulated peer's memory limit has to be before test routes take several hops instead of arriving immediately, and wrote the resulting number into the follow-up ticket that needs it.
files: tickets/implement/28.5-sim-metric-guard-case.md, packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation.routing.spec.ts
difficulty: easy
---

Phase B of `sim-relevance-scoring` (phase A landed in `28.5-sim-metric-guard-case` under
`## Measured inputs`). This was a **measurement-only** ticket: it changed no shipped code and no
test. Its whole output is the capacity number, now recorded in `28.5-sim-metric-guard-case.md`.

## What changed in the tree

- `tickets/implement/28.5-sim-metric-guard-case.md` — the `capacity: not yet measured` bullet is
  replaced by the sweep table, the chosen number, the runtime cost, and the bite-headroom note.

**Nothing else.** No `packages/` file was touched, so `yarn test` was not run — per the source
ticket's "Tests expected" section, which said measurement changes no shipped code and the full
suite may be skipped. The reviewer should treat "the suite is green" as **unverified by this
ticket**; the last run of it belongs to whichever ticket last touched `packages/`.

## The answer

**`capacity: 24` on the n=1000 all-edge ring** (`profileMix: { edge: 1, core: 0 }`, k 15, m 8,
`churnRatePerSec: 0`, 4 s convergence, 100 routes). Across seeds 1 / 4242 / 99 / 20260820:
knowledge 2.4%, success 99–100%, p90 hops 12–15, max 17–23.

Smallest capacity clearing all three of the source ticket's criteria on every seed:
knowledge fraction in low single-digit percent, p90 ≥ 3, success ≥ 95%.

## How it was measured

The source ticket's throwaway driver (`sweep` mode) run from `packages/fret` as
`node --import ./register.mjs <scratchpad>/measure.mjs sweep 17` then `... sweep 20,24,28,32,40,48`.
Its `measureRouting` / `pump` / `baseConfig` / `CONVERGE_MS` / `ROUTE_COUNT` are verbatim copies
from `test/simulation.routing.spec.ts`. **The script has been deleted**, as the ticket required.
Raw output is at `tickets/.logs/28-sim-capacity-sweep.log` (git-ignored, auto-pruned) — it is a
convenience, not a deliverable; the table below is the record.

Per-cap min/max across the four seeds (each store saturates at the cap, so knowledge = cap/n):

| cap | n=200 know | n=200 succ | n=200 p90 | n=1000 all-edge know | n=1000 succ | n=1000 p90 |
|---|---|---|---|---|---|---|
| 17 |  8.5% | 100%     | 11–12 | 1.7% | 40–52%   | 19–21 |
| 20 | 10.0% | 100%     |  6–7  | 2.0% | 89–97%   | 15–19 |
| 24 | 12.0% | 100%     |  4–5  | 2.4% | 99–100%  | 12–15 |
| 28 | 14.0% | 100%     |  3–4  | 2.8% | 98–100%  |  9–12 |
| 32 | 16.0% | 100%     |  3    | 3.2% | 100%     |  7–8  |
| 40 | 20.0% | 100%     |  2–3  | 4.0% | 100%     |  6–7  |
| 48 | 24.0% | 100%     |  2–3  | 4.8% | 100%     |  4–6  |

Phase A's single-seed numbers (recorded in the source ticket as a starting point, not an answer)
are reproduced exactly by this sweep at cap 32 seed 4242 — n=200 100%/p90 3 and n=1000 100%/p90 8
— which is the one cross-check available that the driver's `sweep` mode agrees with its already-run
`spread` mode.

## Judgement calls the reviewer should check

- **Which ring the number belongs to.** The driver sweeps two cases and the decision rule says
  "across all four seeds" without naming a case. The knowledge criterion resolves it: at n=200 the
  store saturates at `capacity / 200`, so knowledge cannot fall below 8.5% for any capacity at or
  above the 17-id protection floor (`2·max(2, m) + 1` at m 8), and the three criteria are jointly
  satisfiable only on the n=1000 ring. I took that as the rule selecting the ring rather than as an
  unsatisfiable rule. **If the reviewer reads it the other way**, the n=200 answer under the two
  remaining criteria is capacity 28 (p90 3–4, success 100% on all four seeds) — also recorded in
  28.5, so the follow-up ticket can take either without re-measuring.
- **Margin vs. the "smallest" instruction.** Capacity 24 sits 4 points above the 95% success floor,
  and the cliff is one sweep step below it (cap 20 → 89% on seed 20260820). The rule said smallest,
  so 24 is what I recorded; capacity 32 is the conservative alternative (100% success on every
  seed, p90 7–8, still far above the p90 ≥ 3 requirement) and is in the table if the guard's author
  prefers margin over bite.
- **The sweep grid is coarse below 24.** Steps of 4 between 20 and 32; capacities 21/22/23 were
  never run, so "smallest" means smallest *on this grid*. Given the 89% → 99% jump between 20 and
  24, a finer grid could plausibly find 22 or 23 also clearing the bar. I did not run it — the
  follow-up needs a number that clears the bar, not the infimum.

## Validation the reviewer can run

Re-running is the only validation there is; the sim is deterministic per seed, so any repeat must
reproduce the table exactly. Recreate the driver from the `## The driver` section of the source
ticket — it is preserved in `tickets/complete/` history and in `28.5`'s prereq chain — or drive the
same config directly:

```
cd packages/fret
# in a scratch .mjs, with measureRouting copied from test/simulation.routing.spec.ts:
#   measureRouting(baseConfig({ n: 1000, profileMix: { edge: 1, core: 0 }, capacity: 24, seed }))
# for seed of 1 / 4242 / 99 / 20260820
```

Expect success 99–100% and p90 12–15 on every seed. One n=1000 run costs ≈ 11 s wall.

## Known gaps

- **No test guards this number.** That is `28.5-sim-metric-guard-case`'s job by design; until it
  lands, the capacity is a measurement in a ticket, not an invariant in the tree.
- **`yarn test` was not run** (see above) — deliberate, per the source ticket, but it means this
  ticket contributes no evidence about suite health.
- **Only the `sweep` mode of the driver was exercised.** Its `spread` mode was already verified in
  phase A; `all` mode was never run.
- **`churnRatePerSec: 0` throughout.** The chosen capacity says nothing about behavior under churn,
  and the follow-up guard should not assume it transfers.
- **The bite claim is inferential, not measured here.** "A worse metric has somewhere to fail" rests
  on the success cliff at cap 17–20 showing the attempt budget is near-binding at cap 24. The
  actual metric substitution (`clockwiseDistance` / XOR) was **not** run at the chosen capacity —
  that is explicitly `28.5`'s "must bite" step, and it remains genuinely open. If it turns out not
  to bite at cap 24, the table above gives every neighbouring capacity's numbers to move to.
