---
description: The simulation's store eviction ranks every entry equally, so simulated routing tables can never be made sparse — which is what blocks the routing guard from measuring whether the ring metric is any good, and blocks tuning the selector's slack constants.
files: packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation.routing.spec.ts, packages/fret/src/store/relevance.ts, packages/fret/src/store/digitree-store.ts, packages/fret/src/selector/next-hop.ts
difficulty: medium
---

Filed 2026-08-20 out of `15.7-sim-routing-guard-spec`, which measured the consequence rather
than assuming it.

<!-- resume-note -->
A prior plan run was cut short by the runner's token budget after the research pass but before
the design was settled. What it established is recorded under *Research so far* below; that
section is fact-checked against the code and does not need re-deriving. What is left is under
*Open design decisions* and *TODO*. Do not emit an implement ticket until those decisions are
settled — this ticket stays in `plan/` until then.

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

## Research so far (verified against code 2026-08-21 — do not re-derive)

**`src/store/relevance.ts` is already sim-usable as-is.** Every export is a pure function over
`(PeerEntry, x, SparsityModel, now)` with no `FretService` dependency: `createSparsityModel`,
`normalizedLogDistance(selfCoord, otherCoord)`, `observeDistance`, `sparsityBonus`,
`initialRelevance`, `touch`, `recordSuccess`, `recordFailure`. Nothing needs to be extracted or
refactored out of the service to reuse them. `normalizedLogDistance` already measures with
`minDistance`, so "near" means the same thing to the KDE and to the selector.

**The write-back path exists.** `DigitreeStore.update(id, patch)` (`digitree-store.ts:307`)
takes a `PeerPatch`; `upsert` is `:282` and `remove` is `:322`. So a scoring call is
`getById` → score → `update(id, patch)` — no store change required.

**Determinism is the sharpest trap, and it is not hypothetical.** All four scoring entry points
default `now = Date.now()`. The sim's whole value is byte-identical same-seed replay, so every
call must pass the sim clock (`this.scheduler.getCurrentTime()`) explicitly. A single defaulted
`now` silently makes replays diverge, and the failure surfaces as flaky thresholds in unrelated
specs rather than as an obvious error. Note also `recencyScore`'s 60 s half-life against sim
runs of 4–60 simulated seconds: recency will be a live term at sim timescales, not a constant.

**Five `store.upsert` call sites in `test/simulation/fret-sim.ts` are what would need scoring**,
and they are not all the same kind of evidence — which is precisely the mapping the design has
to settle:

- `addPeer` — self-seed.
- `handleConnect` — bootstrap sample, a real contact.
- `processDeliveredMessage` (`neighbor-response` arm) — bus-mode gossip merge, hearsay.
- `exchangeNeighborsDirect` — instant-mode merge, **both directions**, hearsay.
- (the route path already calls `LivenessModel.recordContactSuccess` / `recordContactFailure`,
  which is proven contact and the natural home for `recordSuccess` / `recordFailure`.)

**The sim has no sparsity model today and needs one per peer.** In production the KDE is
service-wide, i.e. per node; the sim holds N nodes in one process, so this is a
`Map<string, SparsityModel>` keyed by peer id alongside `stores`, not one shared model. Sharing
one would make every peer's sparsity bonus a function of every other peer's observations — which
is not what production does and would couple the peers.

**`FretSimulation.enforceCapacity` protects only self.** Production's `enforceCapacity` protects
a set of `2·max(2, m) + 1` ids — self plus `max(2, m)` live members per side via
`ringNeighborsBothSides` — and that protection is what stops eviction from eating the
successor/predecessor window. Porting scoring without porting the protection set would let a
capacity-bounded sim evict its own immediate neighbors, which breaks ring correctness rather
than making the table finger-shaped.

**Three call sites reference this work by its old backlog slug** and must be repointed (or the
reference deleted) when it lands: the `nearRadiusFor` doc-comment in `fret-sim.ts:745`, the
`enforceCapacity` `NOTE:`, and the doc-block of `test/simulation.routing.spec.ts`. The
*Testing strategy* section of `docs/fret.md` carries the same claim in prose and must be updated
in the same pass. (`dist/` also matches — build output, ignore.)

## Open design decisions (settle these before emitting an implement ticket)

- **Evidence mapping per upsert site.** Which of `initialRelevance` / `touch` / `recordSuccess`
  each of the five sites calls. Production's rule is that hearsay scores *once* at creation with
  `initialRelevance` and never again (`FretService.noteDiscovered`), while proven contact scores
  through `touch` / `recordSuccess`. The sim's two merge paths are hearsay by that rule, and
  following it is what makes gossip flat in relevance — but the sim's merge paths currently
  `upsert` unconditionally on every tick, so "score once at creation" needs an explicit
  already-present check rather than falling out of the call.
- **Whether recency/frequency/health stay stubbed.** The ticket body above says the ring-position
  half is what matters. Decide concretely: either pass fixed counters so only the sparsity bonus
  varies (predictable, and makes the resulting spine provably a distance-balanced one), or let
  the real terms run (closer to production, but makes the sim's sparsity depend on its own churn
  and tick cadence). State the tradeoff in the implement ticket either way.
- **What `capacity` value the new routing case uses**, and the target knowledge fraction. The
  existing spec logs 63% at n=200 and 19% at n=1000; the new case needs a number low enough that
  routes are genuinely multi-hop. This is measurable, not arguable — run it.
- **Whether the metric-quality assertion is a new case in `simulation.routing.spec.ts` or a new
  spec file.** Leaning new case in the existing spec, since the doc-block already states the
  limit this closes.

## What it unblocks

- Metric-quality guarding in `simulation.routing.spec.ts` — today's stated limit.
- Tuning `CONNECTED_SLACK_ORDERS` / `QUALITY_SLACK_ORDERS` in `src/selector/next-hop.ts`. Their
  `NOTE:` has deferred this twice: first for want of a harness that drives the selector, now
  (accurately) because the harness that exists cannot resolve a slack constant — a slack is a
  tie-break between candidates close in distance, and with routes two hops long there are no
  such ties to break.
- The far branch of the selector's cost path generally. Per the `nearRadiusFor` `NOTE:`, the
  sim's radius lands around a third of maximum distance at current store sizes, so most
  candidates take the *near* branch — where the connected allowance and the backoff term are
  both inert. Sparse stores shrink `store.size()`, which is the radius's own denominator.
- A hop-count assertion that is more than a ceiling.

## Not in scope

Changing production. Nothing here is evidence of a defect in `src/` — it is a limit on what the
simulation can currently observe.

## TODO

- Settle the four *Open design decisions* above (research, or pick and document the tradeoff).
- Confirm the per-peer `SparsityModel` map does not perturb existing same-seed replays: the
  model consumes no RNG, so it should not, but `simulation.partition.spec.ts` pins deterministic
  replay and is the check.
- Write the implement ticket with an `## Edge cases & interactions` section covering at minimum:
  eviction versus the ported protection set at `capacity < 2m + 1`; a peer whose store is
  smaller than `m`; scoring during churn (a scored entry for a peer that then leaves); the
  dead-entry re-probe ordering, which reads `lastAccess` and which a scoring call now writes;
  and bus mode versus instant mode taking the same scoring path.
- Repoint the three stale `debt-sim-eviction-degenerate-blocks-metric-guard` references and the
  `docs/fret.md` *Testing strategy* prose as part of the implementing change, not after it.
