---
description: The simulation's store eviction ranks every entry equally, so simulated routing tables can never be made sparse — which is what blocks the routing guard from measuring whether the ring metric is any good, and blocks tuning the selector's slack constants.
files: packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation.routing.spec.ts, packages/fret/src/store/relevance.ts, packages/fret/src/store/digitree-store.ts, packages/fret/src/selector/next-hop.ts
difficulty: medium
---

Filed 2026-08-20 out of `15.7-sim-routing-guard-spec`, which measured the consequence rather
than assuming it.

<!-- resume-note -->
Two plan runs have now been cut short by the runner's token budget (2026-08-20 research pass,
2026-08-21 design pass). Everything under *Research so far* and *Design settled* below is
fact-checked against the code and does **not** need re-deriving. What remains is one measurement
run, described under *The one open item* and in the TODO. This ticket stays in `plan/` until that
measurement is taken; do not emit an implement ticket before it.

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
production's sparsity-weighted model does. Then a capacity-bounded sim ring has sparse stores
and multi-hop routes, and the routing spec can be extended with a case whose hop count is
sensitive to metric quality.

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

**`DigitreeStore.upsert` already stamps `lastAccess` with wall-clock time**, and the sim already
works around it: both merge paths carry a comment saying the dead-entry skip "keeps the entry's
`lastAccess` sim-deterministic for the dead re-probe ordering (upsert stamps wall-clock time)".
So wall-clock `lastAccess` is *already* in the sim's stores today for every non-dead entry. This
cuts both ways for the implementer: a scoring patch that writes `lastAccess: simNow` after each
upsert **improves** determinism over the status quo, and it is the natural place to fix it — but
it also changes the dead re-probe ordering (`reprobeDeadEntries` sorts by ascending `lastAccess`),
so `simulation.partition.spec.ts` must be re-run to confirm the replay assertions still hold.

**Five `store.upsert` call sites in `test/simulation/fret-sim.ts` are what needs scoring:**
`addPeer` (self-seed, `:181`), `handleConnect` (bootstrap sample, a real contact, `:379`),
`processDeliveredMessage` / `neighbor-response` arm (bus-mode gossip merge, `:345`), and
`exchangeNeighborsDirect` (instant-mode merge, **both directions**, `:574` and `:580`). The route
path already calls `LivenessModel.recordContactSuccess` / `recordContactFailure`, which is proven
contact and the natural home for `recordSuccess` / `recordFailure`.

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

## Design settled (2026-08-21 — decided, with the reasoning; not open)

### Evidence mapping per upsert site

Follow production's split — `handleConnect` and the route path are proven contact, the two merge
paths are hearsay — with **one deliberate deviation**, argued below:

| site | call | why |
|---|---|---|
| `addPeer` (self) | `initialRelevance`, sim clock | self is protected from eviction anyway |
| `handleConnect` | `touch` | a real contact; production's bootstrap sample is scored the same way |
| `processDeliveredMessage`, `neighbor-response` | `initialRelevance` **+ explicit `observeDistance`** | hearsay — see deviation |
| `exchangeNeighborsDirect`, both directions | `initialRelevance` **+ explicit `observeDistance`** | hearsay — see deviation |
| route path success / failure | `recordSuccess` / `recordFailure`, sim clock | already the LivenessModel's own seam |

**The deviation, and why it is required rather than sloppy.** Production's rule is that hearsay
scores *once* at creation with `initialRelevance`, which deliberately does **not** call
`observeDistance` — a name we were handed is not a distance we accessed. Porting that rule
verbatim makes the sim's eviction degenerate a second time, for a new reason:

- Under score-once-at-creation, every merged entry is scored from empty counters at the moment
  `upsert` stamped its `lastAccess`, so recency is 1.0, frequency is 0 and health is the neutral
  0.5 — base is the **same 0.6 for every hearsay entry**. Only the sparsity bonus varies. That
  part is fine, and is in fact what makes the resulting spine provably distance-balanced.
- But if only proven contact observes the KDE, the sim feeds it roughly `maxConnections`
  observations per peer (≤ 12) plus a handful of route successes. At `alpha = 0.03` the EMA
  occupancy is still near zero after ~12 observations, so `density(x)` stays far below
  `ideal(x)`, the ratio stays above `sMax^(1/beta) = 1.8^(1/0.6) ≈ 2.63`, and `sparsityBonus`
  **clamps at `sMax` for every x**. Every entry then scores `0.6 × 1.8 = 1.08` and ties — the
  exact degeneracy this ticket exists to remove, moved one layer down.

So the sim scores *and observes* on the merge paths. That is the honest tradeoff for the
implement ticket to state: the sim's KDE is fed by gossip where production's is fed by contact,
because the sim has orders of magnitude fewer contact events per peer than a real node does.
Re-scoring an already-held entry on each merge is likewise a deviation from `noteDiscovered`'s
leave-it-alone rule; it is what lets the bonus track the model's growing occupancy, and it is the
same "eviction ranks snapshots taken under different model states" behavior `docs/fret.md`
already records for production.

### Whether recency / frequency / health stay stubbed

**Nothing is stubbed, and nothing needs to be.** Per the arithmetic above, the hearsay path
already produces a uniform base of 0.6 (recency 1.0 at write time, frequency 0, health 0.5),
because relevance is a *stored snapshot* that is never recomputed — so the sparsity bonus is
automatically the only varying term for merged entries, with no fixed counters passed in. Entries
that earned proven contact (`handleConnect`, route successes) get a legitimately higher base,
which is production's shape and is desirable: the spine is distance-balanced *plus* the peers
this node actually talked to. Passing the sim clock everywhere is mandatory regardless.

### Where the new assertion lives

A **new case in the existing `test/simulation.routing.spec.ts`**, not a new spec file. That
spec's doc-block already states the limit this closes, so the case and the retracted caveat are
edited in one place.

## The one open item (needs a measurement run, then this ticket can emit implement)

**What `capacity` value the new routing case uses, and the target knowledge fraction** — plus,
in the same run, a check that the design above actually produces a *spread* of relevance rather
than a new tie. Both are measurements, not arguments, and the numbers below are derived
arithmetic, not observations:

- Expected shape of the bonus, unmeasured: `normalizedLogDistance` is log-scale, so for a peer
  drawn uniformly from the ring, x lands near 1 — occupancy piles up at the top KDE centers
  (`sparsityBonus` there ≈ 1.05–1.1) while low-x centers stay sparse (clamped at `sMax` 1.8).
  That is the gradient that makes eviction prefer far peers and keep the near/mid spine. **If the
  measurement shows every entry still clamped at `sMax`, the design above is wrong and the
  fallback is to raise `alpha` for the sim's model only** (a sim-local constant, documented as
  such) — decide that from the measured spread, not in advance.
- Then pick `capacity` so the logged knowledge fraction is low enough that routes are genuinely
  multi-hop. The existing spec logs 63% at n=200 and 19% at n=1000. Target for the new case:
  knowledge fraction in the low single-digit percent, and p90 hops ≥ 3 with `minDistance` so
  there is headroom for a substituted metric to measure worse.

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

- Take the measurement described under *The one open item*: wire the scoring design above into a
  throwaway branch of `fret-sim.ts` (or a scratch harness run), set `capacity`, and log both the
  relevance spread across a peer's store and the resulting knowledge fraction and p90 hop count.
  Pick `capacity` from that. If the spread is degenerate, take the `alpha` fallback and say so.
- Confirm the per-peer `SparsityModel` map does not perturb existing same-seed replays: the
  model consumes no RNG, so it should not, but `simulation.partition.spec.ts` pins deterministic
  replay and is the check. Re-run it specifically for the `lastAccess` change noted above, which
  reorders `reprobeDeadEntries`.
- Write the implement ticket with an `## Edge cases & interactions` section covering at minimum:
  eviction versus the ported protection set at `capacity < 2m + 1`; a peer whose store is
  smaller than `m`; scoring during churn (a scored entry for a peer that then leaves); the
  dead-entry re-probe ordering, which reads `lastAccess` and which a scoring call now writes;
  and bus mode versus instant mode taking the same scoring path.
- Repoint the three stale `debt-sim-eviction-degenerate-blocks-metric-guard` references and the
  `docs/fret.md` *Testing strategy* prose as part of the implementing change, not after it.
