---
description: With the simulated peers now scoring relevance for real, measure the score spread and sweep store capacity to pick the constant the follow-up metric-guard ticket needs.
prereq: sim-relevance-scoring-wiring
files: packages/fret/test/simulation/fret-sim.ts, packages/fret/src/store/relevance.ts, packages/fret/test/simulation.routing.spec.ts, tickets/implement/28.5-sim-metric-guard-case.md
difficulty: medium
---

Narrowed from the original `sim-relevance-scoring` (2026-08-21, run 3 hit token budget): the
code changes moved to `sim-relevance-scoring-wiring` (prereq). This ticket is **measurement and
the capacity decision only** — assume the wiring has landed: per-peer `SparsityModel`s, all five
upsert sites scoring with sim time, the `LivenessModel` seam scoring route/sweep contacts, and
production's `2·max(2, m) + 1` protection set in `enforceCapacity`.

## How to measure

Drive `FretSimulation` from a throwaway script (scratchpad, not the repo tree) run with the
loader hook, e.g. from `packages/fret`:
`node --import ./register.mjs <scratchpad>/measure.mjs` — import
`{ FretSimulation }` from `./test/simulation/fret-sim.ts` and read
`sim.getStores()` / `sim.metrics` after `run()`. Use the routing spec
(`test/simulation.routing.spec.ts`) as the reference for config shapes, seeds (1 / 4242 / 99 /
20260820), n=200 and n=1000 cases, and how routes are scheduled/counted. Delete the script when
done.

## Measurements — pick the constant, record both numbers

Expectations below are derived arithmetic, not observations — decide from what you measure.

- **Relevance spread across one peer's store.** Log the stored `relevance` distribution for one
  peer after a capacity-bounded run. Expectation: occupancy piles up at high-x KDE centers
  (bonus ≈ 1.05–1.1) while low-x centers stay sparse (clamped at `sMax` 1.8); that gradient
  makes eviction prefer far peers and keep the near/mid spine.
  - **Decision rule: if every entry still clamps at `sMax`, gossip-fed KDE is not enough.**
    Fallback: raise `alpha` for the sim's model only — a sim-local constant passed to
    `createSparsityModel` at the model-creation site in `fret-sim.ts`, documented there as
    sim-local and why. Do not change the production default in `src/store/relevance.ts`.
- **`capacity`, chosen so routes are genuinely multi-hop.** Existing spec logs knowledge
  fraction 63% at n=200, 19% at n=1000 (unbounded). Target: knowledge fraction in low
  single-digit percent and **p90 hops ≥ 3** under `minDistance`, success ≥ 95%. Sweep
  `capacity`, pick the smallest meeting that. If no capacity reaches p90 ≥ 3 with success ≥ 95%,
  say so plainly with numbers rather than loosening anything.

**Record both measured numbers by editing the `## Measured inputs` section of
`tickets/implement/28.5-sim-metric-guard-case.md`** (the follow-up needs them), and repeat them
in this ticket's review handoff.

## Tests expected

- full `yarn test` from `packages/fret` still green (measurement should change no shipped code
  except possibly the sim-local `alpha` constant; if `alpha` changes, re-run
  `test/simulation.partition.spec.ts` and the full suite again)

## TODO

- scratch driver: capacity-bounded runs over the four routing-spec seeds
- relevance-spread distribution for one peer; take the sim-local `alpha` fallback only if
  everything clamps at `sMax`, documented at the site
- sweep `capacity`; record capacity + spread summary into `28.5-sim-metric-guard-case.md`
- full `yarn test` if any tree change was made
- review/ handoff repeating both numbers and any deviation taken
