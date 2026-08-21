---
description: With the simulated peers now scoring relevance for real, measure the score spread and sweep store capacity to pick the constant the follow-up metric-guard ticket needs.
prereq: sim-relevance-scoring-wiring-scores
files: packages/fret/test/simulation/fret-sim.ts, packages/fret/src/store/relevance.ts, packages/fret/test/simulation.routing.spec.ts, tickets/implement/28.5-sim-metric-guard-case.md
difficulty: medium
---

Narrowed from the original `sim-relevance-scoring` (2026-08-21, run 3 hit token budget): the
code changes moved to `sim-relevance-scoring-wiring-scores` (prereq). This ticket is **measurement and
the capacity decision only** — the wiring has landed (verified, see next section).

Run 4 (2026-08-21) hit the soft token budget during orientation, before any measurement ran. No
tree change was made; nothing to resume mid-flight. What that run established is recorded below
so the next agent does not re-read the same files.

## State at HEAD (verified 2026-08-21 — do not re-verify)

Prereq wiring is present in `test/simulation/fret-sim.ts`:

- per-peer sparsity models: `models: Map<string, SparsityModel>` (`:109`), created by
  `createSparsityModel()` (`:203`) — **no argument overrides today**, so the model runs at
  production defaults
- self-seed scored with `initialRelevance` (`:215`)
- `scoreMerge` (`:689`) called from three merge sites (`:384`, `:639`, `:649`)
- `enforceCapacity` (`:720`) with the protection set, called from four sites (`:387`, `:442`,
  `:548`, `:653`), each guarded by `if (this.config.capacity)`
- `SimConfig.capacity?: number` (`:83`) — unset in every spec today
- `nearRadiusFor` (`:879`) derives the radius from `store.size()`

Production constants that decide the spread question (`src/store/relevance.ts`):
`createSparsityModel(m = 12, sigma = 0.08, alpha = 0.03, beta = 0.6, sMin = 0.7, sMax = 1.8)`;
centers are `(i + 0.5) / 12`, i.e. 0.042 … 0.958. `sparsityBonus` clamps at `sMax` whenever
occupancy is near zero, so **the clamp question is really an occupancy question**: only
`touch` / `recordSuccess` / `recordFailure` call `observeDistance`, while `initialRelevance`
deliberately does not. Check first whether the sim's `scoreMerge` observes the KDE at all
(`:689`–`:697` — line 697 is an `initialRelevance` call); if merges never observe, occupancy
stays flat, every entry clamps at `sMax`, and the ticket's documented `alpha` fallback is the
wrong lever for that cause. Say which cause you measured.

## How to measure

Throwaway script in the scratchpad (not the repo tree), run from `packages/fret`:
`node --import ./register.mjs <scratchpad>/measure.mjs`. Import `{ FretSimulation }` from
`./test/simulation/fret-sim.ts`.

**Copy `measureRouting` / `pump` / `baseConfig` verbatim out of `test/simulation.routing.spec.ts`**
(`:52`–`:120`) rather than writing a driver — it already returns exactly what the sweep needs
(`successRate`, `p90Hops`, `maxHops`, `attempts`, `knowledgeFraction`) and already fixes
`CONVERGE_MS` 4000 / `ROUTE_COUNT` 100. Add `capacity` to the overrides bag; read the spread from
`sim.getStores().get(id)!.list()` after the run. Seeds 1 / 4242 / 99 / 20260820; n=200 and the
n=1000 all-edge case (`profileMix: { edge: 1, core: 0 }`). Delete the script when done.

## Measurements — pick the constant, record both numbers

Expectations below are derived arithmetic, not observations — decide from what you measure.

- **Relevance spread across one peer's store.** Log the stored `relevance` distribution for one
  peer after a capacity-bounded run. Expectation: occupancy piles up at high-x KDE centers
  (bonus ≈ 1.05–1.1) while low-x centers stay sparse (clamped at `sMax` 1.8); that gradient
  makes eviction prefer far peers and keep the near/mid spine.
  - **Decision rule: if every entry still clamps at `sMax`, gossip-fed KDE is not enough.**
    Fallback: raise `alpha` for the sim's model only — a sim-local constant passed to
    `createSparsityModel` at the model-creation site in `fret-sim.ts` (`:203`), documented there
    as sim-local and why. Do not change the production default in `src/store/relevance.ts`.
    Take this fallback only if occupancy is genuinely being observed and merely too slow; if
    nothing observes at all (see previous section), report that instead — it is a different
    defect and `alpha` cannot fix it.
- **`capacity`, chosen so routes are genuinely multi-hop.** Existing spec logs knowledge
  fraction 63% at n=200, 19% at n=1000 (unbounded). Target: knowledge fraction in low
  single-digit percent and **p90 hops ≥ 3** under `minDistance`, success ≥ 95%. Sweep
  `capacity`, pick the smallest meeting that. If no capacity reaches p90 ≥ 3 with success ≥ 95%,
  say so plainly with numbers rather than loosening anything.
  - Note the protection set is `2·max(2, m) + 1` = 17 ids at `m` 8, and protection outranks the
    cap, so a swept `capacity` below 17 bounds nothing. Start the sweep at or above that.

**Record both measured numbers by editing the `## Measured inputs` section of
`tickets/implement/28.5-sim-metric-guard-case.md`** (the follow-up needs them), and repeat them
in this ticket's review handoff.

## Tests expected

- full `yarn test` from `packages/fret` still green (measurement should change no shipped code
  except possibly the sim-local `alpha` constant; if `alpha` changes, re-run
  `test/simulation.partition.spec.ts` and the full suite again)
- if no tree change was made, `yarn test` may be skipped — say so in the handoff

## TODO

- scratch driver (copy of the routing spec's `measureRouting`): capacity-bounded runs over the
  four routing-spec seeds
- relevance-spread distribution for one peer; determine whether merges observe the KDE at all
  before reaching for the sim-local `alpha` fallback; document at the site if taken
- sweep `capacity` from ≥ 17 upward; record capacity + spread summary into
  `28.5-sim-metric-guard-case.md`
- full `yarn test` if any tree change was made
- review/ handoff repeating both numbers and any deviation taken
