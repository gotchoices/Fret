----
description: Routing could hand a request to a peer farther from the key than the sender, so messages drifted backwards; forwarding now refuses any hop that is not strictly closer, and answers with routing hints instead.
files: packages/fret/src/selector/next-hop.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/nexthop-cost.spec.ts, packages/fret/test/iterative-lookup.spec.ts, docs/fret.md
----

## What shipped

### Selector (`packages/fret/src/selector/next-hop.ts`)

`NextHopOptions` gained `selfCoord?: Uint8Array` — the caller's own ring coordinate. When
the caller is itself within the near radius of the target, near-mode eligibility is
restricted to candidates strictly closer to the target than the caller. If none remain the
selector returns `undefined`; there is deliberately **no** fall-through to far mode,
because every far candidate sits beyond `nearRadius ≥ selfDist` and is therefore
guaranteed worse than staying put. Omitting `selfCoord` leaves behavior unchanged, and the
option is ignored entirely on the legacy (no-`nearRadius`) path.

Second arm: `weightsForContext(near, confidence)` was being recomputed per candidate though
it depends only on `(near, confidence)`. Hoisted to two values computed once per call.
Pure hoist, no behavior change.

### Service (`packages/fret/src/service/fret-service.ts`)

`buildNextHopOptions` takes an optional `selfCoord` and `routeAct` supplies it. It is
withheld when *originating* a lookup (`iterativeLookup`) and on the anchor-ranking path —
see the deviation below. `selfCoord()` is memoized, so the added `await` on the forward
path costs one hash for the lifetime of the service.

### Deviation from the implement ticket

The ticket's TODO asked for `selfCoord` to be threaded through `iterativeLookup` too. The
implementer did not, and was right not to. A node *originating* a lookup is aiming at the
key's **cluster** — the k peers around the key, spanning both sides — not the key point, so
an originator that is itself the peer nearest the key must still contact a cluster member,
and every one of them is farther from the key than it is. The filter would empty, the walk
would report `exhausted`, and the activity would silently never run. Two existing tests
caught this when the implementer tried it. Review re-derived the argument independently and
agrees; `test/iterative-lookup.spec.ts` now pins it with a deterministic regression test.

## Review findings

Read the implement diff (`83ea31c`) before the handoff summary, then the surrounding
selector, `routeAct`, `iterativeLookup`, cohort assembly, and distance code.

### Verified correct (no action)

- **The "no fall-through to far mode" argument holds.** `selfIsNear` implies
  `selfDist ≤ nearRadius`, and a far candidate has `dist > nearRadius`, so every far
  candidate really is worse than staying put. Checked, not taken on trust.
- **The claim that the filter only ever changes the empty case holds.** If any candidate is
  strictly closer than self, the minimum-distance candidate is strictly closer, is therefore
  near, and survives the filter — so near mode picks the same peer either way.
- **The originator deviation holds**, on the reasoning above, and `iterativeLookup`'s
  `visited` set does provide the loop protection the filter would have provided.
- **`routeAct` really does have a strictly-closer hop available in the normal case.** The
  implement handoff and the design doc both claimed "at least two peers sit closer"; that
  is not quite the right statement, because the in-cluster index is a position in the
  *alternating two-sided* cohort, not a distance rank. The correct statement — proved and
  now written into the doc — is that index ≥ 2 puts at least *one* peer (the nearer of the
  two anchors) strictly closer. The conclusion the implementer drew from it is unaffected.
- **Ring wrap-around**: everything measures with `minDistance`, including the new
  `selfDist`, so a candidate across the seam is measured as adjacent.
  `test/ring-wrap-distance.spec.ts` still passes.
- **The near-radius saturation behavior** the handoff flagged as a gap is already a recorded
  accepted tradeoff — there is a `NOTE:` at `computeNearRadius` in `payload-heuristic.ts`
  stating that below `n_est ≈ 2·β·k` the radius covers the whole ring and selection becomes
  purely greedy, and that this is the right reading at that scale. Its revisit condition
  (profiles wanting the connection bias back on small rings) has not tripped. Not re-filed.

### Major — filed as a ticket

- **Far mode has no self-distance floor, so the invariant this ticket established holds
  only when the node is near the key.** `tickets/backlog/bug-far-mode-self-distance-floor.md`.
  The distance term is a log-scale position over 256 bits, so one binary order of magnitude
  is worth `w_d/256 ≈ 0.002`, against a flat connection bonus of `0.3–0.5`. Measured by
  driving the shipped selector directly: a connected peer ≈2^40 from the key beats a
  disconnected peer ≈2^24 from it at every confidence level. A far node whose closer peers
  are all excluded as breadcrumbs or undialable will therefore still take a backwards hop.
  Dormant below ≈60 peers (the near radius saturates the ring), reachable above it. Filed at
  the invariant level — "a hop is never farther from the key than the node choosing it, in
  every mode", plus a generalized walk test — rather than as a weights tweak, since the
  point fix would leave the class open.

### Minor — fixed in this pass

- **The same rationale was written out six times** — the option doc, the filter comment, the
  `buildNextHopOptions` JSDoc, an inline comment in `iterativeLookup`, a test comment, and
  four doc bullets — with the `buildNextHopOptions` JSDoc alone running fourteen lines above
  a six-line function. Consolidated: `docs/fret.md` keeps the full argument, the code states
  the rule tightly and points there.
- **Doc overclaim.** The new doc text asserted "Forward progress is a property of the
  selector, not of the loop guards" without qualification. That is only true in near mode.
  Qualified, and the far-mode gap is now stated in the doc rather than left implicit.
- **Doc inaccuracy about `pickAnchors`.** The doc explained why anchor selection "withholds"
  the node coordinate; in fact `pickAnchors` calls the selector with no options at all and so
  runs the legacy path, where the coordinate is ignored regardless. Corrected.
- **Two non-null assertions (`selfDist!`)** replaced by narrowing the value once into a
  `nearSelfDist` binding that is `undefined` unless the filter applies.

### Minor — test gaps closed in this pass

- **The "no fall-through to far mode" branch was not actually tested.** The implementer's
  first test uses a saturated near radius, so no far candidate exists in the pool and the
  `undefined` result is indistinguishable from "there was nothing to fall through to". Added
  a test with a *connected* far candidate present, which far mode would happily have picked.
- **Multi-hop convergence was untested** — the handoff's own first listed gap. Added a
  deterministic selector-level walk over a hand-laid twelve-peer ring where each hop sees
  only its ring neighbours, asserting the distance to the key falls on every hop and the walk
  reaches the nearest peer. It regresses if the strict filter is removed: at the nearest peer
  the walk would otherwise pick a farther one instead of terminating. This is where the
  invariant is actually provable; the simulation harness cannot prove it today (see
  `tickets/plan/24-sim-router-realism.md`, which notes nothing under `test/simulation/`
  imports the shipped selector).
- **`selfCoord` on the legacy path** had no test pinning that it is ignored. Added.

### Considered and not filed

- **No service-level test that `routeAct` returns a `NearAnchor` because the strict filter
  emptied** — the handoff's second listed gap. Left open deliberately. The selector half is
  now covered at the unit level, and the service half is the pre-existing `if (next)`
  fall-through that the breadcrumb-rejection test already exercises. Constructing the state
  live requires searching for a key that puts the node at cohort index ≥ 2 and then
  breadcrumbing its closer peers, which buys a slow, id-order-dependent test for a branch
  that is two lines of pre-existing code.
- **The `weightsForContext` hoist has no behavioral test**, as the handoff notes. Correct —
  by construction nothing can distinguish per-candidate from per-call weights, so a test
  would only assert the compiler works.
- **Networked tests tear down outside a `finally`,** so a failing assertion leaks nodes.
  File-wide pre-existing pattern, not introduced here, and already inside the scope of
  `tickets/plan/20-cleanup-tests.md`.

## Validation

From `packages/fret/`:

- `npx tsc --noEmit` — clean.
- `yarn test` — **369 passing, 0 failing** (~5 min). No pre-existing failures surfaced, so
  no `.pre-existing-error.md` was written.
