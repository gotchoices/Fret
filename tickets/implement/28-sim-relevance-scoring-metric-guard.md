---
description: Give the simulated peers real scoring so their address books stay small and spread out, then add a test that can finally tell a good routing rule from a bad one.
files: packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation/liveness.ts, packages/fret/src/store/relevance.ts, packages/fret/src/store/digitree-store.ts, packages/fret/test/simulation.routing.spec.ts, packages/fret/test/simulation.partition.spec.ts, docs/fret.md
difficulty: hard
---

Planned out of `28-sim-eviction-degenerate-blocks-metric-guard` (plan stage, 2026-08-21). Everything
under *Settled design* below was verified against the code — implement it, don't re-derive it.

## Why

`test/simulation.routing.spec.ts` guards ring routing but **cannot tell one plausible ring metric
from another**, and no threshold choice fixes that. Measured by the plan run, 100 routes per case,
seeds 1 / 4242 / 99 / 20260820:

| selector distance function          | success  | p90 hops  | max hops |
|-------------------------------------|----------|-----------|----------|
| `minDistance` (shipped)             | 95–100%  | 2         | 3        |
| preference inverted (farthest wins) | 99%      | 17–20     | 22       |
| `clockwiseDistance` substituted     | 100%     | 2         | 3        |
| XOR distance substituted            | 94–98%   | 2–3       | 3        |

Direction is guarded (row 2). Metric *quality* is not (rows 3–4).

Cause: the sim's `DigitreeStore` is unbounded unless `SimConfig.capacity` is set, and
`exchangeNeighborsDirect` merges every neighbor's whole window each tick — a peer ends up holding
63% of the ring at n=200 and 19% at n=1000 (both logged by that spec). Greedy routing over
knowledge that dense lands on the target's anchor in one or two hops under *any* roughly-monotone
metric, so there is no gap left to measure.

Setting `capacity` today does not help. The sim inserts only via `DigitreeStore.upsert`, which
fixes relevance at 0, so every entry ties and eviction degenerates to ring order (`list()` is
key-ordered) — it would carve a contiguous arc out of every store, which is worse than no eviction
and would make the spec a measurement of eviction. So: give the sim real relevance scoring first,
then bound capacity.

**Not in scope: changing `src/`.** Nothing here is evidence of a production defect — it is a limit
on what the simulation can observe. `src/store/relevance.ts` is consumed as-is.

## Settled design (verified against code — do not re-derive)

**`src/store/relevance.ts` is sim-usable as-is.** Every export is a pure function over
`(PeerEntry, x, SparsityModel, now)` with no `FretService` dependency: `createSparsityModel`,
`normalizedLogDistance`, `observeDistance`, `sparsityBonus`, `initialRelevance`, `touch`,
`recordSuccess`, `recordFailure`. Nothing needs extracting. `normalizedLogDistance` already
measures with `minDistance`, so "near" means the same thing to the KDE and to the selector.

**Write-back path exists.** `DigitreeStore.update(id, patch)` (`digitree-store.ts:307`); `upsert`
`:282`, `remove` `:322`. A scoring call is `getById` then score then `update`. No store change needed.

**Determinism is the sharp trap.** All four scoring entry points default `now = Date.now()`. Every
call must pass `this.scheduler.getCurrentTime()` explicitly or same-seed replay diverges — and it
surfaces as flaky thresholds in unrelated specs rather than as an error. Note also that
`recencyScore`'s half-life is 60 s against sim runs of 4–60 simulated seconds: recency is a *live*
term at sim timescales, not a constant.

**`upsert` stamps `lastAccess` with wall-clock time** and the sim already works around it (both
merge paths carry a comment about keeping the dead-entry skip sim-deterministic). Writing
`lastAccess: simNow` in the scoring patch therefore *improves* determinism — but it reorders
`reprobeDeadEntries` (which sorts ascending `lastAccess`), so `simulation.partition.spec.ts` must
be re-run.

**Five `store.upsert` sites in `test/simulation/fret-sim.ts` need scoring**, with the evidence
mapping already decided:

| site | line | call | why |
|---|---|---|---|
| `addPeer` (self-seed) | `:181` | `initialRelevance` | self is eviction-protected anyway |
| `handleConnect` (bootstrap sample) | `:379` | `touch` | real contact, like production's bootstrap |
| `processDeliveredMessage`, `neighbor-response` | `:345` | `initialRelevance` **plus explicit `observeDistance`** | hearsay — see deviation |
| `exchangeNeighborsDirect`, both directions | `:574`, `:580` | `initialRelevance` **plus explicit `observeDistance`** | hearsay — see deviation |
| route path success / failure | `handleRoute` ~`:706`/`:712` | `recordSuccess` / `recordFailure` | already `LivenessModel.recordContactSuccess/Failure`'s seam |

The last row lands inside `LivenessModel` (`liveness.ts`), which owns
`recordContactSuccess`/`recordContactFailure` and is shared by `contactSweep` and `handleRoute` —
score there, not at the two call sites, or the sweep and the router drift apart. `LivenessModel`
therefore needs the per-peer model and the sim clock injected (its `LivenessDeps` bag is the
existing seam for that). Always pass the sim clock.

**The deviation from production, and why it is required.** Production's hearsay rule is score-once
at creation with `initialRelevance`, which deliberately does *not* `observeDistance` — a name we
were handed is not a distance we accessed. Porting that verbatim makes the sim degenerate a second
time: if only proven contact feeds the KDE, the sim supplies roughly `maxConnections` observations
per peer (at most 12) plus a few route successes; at `alpha = 0.03` occupancy stays near zero, so
`density(x)` stays far under `ideal(x)`, the ratio stays above `sMax^(1/beta) = 1.8^(1/0.6) ≈ 2.63`,
and `sparsityBonus` **clamps at `sMax` for every x**. Every entry then scores `0.6 × 1.8 = 1.08`
and ties — the same degeneracy, one layer down.

So the sim scores *and* observes on the merge paths, and re-scores an already-held entry on each
merge (also a deviation, from `noteDiscovered`'s leave-it-alone rule) so the bonus tracks the
model's growing occupancy. **Record that tradeoff as a `NOTE:` at the merge sites: the sim's KDE
is fed by gossip because the sim has orders of magnitude fewer contact events per peer than a real
node.**

**Nothing is stubbed and nothing needs to be.** For a hearsay entry written at `simNow`, recency is
1.0, frequency 0, health 0.5 — base is a uniform `0.4·1 + 0.2·0 + 0.4·0.5 = 0.6` for every such
entry, and relevance is a stored snapshot never recomputed, so the sparsity bonus is automatically
the only varying term. Entries that earned proven contact score legitimately higher. That is
production's shape: a distance-balanced spine *plus* the peers this node actually talked to.

**One `SparsityModel` per peer** — `Map<string, SparsityModel>` keyed by peer id alongside
`stores`, created in `addPeer` and read wherever a store is. In production the KDE is service-wide,
i.e. per node; the sim holds N nodes in one process, so a shared model would make every peer's
bonus a function of every other peer's observations. The model consumes no RNG, so it must not
perturb same-seed replay — `simulation.partition.spec.ts` pins that and is the check.

**`FretSimulation.enforceCapacity` (`:590`) protects only self, and that is not enough once
eviction becomes real.** Production protects `2·max(2, m) + 1` ids — self plus `max(2, m)` live
members per side via `ringNeighborsBothSides` — and that is what stops eviction eating the
successor/predecessor window. Port the protection set alongside the scoring, or a capacity-bounded
sim evicts its own immediate neighbors and breaks ring correctness instead of producing a finger
shape. Use the shipped `ringNeighborsBothSides` (`src/ring/ring-walk.ts`) with the `notDead`
filter; do not hand-roll a two-sided walk.

## Phase 1 — measure, then pick the constant

Two numbers. The design above is fixed; these choose one constant and check one assumption. The
expectations below are **derived arithmetic, not observations** — decide from what you measure.

- **Relevance spread across one peer's store.** Log the distribution of stored `relevance` for a
  single peer after a capacity-bounded run. Expectation: `normalizedLogDistance` is log-scale, so a
  uniformly-drawn ring peer lands at x near 1; occupancy piles up at the top KDE centers (bonus
  ≈ 1.05–1.1 there) while low-x centers stay sparse (clamped at `sMax` 1.8). That gradient is what
  makes eviction prefer far peers and keep the near/mid spine.
  - **Decision rule: if every entry still clamps at `sMax`, the gossip-fed-KDE design is not
    enough.** Fallback is to raise `alpha` for the sim's model only — a sim-local constant passed
    to `createSparsityModel`, documented at the site as sim-local and why. Do not change the
    production default.
- **`capacity`, chosen so routes are genuinely multi-hop.** The existing spec logs knowledge
  fraction 63% at n=200 and 19% at n=1000. Target for the new case: knowledge fraction in the low
  single-digit percent, and **p90 hops ≥ 3** under `minDistance`, so a substituted metric has
  headroom to measure worse. Sweep `capacity` and pick the smallest value meeting that while
  success rate stays at today's level (≥ 95%).

Record both measured numbers in the review handoff. If the sweep cannot reach p90 ≥ 3 at any
capacity that keeps success ≥ 95%, say so plainly in the handoff with the numbers rather than
loosening the new assertion to whatever passed.

## Phase 2 — the guard

The new assertion goes in **a new case inside `test/simulation.routing.spec.ts`**, not a new spec
file: that spec's doc-block already states the limit being closed, so the case and the retracted
caveat are edited in one place.

The case must **bite**: assert p90 hops under the shipped `minDistance`, and demonstrate (as the
inverted-preference case already does) that substituting `clockwiseDistance` or XOR moves the
number past the threshold. If it does not bite, the guard is not written yet — report the measured
substituted-metric numbers rather than shipping a threshold nothing can fail.

## Stale references to repoint — in this change, not after it

Exactly one source file names the old backlog slug: `fret-sim.ts:745` (the `nearRadiusFor`
doc-comment). Two more state the limit in prose without the slug and must be updated in the same
change: the `NOTE:` in `enforceCapacity` (`fret-sim.ts:594-598`) and the doc-block of
`test/simulation.routing.spec.ts` (~`:45`). `docs/fret.md`'s *Testing strategy* section carries the
same claim in prose ("substituting clockwise-only distance, or XOR ... moves neither number ...
until then `capacity` is left unset in that spec") — update it in the same pass. (`dist/` also
matches; build output, ignore.)

## Edge cases & interactions

- eviction versus the ported protection set when `capacity < 2m + 1` — production's stated outcome
  is that protection outranks the cap and the table stays over capacity; the sim must not loop or
  evict a protected id instead
- a peer whose store is smaller than `m` (young ring, mid-split joiner) — the two-sided walk
  returns fewer ids per side; protection must not assume it got `m`
- scoring during churn — a scored entry for a peer that then leaves; `contactSweep` prunes
  non-alive ids, so a scoring call must tolerate `getById` returning `undefined`
- dead-entry re-probe ordering, which reads `lastAccess` that a scoring call now writes
  (`reprobeDeadEntries` sorts ascending) — re-run `simulation.partition.spec.ts`
- a merge that skips a locally-`dead` entry must skip its scoring too, or the skip's whole point
  (no resurrection, deterministic `lastAccess`) is lost
- bus mode and instant mode taking the same scoring path — `processDeliveredMessage` and
  `exchangeNeighborsDirect` must not diverge
- same-seed replay: two runs of an identical config must produce byte-identical metrics with the
  per-peer model map in place (partition spec pins this)
- `capacity` left unset (every existing sim spec) must behave exactly as today — scoring writes
  relevance, but with no capacity nothing evicts, so no existing threshold may move

## Tests expected

- new routing case in `test/simulation.routing.spec.ts`: capacity-bounded sparse ring, assert
  success ≥ 95% and p90 hops ≥ 3 under `minDistance`, plus the metric-substitution demonstration
- `test/simulation.partition.spec.ts` re-run green (deterministic replay + dead re-probe ordering)
- full `yarn test` from `packages/fret` — no existing sim threshold may move with `capacity` unset

## What it unblocks (state in the handoff, don't build)

- metric-quality guarding in `simulation.routing.spec.ts` — today's stated limit
- tuning `CONNECTED_SLACK_ORDERS` / `QUALITY_SLACK_ORDERS` in `src/selector/next-hop.ts`; a slack is
  a tie-break between candidates close in distance, and with routes two hops long there are no such
  ties to break, which is why their `NOTE:` has deferred this twice
- the selector's far-cost branch generally: per the `nearRadiusFor` `NOTE:` the sim's radius lands
  near a third of maximum distance at current store sizes, so most candidates take the *near*
  branch where the connected allowance and the backoff term are both inert. Sparse stores shrink
  `store.size()`, which is that radius's own denominator.

## TODO

### Phase 1 — scoring + measurement
- add `Map<string, SparsityModel>` beside `stores`; create per peer in `addPeer`
- wire the five upsert sites per the table above, always passing `scheduler.getCurrentTime()`
- move the route-path scoring into `LivenessModel.recordContactSuccess`/`recordContactFailure`,
  injecting the model lookup and clock through `LivenessDeps`
- `NOTE:` at the merge sites recording the gossip-fed-KDE deviation and why
- port production's `2·max(2, m) + 1` protection set into `enforceCapacity` via
  `ringNeighborsBothSides` + `notDead`
- measure relevance spread for one peer; if every entry clamps at `sMax`, take the sim-local
  `alpha` fallback and document it at the site
- sweep `capacity`; pick the smallest meeting p90 ≥ 3 with success ≥ 95%; record both numbers

### Phase 2 — guard + docs
- new capacity-bounded case in `test/simulation.routing.spec.ts` with the measured `capacity`
- show it bites (clockwise-only / XOR substitution crosses the threshold)
- repoint the three stale in-repo references and `docs/fret.md`'s *Testing strategy* prose
- re-run `simulation.partition.spec.ts`, then full `yarn test`
