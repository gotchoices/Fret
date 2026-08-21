---
description: The simulation evicts store entries at random because it never scores them, so simulated peers can never be given the small, spread-out routing tables that would let a test tell a good routing metric from a bad one.
files: packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation.routing.spec.ts, packages/fret/src/store/relevance.ts, packages/fret/src/store/digitree-store.ts, packages/fret/src/selector/next-hop.ts
difficulty: medium
---

Filed 2026-08-20 out of `15.7-sim-routing-guard-spec`.

<!-- resume-note -->
**Three plan runs have now died on the token budget** (2026-08-20 research, 2026-08-21 design,
2026-08-21 wrap-up). The cause is context, not difficulty: the settled material below used to run
to ~200 lines of prose and left no budget for the one thing still outstanding. It has been cut to
the facts. **Everything under *Settled* is verified against the code and must not be re-derived.**

**Start cheap.** Do *not* read `fret-sim.ts` whole (779 lines). Read only the line ranges named
in *Settled → upsert sites*, and `src/store/relevance.ts` (193 lines, the whole file is fine).
Then go straight to *The measurement*. Budget the run so the measurement actually happens.

## The finding

`test/simulation.routing.spec.ts` guards ring routing but **cannot tell one plausible ring metric
from another**, and no threshold choice fixes that. Measured, 100 routes per case, seeds
1 / 4242 / 99 / 20260820:

| selector distance function          | success  | p90 hops  | max hops |
|-------------------------------------|----------|-----------|----------|
| `minDistance` (shipped)             | 95–100%  | 2         | 3        |
| preference inverted (farthest wins) | 99%      | 17–20     | 22       |
| `clockwiseDistance` substituted     | 100%     | 2         | 3        |
| XOR distance substituted            | 94–98%   | 2–3       | 3        |

Direction is guarded (row 2). Metric *quality* is not (rows 3–4).

**Why:** the sim's `DigitreeStore` is unbounded unless `SimConfig.capacity` is set, and
`exchangeNeighborsDirect` merges every neighbor's whole window each tick — so a peer ends up
holding 63% of the ring at n=200, 19% at n=1000 (both logged by that spec). Greedy routing over
knowledge that dense lands on the target's anchor in one or two hops under *any* roughly-monotone
metric, so there is no gap left to measure. And setting `capacity` today does not help: the sim
only ever inserts via `DigitreeStore.upsert`, which fixes relevance at 0, so every entry ties and
eviction degenerates to ring order (`list()` is key-ordered) — it would carve a contiguous arc out
of every store, which is worse than no eviction and would make the spec a measurement of eviction.

**Fix:** give the sim real relevance scoring, so a capacity-bounded sim ring gets sparse,
distance-balanced stores and genuinely multi-hop routes.

## Settled (verified against code 2026-08-21 — do not re-derive)

**`src/store/relevance.ts` is sim-usable as-is.** Every export is a pure function over
`(PeerEntry, x, SparsityModel, now)` with no `FretService` dependency: `createSparsityModel`,
`normalizedLogDistance`, `observeDistance`, `sparsityBonus`, `initialRelevance`, `touch`,
`recordSuccess`, `recordFailure`. Nothing needs extracting. `normalizedLogDistance` already
measures with `minDistance`, so "near" means the same thing to the KDE and to the selector.

**Write-back path exists:** `DigitreeStore.update(id, patch)` (`digitree-store.ts:307`);
`upsert` `:282`, `remove` `:322`. A scoring call is `getById` → score → `update`. No store change.

**Determinism is the sharp trap.** All four scoring entry points default `now = Date.now()`.
Every call must pass `this.scheduler.getCurrentTime()` explicitly or same-seed replay diverges,
surfacing as flaky thresholds in unrelated specs rather than as an error. Also note
`recencyScore`'s 60 s half-life against sim runs of 4–60 simulated seconds: recency is a *live*
term at sim timescales, not a constant.

**`upsert` already stamps `lastAccess` with wall-clock time**, and the sim already works around it
(both merge paths carry a comment about keeping the dead-entry skip sim-deterministic). So writing
`lastAccess: simNow` in the scoring patch *improves* determinism — but it reorders
`reprobeDeadEntries` (sorts ascending `lastAccess`), so `simulation.partition.spec.ts` must be
re-run.

**Five `store.upsert` sites in `test/simulation/fret-sim.ts` need scoring**, with the evidence
mapping already decided:

| site | line | call | why |
|---|---|---|---|
| `addPeer` (self-seed) | `:181` | `initialRelevance` | self is eviction-protected anyway |
| `handleConnect` (bootstrap sample) | `:379` | `touch` | real contact, like production's bootstrap |
| `processDeliveredMessage`, `neighbor-response` | `:345` | `initialRelevance` **+ explicit `observeDistance`** | hearsay — see deviation |
| `exchangeNeighborsDirect`, both directions | `:574`, `:580` | `initialRelevance` **+ explicit `observeDistance`** | hearsay — see deviation |
| route path success / failure | — | `recordSuccess` / `recordFailure` | already `LivenessModel.recordContactSuccess/Failure`'s seam |

Always pass the sim clock.

**The deviation, and why it is required.** Production's hearsay rule is score-once at creation
with `initialRelevance`, which deliberately does *not* `observeDistance` — a name we were handed
is not a distance we accessed. Porting that verbatim makes the sim degenerate a second time: if
only proven contact feeds the KDE, the sim supplies roughly `maxConnections` observations per peer
(≤ 12) plus a few route successes; at `alpha = 0.03` occupancy stays near zero, so `density(x)`
stays far under `ideal(x)`, the ratio stays above `sMax^(1/beta) = 1.8^(1/0.6) ≈ 2.63`, and
`sparsityBonus` **clamps at `sMax` for every x**. Every entry then scores `0.6 × 1.8 = 1.08` and
ties — the same degeneracy, one layer down. So the sim scores *and* observes on the merge paths,
and re-scores an already-held entry on each merge (also a deviation from `noteDiscovered`'s
leave-it-alone rule) so the bonus tracks the model's growing occupancy. State that tradeoff in the
implement ticket: **the sim's KDE is fed by gossip because the sim has orders of magnitude fewer
contact events per peer than a real node.**

**Nothing is stubbed and nothing needs to be.** For a hearsay entry written at `simNow`, recency
is 1.0, frequency 0, health 0.5 — base is a uniform `0.4·1 + 0.2·0 + 0.4·0.5 = 0.6` for every such
entry, and relevance is a stored snapshot never recomputed, so the sparsity bonus is automatically
the only varying term. Entries that earned proven contact score legitimately higher. That is
production's shape: a distance-balanced spine *plus* the peers this node actually talked to.

**The sim needs one `SparsityModel` per peer** — `Map<string, SparsityModel>` keyed by peer id
alongside `stores`. In production the KDE is service-wide, i.e. per node; the sim holds N nodes in
one process, so a shared model would make every peer's bonus a function of every other peer's
observations.

**`FretSimulation.enforceCapacity` (`:590`) protects only self.** Production protects
`2·max(2, m) + 1` ids — self plus `max(2, m)` live members per side via `ringNeighborsBothSides` —
and that is what stops eviction eating the successor/predecessor window. Porting scoring without
porting the protection set lets a capacity-bounded sim evict its own immediate neighbors, breaking
ring correctness rather than producing a finger shape.

**Stale references to repoint when this lands** (corrected — the earlier count of three was wrong):
exactly one source file names the old backlog slug, `fret-sim.ts:745` (the `nearRadiusFor`
doc-comment). Two more places state the limit in prose without the slug and must be updated in the
same change: the `NOTE:` in `enforceCapacity` (`fret-sim.ts:594-598`) and the doc-block of
`test/simulation.routing.spec.ts` (~`:45`). `docs/fret.md`'s *Testing strategy* section carries the
same claim in prose — update it in the same pass. (`dist/` also matches; build output, ignore.)

## The measurement (the only thing left — do this, then emit the implement ticket)

Two numbers, then this ticket can hand off. Both are measurements; the expectations below are
derived arithmetic, not observations, and may be wrong.

Wire the scoring design above into a throwaway edit of `fret-sim.ts` (or a scratch harness in
`tickets/.logs/`-adjacent scratch — delete it before handing off), set `capacity`, and log:

- **Relevance spread across one peer's store.** Expected: `normalizedLogDistance` is log-scale, so
  a uniformly-drawn ring peer lands at x near 1; occupancy piles up at the top KDE centers
  (bonus ≈ 1.05–1.1 there) while low-x centers stay sparse (clamped at `sMax` 1.8). That gradient
  is what makes eviction prefer far peers and keep the near/mid spine. **If every entry still
  clamps at `sMax`, the design above is wrong** — fallback is to raise `alpha` for the sim's model
  only (a sim-local constant, documented as such). Decide from the measured spread, not in advance.
- **`capacity`, chosen so routes are genuinely multi-hop.** The existing spec logs knowledge
  fraction 63% at n=200, 19% at n=1000. Target for the new case: knowledge fraction in the low
  single-digit percent, and p90 hops ≥ 3 under `minDistance`, so a substituted metric has headroom
  to measure worse.

Also confirm the per-peer `SparsityModel` map does not perturb same-seed replay — the model
consumes no RNG so it should not, but `simulation.partition.spec.ts` pins deterministic replay and
is the check, and it must be re-run anyway for the `lastAccess` reorder noted above.

The new assertion goes in **a new case inside `test/simulation.routing.spec.ts`**, not a new spec
file: that spec's doc-block already states the limit being closed, so the case and the retracted
caveat are edited in one place.

## Edge cases the implement ticket must carry

Copy these into its `## Edge cases & interactions` section, plus whatever the measurement turns up:

- eviction versus the ported protection set when `capacity < 2m + 1`
- a peer whose store is smaller than `m`
- scoring during churn — a scored entry for a peer that then leaves
- dead-entry re-probe ordering, which reads `lastAccess` that a scoring call now writes
- bus mode and instant mode taking the same scoring path

## What it unblocks

- Metric-quality guarding in `simulation.routing.spec.ts` — today's stated limit.
- Tuning `CONNECTED_SLACK_ORDERS` / `QUALITY_SLACK_ORDERS` in `src/selector/next-hop.ts`. A slack
  is a tie-break between candidates close in distance; with routes two hops long there are no such
  ties to break, which is why their `NOTE:` has deferred this twice.
- The selector's far cost branch generally. Per the `nearRadiusFor` `NOTE:`, the sim's radius lands
  near a third of maximum distance at current store sizes, so most candidates take the *near*
  branch, where the connected allowance and the backoff term are both inert. Sparse stores shrink
  `store.size()`, which is that radius's own denominator.
- A hop-count assertion that is more than a ceiling.

## Not in scope

Changing production. Nothing here is evidence of a defect in `src/` — it is a limit on what the
simulation can observe.

## TODO

- Take the measurement above; pick `capacity` from it. If the spread is degenerate, take the
  `alpha` fallback and say so in the implement ticket.
- Re-run `simulation.partition.spec.ts` for the replay/`lastAccess` check.
- Emit the implement ticket, carrying: the settled design table, the KDE-fed-by-gossip tradeoff,
  the measured `capacity` and expected hop count, the edge-case list above, and the stale-reference
  repointing (including `docs/fret.md`) as part of the change rather than after it.
- Delete any scratch harness you wrote.
