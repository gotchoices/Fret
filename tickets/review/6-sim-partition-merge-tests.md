----
description: The network simulator can now model a network split and the new simulation spec checks that the two halves keep working on their own and knit back together after the split heals.
files: packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation.partition.spec.ts, docs/fret.md
----
Implements `6-sim-partition-merge-tests`: partition/merge support in the deterministic simulation
harness plus `test/simulation.partition.spec.ts`. `docs/fret.md` *Testing strategy* updated to name
the spec. `message-bus.ts` needed no changes — the cut is enforced at the harness's send/delivery
sites, not inside the bus.

## What was built

- `FretSimulation.partition(groups)` / `heal()` / `crossPartitionBlocked()`, backed by one private
  `reachable(a, b)` predicate (empty map ⇒ reachable; absent id ⇒ group 0, so a mid-split joiner
  lands in the first group). `partition` twice replaces; `heal` with no partition is a no-op;
  duplicate listing = last write wins.
- Every cross-peer site consults the predicate: connect sampling, snapshot sends **and** the direct
  store reads that model the far peer responding, instant-mode exchange (both merge directions),
  leave notices (both arms), route candidates, and bus delivery (a cross-cut in-flight message is
  dropped at delivery and counted via `recordMessageDrop`).
- Contact-failure escalation in `handleStabilize` using the production store fields: one strike per
  tick per unreachable entry (`contactFailures`), `state: 'dead'` at `deadAfterFailures` (new
  `SimConfig.deadAfterFailures`, default 3); successful contact resets the run. Ring-shaped reads
  (`neighborsRight`/`neighborsLeft` in neighbor computation, snapshot collection, coverage,
  `deadNeighborRatio`, route candidates) pass a `state !== 'dead'` filter.
- Bounded dead re-probe per tick (`SimConfig.deadReprobePerTick`, default 2), ascending
  `lastAccess` with id tie-break — the path back after `heal()`.
- `snapshotCoverage()` divides by each peer's *reachable* alive population (per-group alive counts
  when a partition is active); with no partition the arithmetic reduces to the previous global
  formula exactly.

## Deviations from the ticket text (deliberate, commented in code)

- **Full-store contact sweep, not neighbor-window-only strikes.** The design section says "a
  neighbor it cannot reach", but the key test demands *every* cross-side entry dead within
  `deadAfterFailures` ticks and "no store on side A holds a live entry for any side-B peer" —
  unreachable with window-only strikes (entries beyond the m-window are never contacted; a
  window-cascade also takes 3 ticks *per wave*). The sweep merges with the existing global-`alive`
  prune loop (same loop, same position — retiring that oracle stays with `24-sim-router-realism`)
  and models production's near + classify + re-probe passes collapsed into one per-tick pass;
  comment on `contactSweep` says so.
- **Route success check left unfiltered on purpose** (the ticket's dead-filter site list names the
  candidate list only). A still-visible dead entry nearest the key stops an A-side peer from
  crowning itself anchor for a B-owned coordinate, which is what makes an A→B route fail by
  exhaustion during the cut.
- **`crossPartitionBlocked()` counts refused *contacts*, not filtered ids**: sweep strikes,
  re-probe refusals, delivery drops, leave notices, exchange gates. Pool-filtering sites (connect
  sampling, route candidate lists, neighbor sets, coverage math) use the uncounted predicate so
  the number stays interpretable.
- **Determinism scheme for re-probe ordering**: `lastAccess` on dead entries is stamped with *sim*
  time (at mark-dead and at each probe) because `Date.now()` stamps differ across same-seed runs
  and would break replay. To keep those stamps authoritative, merges skip an upsert for a
  locally-dead entry — which also mirrors production ("a re-seed does not resurrect").

## Key validation

`packages/fret`: `npx tsc --noEmit` clean; full `yarn test` green (696 passing). The four
calibrated suites (`simulation.spec.ts`, `churn-scenarios.spec.ts`, `message-bus.spec.ts`,
`sim-profiles.spec.ts`) pass **unedited**, and their logged coverage numbers are unchanged
(87.5% at the usual checkpoints) — the "no partition ⇒ unchanged coverage" rule held.

`test/simulation.partition.spec.ts` (6 tests, ~12 s):
- two-way contiguous split (N=40, k=15, m=8): baseline ≥ 0.8 and pre-cut A→B route; after cut,
  `crossPartitionBlocked() > 0`, no live cross-side entries either direction, side-pure neighbor
  sets, per-reachable-population coverage back ≥ 0.8; A→A route succeeds while A→B fails; mid-split
  joiner sees only group 0; post-heal: zero dead entries anywhere, coverage ≥ 0.8, A→B succeeds.
- singleton split: live neighbor count reaches 0, coverage finite/non-NaN, full recovery.
- three-way split: all pairs escalate, heals from all three groups at once.
- bus mode: messages in flight at the cut are dropped at delivery (counted as bus drops).
- benign edges: heal-without-partition, single-group partition, duplicate listing, replacement.
- deterministic replay of a full partition/heal/route/join schedule (metrics deep-equal).

## Known gaps for review

- **Leaver-during-cut has no dedicated spec case.** The gates are in both `handleLeave` arms and
  the delivery check covers bus notices, but no test partitions and then leaves a peer. Cheap add
  if the reviewer wants it pinned.
- **Bus-mode coverage of the full lifecycle**: the escalate/re-form/heal scenario runs in instant
  mode; bus mode is exercised only for in-flight drops. The gated sites are shared, but a bus-mode
  three-phase run is untested.
- **"Heal never resurrects dropped messages" is by construction** (a dropped delivery leaves the
  pending queue), asserted only indirectly via the drop test.
- **Mid-split joiner arc quirk** (comment in the spec): a joiner's fresh coordinate can land inside
  the *other* side's arc while it belongs to group 0; knowing no cross-side entries it will honestly
  claim anchor-hood for coordinates there, so cross-cut route assertions must run before such a
  join. This is legitimate local-knowledge behavior, not a harness bug, but a reviewer touching the
  route scenario should know the ordering is load-bearing.
- Spec asserts whole-ring average coverage during the cut (each peer measured against its own
  side); it does not additionally compute a per-side average. The side-pure neighbor-set assertion
  covers the "nothing crossed" half of that intent.
