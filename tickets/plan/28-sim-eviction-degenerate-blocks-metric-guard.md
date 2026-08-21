---
description: The simulation's store eviction ranks every entry equally, so simulated routing tables can never be made sparse — which is what blocks the routing guard from measuring whether the ring metric is any good, and blocks tuning the selector's slack constants.
files: packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation.routing.spec.ts, packages/fret/src/selector/next-hop.ts
difficulty: medium
---

Filed 2026-08-20 out of `15.7-sim-routing-guard-spec`, which measured the consequence rather
than assuming it.

## The finding

`test/simulation.routing.spec.ts` guards ring routing, but it **cannot discriminate one
plausible ring metric from another**, and no choice of threshold fixes that. Measured, 100
routes per case, seeds 1 / 4242 / 99 / 20260820:

| selector distance function          | success  | p90 hops  | max hops |
|-------------------------------------|----------|-----------|----------|
| `minDistance` (shipped)             | 95–100%  | 2         | 3        |
| preference inverted (farthest wins) | 99%      | 17–20     | 22       |
| `clockwiseDistance` substituted     | 100%     | 2         | 3        |
| XOR distance substituted            | 94–98%   | 2–3       | 3        |

Direction is guarded (row 2). Metric *quality* is not (rows 3–4).

## Why

Two harness properties compound:

1. `DigitreeStore` in the sim is unbounded unless `SimConfig.capacity` is set, and
   `exchangeNeighborsDirect` merges every neighbor's whole window each tick. So a peer
   accumulates a large, near-uniform slice of the ring — **63% of it at n=200, 19% at n=1000**,
   logged by each case in that spec. Greedy routing over knowledge that dense reaches the
   target's anchor in one or two hops under any roughly-monotone metric, so there is no gap
   between plausible metrics left to measure.
2. Setting `capacity` does not produce the sparse, *finger-shaped* table production has. See
   the `NOTE:` in `FretSimulation.enforceCapacity`: the sim populates stores exclusively via
   `DigitreeStore.upsert`, which fixes relevance at 0, so every entry ties and eviction
   degenerates to ring order (`list()` is key-ordered). It would evict a contiguous arc from
   every store — worse than no eviction, and it would make the spec's numbers a measurement of
   eviction rather than of routing. That is why `capacity` is left unset there.

## What to do

Give the sim real relevance scoring so eviction selects a distance-balanced spine the way
production's sparsity-weighted model does — the ring-position half of `src/store/relevance.ts`
is the part that matters here; recency/frequency/health can stay stubbed. Then a capacity-bounded
sim ring has sparse stores and multi-hop routes, and the routing spec can be extended with a case
whose hop count is sensitive to metric quality.

## What it unblocks

- Metric-quality guarding in `simulation.routing.spec.ts` — today's stated limit.
- Tuning `CONNECTED_SLACK_ORDERS` / `QUALITY_SLACK_ORDERS` in `src/selector/next-hop.ts`. Their
  `NOTE:` has deferred this twice: first for want of a harness that drives the selector, now
  (accurately) because the harness that exists cannot resolve a slack constant — a slack is a
  tie-break between candidates close in distance, and with routes two hops long there are no
  such ties to break.
- A hop-count assertion that is more than a ceiling.

## Not in scope

Changing production. Nothing here is evidence of a defect in `src/` — it is a limit on what the
simulation can currently observe.
