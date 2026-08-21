---
description: Give the simulated peers real relevance scoring so bounded stores evict sensibly, then measure the score spread and pick the capacity constant the follow-up guard ticket needs.
files: packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation/liveness.ts, packages/fret/src/store/relevance.ts, packages/fret/src/store/digitree-store.ts, packages/fret/src/ring/ring-walk.ts, packages/fret/test/simulation.partition.spec.ts
difficulty: hard
---

Split out of `28-sim-relevance-scoring-metric-guard` (implement stage, 2026-08-21) when that run
hit its token budget during reconnaissance — no code was changed. This ticket is Phase 1
(scoring + capacity protection + measurement); the guard case and doc repointing are
`sim-metric-guard-case` (prereq-chained behind this one). Everything under *Settled design* was
verified against the code this session — implement it, don't re-derive it.

<!-- resume-note -->
**Resume note (run 2, 2026-08-21).** This run also ended on BUDGET_WARNING during
reconnaissance — **no code changed**. What it accomplished: re-verified the entire *Settled
design* section against HEAD. All five upsert-site line numbers in the table below are still
accurate, as are `DigitreeStore.update` `:307` / `upsert` `:282` / `remove` `:322`,
`enforceCapacity` `fret-sim.ts:590`, and every `relevance.ts` export. No drift; nothing to
re-derive. Additional exact signatures confirmed, to spare the next run the reads:

- `liveness.ts` — `contactSweep(selfId, store, time)` `:78` (success call `:89`, failure `:87`,
  both with `peer.id`/`time` in scope); `recordContactFailure(store, entry, time)` `:101`;
  `recordContactSuccess(store, entry)` `:114` (the `contactFailures > 0` early-out and its stale
  doc comment are at `:113-115`); `reprobeDeadEntries(selfId, store, time)` `:128`.
  `LivenessDeps` (`:17-30`) currently has only `contactAllowed(a, b)` and `isAlive(id)` — add
  `modelFor`, `coordOf`, `now` there per the seam-widening bullet.
- `fret-sim.ts` — `handleRoute` holds `current` (selfId) at both scoring call sites `:711`/`:716`;
  the sweep/reprobe calls at `:482`/`:485` already pass `time`. Constructor builds `LivenessModel`
  at `:124-136` — the natural place to inject the new deps (`modelFor` reads the per-peer model
  map, `coordOf` reads `this.peers`, `now` reads `this.scheduler.getCurrentTime()`).
- `enforceCapacity` (`:590-604`) — its NOTE at `:594-598` states the degenerate-eviction limit and
  must be rewritten when scoring lands (`28.5-sim-metric-guard-case` expects that).

Next run: skip reconnaissance entirely — start editing `liveness.ts` (seam widening) and
`fret-sim.ts` (model map + five sites + protection set) directly, then measure.
<!-- /resume-note -->

## Why

`test/simulation.routing.spec.ts` guards ring routing but cannot tell one plausible ring metric
from another (substituting `clockwiseDistance` or XOR for `minDistance` moves neither threshold),
because the sim's stores are unbounded and gossip-dense: a peer holds 63% of the ring at n=200,
19% at n=1000. Bounding `capacity` today doesn't help: the sim inserts only via
`DigitreeStore.upsert`, which fixes relevance at 0, so every entry ties and eviction degenerates
to ring order (`list()` is key-ordered) — it would carve a contiguous arc from every store. So:
real relevance scoring first, then bound capacity. The guard itself lands in the follow-up ticket.

**Not in scope: changing `src/`.** `src/store/relevance.ts` is consumed as-is.

## Settled design (verified against code 2026-08-21)

**`src/store/relevance.ts` is sim-usable as-is.** Every export is pure over
`(PeerEntry, x, SparsityModel, now)`: `createSparsityModel`, `normalizedLogDistance`,
`observeDistance`, `sparsityBonus`, `initialRelevance`, `touch`, `recordSuccess`,
`recordFailure`. `normalizedLogDistance` already measures with `minDistance`.

**Write-back path exists.** `DigitreeStore.update(id, patch)` (`digitree-store.ts:307`); `upsert`
`:282`, `remove` `:322`. A scoring call is `getById` then score then `update`. No store change
needed. `x = normalizedLogDistance(selfCoord, entry.coord)`.

**Determinism is the sharp trap.** All four scoring entry points default `now = Date.now()`.
Every call must pass `this.scheduler.getCurrentTime()` explicitly or same-seed replay diverges —
surfacing as flaky thresholds in unrelated specs, not as an error. `recencyScore`'s half-life is
60 s against sim runs of 4–60 simulated seconds, so recency is a live term at sim timescales.

**`upsert` stamps `lastAccess` with wall-clock time** and the sim already works around it (both
merge paths carry a comment about the dead-entry skip). Writing `lastAccess: simNow` in the
scoring patch *improves* determinism — but reorders `reprobeDeadEntries` (sorts ascending
`lastAccess`), so `simulation.partition.spec.ts` must be re-run.

**Five `store.upsert` sites in `test/simulation/fret-sim.ts` need scoring** (line numbers
verified this session):

| site | line | call | why |
|---|---|---|---|
| `addPeer` (self-seed) | `:181` | `initialRelevance` | self is eviction-protected anyway |
| `handleConnect` (bootstrap sample) | `:379` | `touch` | real contact, like production bootstrap |
| `processDeliveredMessage`, `neighbor-response` | `:345` | `initialRelevance` **plus explicit `observeDistance`** | hearsay — see deviation |
| `exchangeNeighborsDirect`, both directions | `:574`, `:580` | `initialRelevance` **plus explicit `observeDistance`** | hearsay — see deviation |
| route path success / failure | `handleRoute` `:711`/`:716` | `recordSuccess` / `recordFailure` | via `LivenessModel` seam — see below |

**The `LivenessModel` seam needs widening (found this session, not in the original plan).**
The last row lands inside `LivenessModel` (`liveness.ts`), which owns
`recordContactSuccess`/`recordContactFailure`, shared by `contactSweep` and `handleRoute` —
score there, not at the two call sites, or the sweep and the router drift apart. But the current
signatures cannot score:

- `recordContactSuccess(store, entry)` has no `time` and no `selfId`;
  `recordContactFailure(store, entry, time)` has no `selfId`. Both call sites hold a selfId
  (`contactSweep`'s `selfId` param; `handleRoute`'s `current`) — add the param.
- `LivenessDeps` (the existing seam) needs the per-peer model lookup and clock injected:
  e.g. `modelFor(selfId): SparsityModel`, `coordOf(id): Uint8Array`, `now(): number`.
- `contactSweep` calls `recordContactSuccess` for **every** reachable non-dead entry every tick,
  so scoring at the seam scores the whole store per tick (accessCount and KDE observations grow
  per tick for every swept entry). That is the intended shared-seam behavior — production's
  sweep is proven contact — but state the magnitude in the handoff.
- `recordContactSuccess` currently writes only when `contactFailures > 0`; scoring makes it
  write on every call. Fine — deterministic with the sim clock — but its doc comment ("written
  only when there is one to clear") must be updated.

**The deviation from production, and why it is required.** Production's hearsay rule is
score-once at creation with `initialRelevance`, which deliberately does *not* `observeDistance`.
Porting that verbatim degenerates the sim a second time: if only proven contact feeds the KDE,
each peer supplies ~`maxConnections` observations (≤ 12) plus a few route successes; at
`alpha = 0.03` occupancy stays near zero, `density(x)` stays far under `ideal(x)`, the ratio
stays above `sMax^(1/beta) = 1.8^(1/0.6) ≈ 2.63`, and `sparsityBonus` clamps at `sMax` for every
x. Every entry then scores `0.6 × 1.8 = 1.08` and ties — same degeneracy, one layer down.

So the sim scores *and* observes on the merge paths, and re-scores an already-held entry on each
merge (also a deviation, from `noteDiscovered`'s leave-it-alone rule) so the bonus tracks the
model's growing occupancy. **Record that tradeoff as a `NOTE:` at the merge sites: the sim's KDE
is fed by gossip because the sim has orders of magnitude fewer contact events per peer than a
real node.**

**Nothing is stubbed.** For a hearsay entry written at `simNow`: recency 1.0, frequency 0,
health 0.5 → base is uniform `0.4·1 + 0.2·0 + 0.4·0.5 = 0.6`, and relevance is a stored snapshot
never recomputed, so the sparsity bonus is the only varying term. Proven-contact entries score
legitimately higher — production's shape: a distance-balanced spine plus peers actually talked to.

**One `SparsityModel` per peer** — `Map<string, SparsityModel>` keyed by peer id alongside
`stores`, created in `addPeer`, read wherever a store is. A shared model would make every peer's
bonus a function of every other peer's observations. The model consumes no RNG, so it must not
perturb same-seed replay — `simulation.partition.spec.ts` pins that.

**Port production's protection set into `enforceCapacity` (`fret-sim.ts:590`).** It protects
only self today; once eviction is real, a capacity-bounded sim would evict its own immediate
neighbors. Production protects `2·max(2, m) + 1` ids — self plus `max(2, m)` live members per
side. Use the shipped `ringNeighborsBothSides` (`src/ring/ring-walk.ts`) with the `notDead`
filter (the sim has no membership model); do not hand-roll a two-sided walk.

## Phase 1 measurements — pick the constant, record both numbers

The expectations below are derived arithmetic, not observations — decide from what you measure.

- **Relevance spread across one peer's store.** Log the stored `relevance` distribution for one
  peer after a capacity-bounded run. Expectation: occupancy piles up at high-x KDE centers
  (bonus ≈ 1.05–1.1) while low-x centers stay sparse (clamped at `sMax` 1.8); that gradient makes
  eviction prefer far peers and keep the near/mid spine.
  - **Decision rule: if every entry still clamps at `sMax`, gossip-fed KDE is not enough.**
    Fallback: raise `alpha` for the sim's model only — a sim-local constant passed to
    `createSparsityModel`, documented at the site as sim-local and why. Do not change the
    production default.
- **`capacity`, chosen so routes are genuinely multi-hop.** Existing spec logs knowledge
  fraction 63% at n=200, 19% at n=1000. Target: knowledge fraction in low single-digit percent
  and **p90 hops ≥ 3** under `minDistance`, success ≥ 95%. Sweep `capacity`, pick the smallest
  meeting that. If no capacity reaches p90 ≥ 3 with success ≥ 95%, say so plainly with numbers
  rather than loosening anything.

**Record both measured numbers by editing the `## Measured inputs` section of
`tickets/implement/28.5-sim-metric-guard-case.md`** (the follow-up needs them), and repeat them
in this ticket's review handoff.

## Edge cases & interactions

- eviction vs protection when `capacity < 2m + 1` — production's outcome: protection outranks
  the cap, table stays over capacity; the sim must not loop or evict a protected id
- a peer whose store is smaller than `m` — the two-sided walk returns fewer ids per side;
  protection must not assume it got `m`
- scoring during churn — `contactSweep` prunes departed ids, so a scoring call must tolerate
  `getById` returning `undefined`
- dead-entry re-probe ordering reads `lastAccess` that scoring now writes — re-run
  `simulation.partition.spec.ts`
- a merge that skips a locally-`dead` entry must skip its scoring too, or the skip's point
  (no resurrection, deterministic `lastAccess`) is lost
- bus mode and instant mode take the same scoring path — `processDeliveredMessage` and
  `exchangeNeighborsDirect` must not diverge
- same-seed replay: identical config → byte-identical metrics with the per-peer model map
  (partition spec pins this)
- `capacity` left unset (every existing sim spec) must behave exactly as today — scoring writes
  relevance, but nothing evicts, so no existing threshold may move

## Tests expected

- `test/simulation.partition.spec.ts` green (deterministic replay + dead re-probe ordering)
- full `yarn test` from `packages/fret` — no existing sim threshold may move with `capacity`
  unset

## TODO

- add `Map<string, SparsityModel>` beside `stores`; create per peer in `addPeer`
- wire the five upsert sites per the table, always passing `scheduler.getCurrentTime()`
- widen `LivenessModel`: selfId param on `recordContactSuccess`/`recordContactFailure`, model
  lookup + coord lookup + clock through `LivenessDeps`; update the stale doc comment
- `NOTE:` at the merge sites recording the gossip-fed-KDE deviation and why
- port the `2·max(2, m) + 1` protection set into `enforceCapacity` via `ringNeighborsBothSides`
  + `notDead`
- measure relevance spread; take the sim-local `alpha` fallback if everything clamps at `sMax`,
  documented at the site
- sweep `capacity`; record both numbers into `28.5-sim-metric-guard-case.md` and the handoff
- re-run partition spec, then full `yarn test`
