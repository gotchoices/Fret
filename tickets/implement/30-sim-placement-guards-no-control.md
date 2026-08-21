description: Three simulation tests claim to prove that different peer-layout strategies produce different ring shapes, but two of them would pass just as happily against the default layout, so they prove nothing; give them the same both-directions check a sibling test already uses.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/churn-scenarios.spec.ts, packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation/sim-metrics.ts, packages/fret/test/simulation/placement.ts
difficulty: easy
---

<!-- resume-note -->
Second interrupted run, again on a BUDGET_WARNING before any file edit — still nothing to unwind,
still a fresh start. This run additionally read `placement.ts`, `fret-sim.ts` in full, and
`sim-metrics.ts` in full (all confirmed, safe to trust — no need to re-read those three end to
end again, though line numbers may drift if a prior task touched them, which none has):

- `packages/fret/test/simulation/placement.ts` — confirmed exact contents:
  - `export type PlacementStrategy = 'uniform' | 'clustered' | 'skewed' | 'clumped-joiners'`
  - `export interface ClusterConfig { numClusters: number; spreadBits: number }`
  - `CoordPlacement.generateCoord(index, isJoin)` switches on `this.placement` (default via
    `opts.placement ?? 'uniform'`, so omitting `placement` in a sim config IS the uniform arm —
    no separate `'uniform'` string needs to be passed for the "wrong arm" comparisons the design
    decisions below call for, though passing it explicitly is equally valid and arguably clearer
    at each new call site).
  - `clusteredCoord()` needs `this.clusterCenters`, which is only populated in the constructor
    when `opts.placement === 'clustered' && opts.clusterConfig` — so a clustered-arm sim config
    MUST pass both `placement: 'clustered'` and a `clusterConfig`, or `clusterCenters` stays
    `undefined` and `centers!` throws at runtime.
- `packages/fret/test/simulation/fret-sim.ts` — confirmed `SimConfig` interface (line ~65) takes
  `placement?: PlacementStrategy` and `clusterConfig?: ClusterConfig` directly as sim-level
  fields (not nested under a sub-object), consumed at `FretSimulation` construction (~line 132)
  to build the one `CoordPlacement` instance for that sim run — so each of the two arms (clustered
  vs uniform) needs its own separate `new FretSimulation({...})` instance; there is no way to
  switch strategy mid-run. `SimMetrics` is read via `sim.metrics.finalize()` per `run()` (line
  293) or manually via `sim.metrics.finalize()` any time (metrics collector accumulates as events
  process). `avgRoutingHops` and `routingHops`/`successfulRouteHops` are computed in `finalize()`
  in `sim-metrics.ts`, confirmed below.
- `packages/fret/test/simulation/sim-metrics.ts` — confirmed in full: `recordRoute(success, hops)`
  pushes to `routingHops` always and to `successfulRouteHops` only on success;
  `finalize()` computes `avgRoutingHops` as the mean of all of `routingHops` (successes and
  failures alike). No precomputed average of `successfulRouteHops` exists — if design decision 3
  ends up preferring that one, average `metrics.successfulRouteHops` by hand in the test.
- `packages/fret/test/churn-scenarios.spec.ts` — grep-confirmed exact line numbers at HEAD (no
  edits landed yet, so still current): `coordToBigInt` L338, `maxPeersInOneSpacingArc` L355,
  `PlacementCase` interface L373, `PLACEMENT_SEEDS = [8008, 8009, 8010, 4242, 99]` L379,
  `MAX_PEERS_IN_ONE_SPACING_ARC = 7` L394, `placementReading` L396, `assertPlacementSeparates`
  L430. Two call sites of `assertPlacementSeparates`: L326 (`'batch burst'`) and L333
  (`'steady trickle'`). Full body of this section (L337–453) was NOT re-read this run (grepped
  only) — read it directly before extracting the shared helper in design decision 1, since exact
  signatures/types of `coordToBigInt`/`maxPeersInOneSpacingArc`/`PlacementCase` matter for the
  lift.
- `packages/fret/test/message-bus.spec.ts` lines ~292–406 (the `describe('Placement
  distributions', ...)` block) — NOT re-read this run either (no budget left); prior run's notes
  on it, reproduced from the first resume-note, still stand and are unverified against current
  line numbers: two vacuous cases (`clustered placement: peers cluster around centers` using a
  bare `largestGap > medianGap` check; `clustered placement: inter-cluster routing takes more
  hops` which never sets `placement: 'clustered'` despite the `clusterSim` variable name and only
  asserts `routingAttempts === 10`), plus one already-correct `skewed placement` case to leave
  alone.

Two runs in a row have now spent their whole budget on re-reading context rather than writing
code. If a third run picks this up, skip straight to editing — read only
`churn-scenarios.spec.ts` L337–453 and `message-bus.spec.ts` L292–406 (both still unread in full),
confirm they match the summaries above, then go straight to the TODO list. Do not re-read
`placement.ts`, `fret-sim.ts`, or `sim-metrics.ts` again — they are confirmed above and nothing
in this repo has touched them.

---

## Context (already researched — do not re-derive)

`test/churn-scenarios.spec.ts` (lines ~337–453) already has the correct shape for this class of
test, landed by the now-complete `sim-placement-test-vacuous` ticket:

- `coordToBigInt` — 32-byte big-endian coord → BigInt
- `maxPeersInOneSpacingArc(coords)` — scans an arc one even-spacing wide (`ringSize / peers`)
  anchored at each peer, wrapping, returns the most peers any such arc contains. This is the
  statistic with real separating power for "are peers clumped".
- `PlacementCase`, `PLACEMENT_SEEDS = [8008, 8009, 8010, 4242, 99]`
- `MAX_PEERS_IN_ONE_SPACING_ARC = 7` — measured threshold, see the comment above it for the
  measured table (fixed arm maxes at 4, buggy arm mins at 11).
- `placementReading(placement, seed, c)` — builds a `FretSimulation`, runs it, returns the
  `maxPeersInOneSpacingArc` reading over alive peers.
- `assertPlacementSeparates(label, c)` — runs `placementReading` under **both** `'uniform'` and
  a deliberately-wrong placement, for every seed, and asserts the fixed arm reads ≤ threshold
  **and** the wrong arm reads > threshold. This is the pattern to copy: a threshold that can't
  fail is not a test.

`test/message-bus.spec.ts`'s `describe('Placement distributions', ...)` block (lines ~292–406)
has three cases; two have no separating power (full analysis already in the ticket history —
`git log`/prior ticket `30-sim-placement-guards-no-control` in `tickets/complete/` or
`tickets/plan/` history has it, but the short version is above). Read `clustered placement: peers
cluster around centers` and `clustered placement: inter-cluster routing takes more hops` at their
current line numbers before editing — line numbers will drift once you touch the file.

`test/simulation/fret-sim.ts` exports `PlacementStrategy` (already imported as a type in
`churn-scenarios.spec.ts`) — check its literal union for the exact strategy names (`'uniform'`,
`'clustered'`, `'skewed'`, `'clumped-joiners'`, and whatever else exists) and the shape of
`clusterConfig` (`{ numClusters, spreadBits }` per the existing `clustered placement` case).

`test/simulation/sim-metrics.ts` (~line 31) exposes `avgRoutingHops` on the finalized metrics
(`sim.metrics.finalize()`), computed from `routingHops` (all attempted routes, success or not) —
use this for the routing-comparison case below.

## Design decisions (resolved — do not leave open)

**1. Lift the shared helper.** Move `coordToBigInt`, `maxPeersInOneSpacingArc`, `PLACEMENT_SEEDS`,
and `MAX_PEERS_IN_ONE_SPACING_ARC` out of `churn-scenarios.spec.ts` into a new shared module,
`packages/fret/test/simulation/placement-assertions.ts`, and import from both spec files. Leave
`PlacementCase`, `placementReading`, and `assertPlacementSeparates` in `churn-scenarios.spec.ts`
as-is (they're shaped around that file's join/churn cases specifically — `PlacementCase` has
`churnRatePerSec`/`batchJoin` fields that don't apply to the clustered/skewed cases here) but have
them import the lifted primitives from the new module instead of defining their own. Do not
duplicate `coordToBigInt` / `maxPeersInOneSpacingArc` a third time — that duplication is exactly
the drift this ticket exists to stop.

**2. `clustered placement: peers cluster around centers`** — replace the `largestGap > medianGap`
assertion (arithmetic identity for any non-uniform spacing, proves nothing) with a
both-directions check using `maxPeersInOneSpacingArc`, mirroring `assertPlacementSeparates`'s
shape: run the same sim config once with `placement: 'clustered'` and once with the default
(omit `placement`, or pass `'uniform'` if that's a valid explicit value — check `fret-sim.ts`),
same seed, and assert the clustered reading is meaningfully higher than the uniform one (not just
`>` — pick a threshold with margin, the same way `MAX_PEERS_IN_ONE_SPACING_ARC` was measured with
margin). Measure actual readings for `n: 30, k: 15, m: 8, clusterConfig: { numClusters: 3,
spreadBits: 32 }` at a couple of seeds before picking the threshold, the same way the existing
table in `churn-scenarios.spec.ts` (~line 382) was built — don't guess a number.

**3. `clustered placement: inter-cluster routing takes more hops`** — currently builds a sim with
**no `placement` set** (runs the default uniform layout despite the `clusterSim` variable name)
and asserts only `routingAttempts === 10`, i.e. that routes were attempted, never reading a hop
count. Fix: make it the comparison its name promises. Run two sims with identical config except
`placement` (`'clustered'` vs default/`'uniform'`), same seed, same warm-up, same scheduled
routes (pick target coordinates that land across cluster boundaries so the comparison is
meaningful — the existing target-generation loop at ~line 355-358 is fine to reuse for both
runs), and assert `metrics.avgRoutingHops` for the clustered run is higher than for the uniform
run. Use `successfulRouteHops`-derived average instead of `avgRoutingHops` (all attempts) only if
you find the all-attempts average too noisy when you measure it — check both, use whichever
actually separates cleanly at your chosen seed(s), and note in a comment which you picked and why
(mirroring the `successfulRouteHops` doc-comment in `sim-metrics.ts` about why the two differ).
Do not fall back to renaming the test to match weaker behavior — this ticket already decided the
real comparison is worth the extra sim run; the file-level `tradeoffs:` note about doubled runtime
already accounts for it.

**4. `skewed placement: some regions are denser than others`** — already correct (reads its own
comment reasoning about why a weaker assertion would also pass uniform). Leave it. Optionally fold
its `lowerHalf`/`upperHalf` coord-collection loop onto the shared `coordToBigInt` helper for
consistency (it currently hand-rolls the same big-endian conversion inline) — cosmetic, do it only
if it's a trivial swap, skip if it adds noise.

## Edge cases & interactions

- **Seed sensitivity**: any new threshold must be measured across multiple seeds (reuse
  `PLACEMENT_SEEDS` or a subset) before being hard-coded, the same way `MAX_PEERS_IN_ONE_SPACING_ARC`
  was — a threshold measured at one seed is exactly the vacuous-guard failure mode this ticket
  fixes, just moved. Record the measured table in a comment (see the existing example at
  `churn-scenarios.spec.ts` ~line 382-393) so a future reader can re-derive the number's validity
  instead of trusting it blindly.
- **Runtime cost**: each rewritten case now runs its simulation twice (once per layout arm). The
  `describe` block already sets `this.timeout(60000)`; confirm the suite still finishes well
  inside that after the change — if not, adjust `durationMs`/`stabilizationIntervalMs` down for
  these specific cases (churn-scenarios.spec.ts's `placementReading` already deliberately uses a
  coarser `stabilizationIntervalMs: 5000` for exactly this reason — same trick applies here since
  stabilization cadence doesn't move either statistic).
- **`clusterConfig` only applies to `placement: 'clustered'`** — verify passing it alongside a
  `'uniform'`/default comparison run is a no-op (should be ignored, not throw) rather than
  accidentally leaking cluster behavior into the "wrong" arm; if `fret-sim.ts` doesn't ignore it
  cleanly, omit `clusterConfig` from the uniform-arm sim construction entirely rather than relying
  on it being ignored.
- **Route target selection for case 3**: targets must actually land such that some routes cross
  cluster boundaries under the clustered layout, or the hop-count comparison will show no
  difference — verify this empirically (print/log hop counts per run while measuring the
  threshold) rather than assuming the existing target-generation loop produces boundary-crossing
  targets.

## TODO

- Read `packages/fret/test/simulation/placement.ts` for the exact `PlacementStrategy` literal
  values and `ClusterConfig` field names before writing any new sim config
- Create `packages/fret/test/simulation/placement-assertions.ts` with the lifted
  `coordToBigInt`, `maxPeersInOneSpacingArc`, `PLACEMENT_SEEDS`, `MAX_PEERS_IN_ONE_SPACING_ARC`
- Update `churn-scenarios.spec.ts` to import those from the new module instead of defining them
  locally; keep `PlacementCase`/`placementReading`/`assertPlacementSeparates` in place
- Rewrite `clustered placement: peers cluster around centers` in `message-bus.spec.ts` to assert
  both directions via `maxPeersInOneSpacingArc`, with a measured-and-commented threshold
- Rewrite `clustered placement: inter-cluster routing takes more hops` to run clustered vs
  uniform and compare `avgRoutingHops` (or `successfulRouteHops` average, whichever separates
  cleanly), with a measured-and-commented threshold/margin
- Leave `skewed placement: some regions are denser than others` behavior unchanged; optionally
  swap its inline coord-conversion loop for the shared `coordToBigInt` if trivial
- Run `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" "test/churn-scenarios.spec.ts" --timeout 60000` and confirm all cases pass and finish in reasonable wall time
- Run `cd packages/fret && npx tsc --noEmit` to confirm no type errors from the new shared module


## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
