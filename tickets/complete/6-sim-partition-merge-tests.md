----
description: The network simulator can now model a network split, and a new test suite checks that the two halves keep working on their own and knit back together once the split heals.
files: packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation.partition.spec.ts, docs/fret.md
----
Partition/merge support in the deterministic simulation harness, plus the spec that pins it.
Implemented in `f35037c`; reviewed and extended in this pass.

## What shipped

- `FretSimulation.partition(groups)` / `heal()` / `crossPartitionBlocked()`, backed by one private
  `reachable(a, b)` predicate (empty map ⇒ reachable; an id absent from every group ⇒ group 0, so a
  mid-split joiner lands on the first side). `partition` twice replaces; `heal` with no partition is
  a no-op; a duplicate listing is last-write-wins; an id naming no peer now throws.
- Every cross-peer site consults the predicate: connect sampling, snapshot sends and the direct
  store reads that model the far peer responding, instant-mode exchange (both merge directions),
  leave notices (both arms), route candidates, and bus delivery (a cross-cut in-flight message is
  dropped at delivery and counted as a bus drop).
- Contact-failure escalation in `handleStabilize` using the production store fields: one strike per
  tick per unreachable entry (`contactFailures`), `state: 'dead'` at `deadAfterFailures` (new
  `SimConfig.deadAfterFailures`, default 3); a successful contact resets the run. Every ring-shaped
  read passes a `state !== 'dead'` filter.
- Bounded dead re-probe per tick (`SimConfig.deadReprobePerTick`, default 2), ascending `lastAccess`
  with id tie-break — the path back after `heal()`. Merges never resurrect a locally-dead entry.
- `snapshotCoverage()` divides by each peer's *reachable* alive population; with no partition the
  arithmetic reduces to the previous global formula exactly.

## Review findings

**Read first:** the implement diff (`git show f35037c`), then the harness in full, then the
handoff summary. Aspects swept: single-purpose functions, DRY, resource cleanup (none — pure
in-memory harness), error handling, type safety, determinism, file size, comment accuracy, and
whether the assertions can actually fail.

### Fixed in this pass (minor)

- **The neighbor-set computation consulted the global reachability oracle, which made the spec's
  headline "neighbor sets are side-pure" assertion vacuous.** `handleStabilize` filtered
  `peer.neighbors` through `reachable()`, so a cut emptied the cross-side half of every neighbor
  set on the very next tick whether or not contact-failure escalation worked at all — the exact
  oracle-assistance `plan/24-sim-router-realism` objects to, newly introduced. Removed: the
  `state !== 'dead'` filter (local knowledge, written by the peer's own failed contacts) is now the
  only partition-awareness there, so the assertion fails if escalation regresses. Nothing crosses
  the cut in the meantime because the outbound exchange is separately gated. Zero effect on the
  four calibrated suites: with no partition active the predicate was always true.
- **`partition()` accepted an id naming no peer, and a typo made the split a silent no-op.** An
  unknown id is indistinguishable at read time from a mid-split joiner (both absent from the map),
  so `partition([['peer-000x'], rest])` sorted every *real* peer into one group and blocked
  nothing — a test written that way passes while testing nothing. Now throws; pinned by the
  benign-edges case.
- **The spec's `pump` helper processed every event in a window at the window's timestamp.**
  `for (const evt of scheduler.advanceTo(t))` shifts the whole batch and leaves the clock at `t`
  before any event is handled, so every stabilization tick in a phase saw the same simulated time —
  and the dead-entry re-probe stamps and orders candidates by that time. Rewritten to drive one
  event at a time at its own time, then park the clock. (The pattern is pre-existing in
  `churn-scenarios` / `message-bus` / `sim-profiles`, but only as a warm-up phase before a
  `nextEvent` loop; this spec used it for every phase.)
- **`snapshotCoverage` had an unreachable `?? 1` fallback** on a group lookup whose map is built
  from the same list it iterates. Replaced with an asserted lookup, so a future change that *can*
  miss fails loudly instead of silently dividing by 1.
- **`contactSweep`'s comment claimed strike independence comes from tick spacing in wall-clock
  time.** It comes from one-strike-per-tick; a driver that runs several ticks at one timestamp
  still strikes once each. Corrected.
- **The `docs/fret.md` Testing-strategy entry was one ~90-word run-on sentence.** Broken into
  sub-bullets and extended to cover the two new scenarios.

### Fixed in this pass (test coverage the handoff listed as gaps)

- **Leaver during a cut** — new case. Departs between ticks, before escalation, so both sides still
  hold a live entry and only the notice can explain the removal: asserts the fan-out books exactly
  `|farSide|` refusals, that no near-side store still holds the leaver, that at least one far-side
  store does, and that the far side sweeps it up on its own afterwards.
- **Bus-mode full lifecycle** — new case. The whole cut → escalate → heal arc over the message bus
  (previously bus mode was exercised only for in-flight drops).

### Recorded as tripwires, not tickets

- **"A→B route fails during the cut" rests on dead entries staying in the store.** The anchor check
  in `handleRoute` reads unfiltered on purpose so a boundary peer cannot crown itself anchor for a
  far-side coordinate; nothing evicts dead entries today, but if that changes the assertion inverts
  into a pass for the wrong reason. `NOTE:` at the `handleRoute` anchor read.
- **`snapshotCoverage()` can never reach 1.0.** Both walks are anchored *on* the peer's own
  coordinate, so each yields self plus m−1 others against a denominator of 2m — a fully converged
  ring reports exactly (2m−2)/2m. That is why every partition phase logs 87.5% at m = 8, and
  `simulation.spec.ts` logs 0.75 at m = 4. Pre-existing, the same self-anchored off-by-one
  `docs/fret.md` describes for the eviction protection set, and harmless as the relative measure
  every caller uses it as — but a future author raising a threshold to 0.9 would find it
  unsatisfiable. `NOTE:` on `snapshotCoverage`.

### Filed as an arm on an existing ticket

- **`fret-sim.ts` is 889 lines in one class** (`(Get-Content -LiteralPath …).Count`), owning
  placement, scheduling, the stabilization tick, the reachability model, liveness escalation,
  routing, and metrics. Appended as an arm to `plan/21-cleanup-tests` (the ticket that already owns
  test housekeeping and already names this file) rather than a new ticket, with the natural seams
  named and a sequencing note against `24-sim-router-realism`.

### Checked and found clean

- **Determinism.** `DigitreeStore.upsert` stamps `lastAccess` with `Date.now()`, which would break
  same-seed replay if it reached an ordering decision. It cannot: the only order-sensitive read is
  the dead-entry re-probe, an entry becomes dead only via `contactSweep` (which stamps simulated
  time), and both merge paths skip a locally-dead entry so no wall-clock stamp can land on one.
  `enforceCapacity` sorts on relevance, which `upsert` fixes at 0, so it degenerates to the tree's
  key order — stable and deterministic. The replay test passes; re-verified after the `pump` change.
- **Store-mutation-during-iteration.** `contactSweep` removes and updates while iterating; safe
  because `DigitreeStore.list()` materialises a fresh array. `update` on a missing id is a no-op,
  so the prune-then-continue ordering cannot throw.
- **The `notDead` filter's effect on the four calibrated suites is nil, not merely small.** Without
  a partition `contactAllowed` always succeeds, so `contactFailures` never increments and no sim
  entry is ever marked dead — every `notDead` filter, including the one added to
  `deadNeighborRatio`, is inert. That is what makes the "unchanged coverage" claim in the handoff
  true rather than lucky; it also means `deadNeighborRatio`'s ≤ 20% assertion in
  `churn-scenarios.spec.ts` was not silently weakened.
- **Complexity.** `contactSweep` and `reprobeDeadEntries` each walk the whole store per peer per
  tick, i.e. O(N²) per tick where the previous prune loop was O(N) per peer. No concern at the
  sizes the suite runs (max N = 100 → 10⁴ ops/tick).
- **Type safety.** No `any` in the diff; `PeerEntry` imported as a type; the one non-null assertion
  added is justified in a comment. `npx tsc --noEmit` clean.
- **Docs.** Every file the change touches was re-read against the new reality. `docs/fret.md`
  *Testing strategy* was the only section describing this behavior; the *Partition and merge hooks*
  section covers repo nonces at the application layer and is untouched by harness work. There is no
  `test/simulation/README`; documenting the harness's invariants is already owned by
  `backlog/plan/3-docs-simulator-invariants`.

### Empty categories

- **Major findings: none.** Nothing in the diff produces a wrong result, corrupts state, or leaks a
  resource; the oracle-shortcut above was the closest, and it is a fidelity defect in a test
  harness that was cheaper to fix inline than to file.
- **Blocked / decisions for a human: none.** No finding needed a judgment call outside the code.
- **Accepted-tradeoff `NOTE:`s at any finding site: none encountered**, so nothing was re-filed
  against a decision already made.

## Validation

`packages/fret`: `npx tsc --noEmit` clean. Full `yarn test` green — **698 passing**, 0 failing
(696 before this pass, +2 from the new scenarios). The four calibrated suites
(`simulation.spec.ts`, `churn-scenarios.spec.ts`, `message-bus.spec.ts`, `sim-profiles.spec.ts`)
pass unedited with their logged coverage numbers unchanged. `test/simulation.partition.spec.ts` is
8 tests, ~15 s.
