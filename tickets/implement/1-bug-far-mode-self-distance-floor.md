----
description: When a node is still far from a key, it can hand a message to a peer that sits farther from that key than the node itself, because "already connected" outweighs distance by an enormous margin — so messages move away from where they are headed and can run out of hops before arriving.
files: packages/fret/src/selector/next-hop.ts, packages/fret/src/ring/distance.ts, packages/fret/test/nexthop-cost.spec.ts, packages/fret/test/cohort.properties.spec.ts, docs/fret.md
difficulty: medium
repro: verified
----

## What is wrong

`chooseNextHopCost` in `packages/fret/src/selector/next-hop.ts` partitions candidates into
*near* (ring distance to the key ≤ `nearRadius`) and *far*, and treats the two differently:

- **Near candidates** are ordered by strict distance, and — since
  `selector-near-strict-improvement` landed — filtered against the node's own distance to
  the key, so a near hop can never be farther from the key than the node choosing it.
- **Far candidates** are ordered purely by the cost function, with no reference to the
  node's own distance at all. The node's coordinate arrives as `NextHopOptions.selfCoord`
  and is consulted only by the near branch (`nearSelfDist`, `next-hop.ts:154-186`).

Inside that cost function the distance term cannot compete with the connection bonus:

- distance contributes `w_d · normalizedLogMagnitude(dist)`. That helper
  (`src/ring/distance.ts:70`) returns a **log-scale position in [0,1] over 256 bits**, so
  one binary order of magnitude of ring distance moves it by `1/256 = 0.00390625`, worth
  `w_d/256 ≈ 0.0016` of cost at the far weight `w_d = 0.4`.
- connectedness contributes a flat `w_conn` of 0.3–0.5 (`weightsForContext`, `cost`).

A disconnected candidate must therefore be **256 binary orders of magnitude** closer than
a connected one to win — but ring distance only spans 256 orders in total, so among
candidates drawn from the same neighbourhood this never happens. When connectedness
differs, far mode ignores distance.

## Reproduction (verified, this ticket)

Driven against the shipped selector via `node --import ./register.mjs` from
`packages/fret/`, with hand-placed coordinates and the key at coordinate 0 so a
candidate's distance equals its coordinate. All-far pool (`nearRadius = 0`):

| Candidates | confidence 0 | 0.5 | 1.0 |
|---|---|---|---|
| connected at 2^200 vs disconnected at 2^0 | connected | connected | disconnected |
| connected at 2^40 vs disconnected at 2^24 | connected | connected | connected |
| connected at 2^254 vs disconnected at 2^253 | connected | connected | connected |

Only a 200-order gap at maximum confidence flips it. The realistic rows — candidates a
handful of orders apart — go to the connected-but-farther peer at every confidence level.

Second measurement, the invariant itself, at a realistic scale
(`computeNearRadius(1000, 15)` ⇒ `nearRadius ≈ 2^251`, so self at 2^254 is *far*):

```
self at 2^254; connected candidate at 2^254 + 2^250 (farther than self),
               disconnected candidate at 2^253 (closer than self)
confidence 0 / 0.5 / 1.0  ->  connected-behind   *** farther from the key than self ***
```

Third: with `selfCoord` supplied and every candidate behind the node, near mode returns
`undefined` while far mode returns a backwards hop.

**Far mode is not a rare regime at scale.** `nearRadius` at `n_est = 1000, k = 15, β = 2`
is ≈ 2^251 against a maximum ring distance of 2^255, so roughly 94% of the distance range
is far. Far mode is the *normal* case for the early hops of a lookup on a ring FRET is
built for. (It is genuinely unreachable below `n_est ≈ 2·β·k` ≈ 60, where the radius
saturates the ring — the accepted-tradeoff `NOTE:` at `computeNearRadius` in
`src/service/payload-heuristic.ts` records that, and its revisit condition has not tripped.)

## Root cause

One site, one cause: **the cost function's terms are not commensurable with its distance
term.** `w_conn`, `w_q` and `w_b` are absolute cost units, while distance is a normalized
log position whose entire dynamic range is 1.0 spread over 256 orders. Any flat term of
0.1 or more silently outranks every distance difference a real candidate pool can express.
The missing self-distance floor is what turns that mis-scaling into a routing defect.

## What to build

**One invariant, applied in every mode of the selector: when the caller supplies its own
coordinate, the chosen hop is strictly closer to the key than the caller — or there is no
hop.** Then make the cost terms commensurable so the connected-first bias remains
meaningful but bounded.

### Arm 1 — generalize the self-distance floor (the correctness fix)

The existing near-only filter can be *replaced* by a general one rather than duplicated,
and the replacement is strictly simpler. Today (`next-hop.ts:154-186`):

```ts
const selfDist = opts.selfCoord ? minDistance(opts.selfCoord, targetCoord) : undefined;
const nearSelfDist = selfDist !== undefined && isNear(selfDist, nearRadius) ? selfDist : undefined;
// ... later, applied to nearCandidates only
```

Proposed: drop `nearSelfDist`, and filter the whole `scored` array on
`lexLess(s.dist, selfDist)` **before** partitioning into near/far. This subsumes the
current behavior rather than changing it — verify each branch while implementing:

- *Self near, some near candidate closer* — the closest candidate is closer than self and
  therefore also near, so it survives and near mode picks the same peer. Unchanged.
- *Self near, no near candidate closer* — every far candidate has `dist > nearRadius ≥
  selfDist`, so the general filter removes them too and the result is `undefined`. This is
  exactly today's deliberate "no fall-through to far mode", now falling out of the rule
  instead of being a special case. Keep the comment explaining why.
- *Self far, a near candidate exists* — a near candidate has `dist ≤ nearRadius < selfDist`,
  so it always survives. Unchanged.
- *Self far, all candidates far* — **the only behavior change**, and the fix: a candidate
  behind the node is now ineligible.
- *No `selfCoord`* — no filter, unchanged. Legacy (no-`nearRadius`) path untouched.

Use a strict floor (`dist < selfDist`), not a slack past self. The subsumption argument
above depends on it, and it matches near mode. Slack belongs among candidates (arm 2), not
against the node's own position.

**Returning no hop here is safe, by the same argument the near-mode work established** and
that `docs/fret.md` already records: `routeAct` forwards only when it is *not* in-cluster,
i.e. it sits at index ≥ 2 of the key's alternating two-sided cohort, which puts at least
one peer (the nearer of the two anchors) strictly closer to the key than it is. That
argument is about cohort position and is independent of the near radius, so it carries to
far mode unchanged. No-hop therefore means the closer peers were all excluded as
breadcrumbs or as undialable — a genuinely exhausted local view — and both callers already
handle it (`routeAct` answers with a `NearAnchor`, `iterativeLookup` reports `exhausted`).

**Which call sites change.** Only `routeAct`'s forward path
(`fret-service.ts:1754`) supplies `selfCoord`. `iterativeLookup` deliberately withholds it
(originator aims at the key's *cluster*, every member of which is farther from the key than
an originator sitting nearest it — see the deviation recorded in
`tickets/complete/9-selector-near-strict-improvement.md`), and `pickAnchors` calls the
selector with no options at all and so runs the legacy path. Do not change either.

### Arm 2 — make the cost terms commensurable (the root cause)

Express the non-distance preferences as an **allowance in binary orders of ring distance**
rather than as flat cost units, so "prefer a connected peer even if slightly farther" has a
stated bound. Recommended shape — settle the exact constants while implementing, and state
the reasoning in a comment:

```ts
const ORDERS = 256; // dist.length * 8 — the full dynamic range of normalizedLogMagnitude

// Connected-first bias, in binary orders of ring distance a connected peer may give up.
// 8 orders = one byte, matching the legacy path's `connectedToleranceBytes` default of 1,
// so the two paths agree on what "slightly farther" means.
function connectedSlackOrders(confidence: number): number { ... }  // ~12 at c=0, ~4 at c=1

// applied inside the distance term rather than beside it
const adjNormDist = normDist - (connected ? slackOrders / ORDERS : 0);
```

and drop the separate `w_conn` term so the bonus is not counted twice. The confidence
adjustment keeps its current direction — low confidence widens the slack, high confidence
narrows it.

`w_q` (link quality, 0.1) and `w_b` (backoff, 0.1) have the *same* mis-scaling: at 0.1 each
is worth 64 binary orders of distance. Same site, same cause, so handle them here rather
than filing again:

- Link quality should get the same order-allowance treatment — a few orders, not 64.
- Backoff arguably *should* dominate distance (a peer in backoff has recently failed and
  may be gone), but that must be a stated decision, not an accident of scale. If it is kept
  dominant, leave a `NOTE:` at the weight saying so and why.

Note that the self-distance floor of arm 1 caps whatever slack arm 2 grants: a connected
peer may be slightly farther *than another candidate*, never farther than the node.

### Arm 3 — a general test, not a point test

Two tests in `packages/fret/test/nexthop-cost.spec.ts`. `fast-check` is already a dev
dependency and is used this way in `test/cohort.properties.spec.ts` and
`test/digitree.invariants.spec.ts` — follow that file's shape (`arbCoord`, `seedStore`).

**(a) The invariant, as a property over arbitrary inputs.** For arbitrary peer sets,
key coordinate, self coordinate, `nearRadius`, `confidence` and connected-set: the result
is either `undefined` or an id whose `minDistance` to the key is strictly less than the
node's. Mode-agnostic by construction — vary `nearRadius` across the whole range so both
partitions (and the mixed pool) are generated — so it also covers any mode added later.
This is the test that would have caught the defect.

**(b) The multi-hop walk, generalized to far mode.** `nexthop-cost.spec.ts:242`
("converges monotonically over a multi-hop walk") is the near-mode version: it uses
`nearRadius = 0xff`, which makes every candidate near. Generalize it so the same walk runs
with a far-mode radius (e.g. `computeNearRadius(1000, 15)` over coordinates spread across
the ring) and with some candidates connected, asserting the distance to the key falls on
every hop and the walk terminates at the nearest peer. Keep the near-mode case; the point
is one walk harness driven at both radii, not two copies.

### Arm 4 — documentation

`docs/fret.md`, "Next-hop selection heuristic (connected-first bias)". The bullet beginning
**"Far mode has no such floor, and today that is a gap, not a design choice"** documents
this defect and must be replaced by the shipped rule. Also update:

- the "When far (dist > r_near): allow slack ε_far … prefer already-connected peers even if
  slightly farther" bullet, to state what the bound now is in binary orders;
- the near-mode bullet, so the floor reads as one rule applied in both modes rather than a
  near-mode special case;
- the `cost(peer) = w_d·normDist − w_conn·isConnected …` formula line, if arm 2 folds the
  connection bonus into the distance term.

## Existing tests that must stay green

Checked against the current code while writing this ticket; none of them should need
editing, and one of them changing is a signal the change went further than intended:

- `test/nexthop-cost.spec.ts` — "prefers connected peer when far from target (slack mode)":
  candidates at distance 10 and 15 have the *same* `normalizedLogMagnitude` (both 2^3), so
  connectedness legitimately breaks the tie under either weighting. No `selfCoord`, so the
  new floor does not apply.
- `test/nexthop-cost.spec.ts` — the whole `Next-hop near-mode strict improvement (selfCoord)`
  block, including "returns undefined rather than falling through to an available far
  candidate", which is precisely the subsumption case above.
- `test/ring-wrap-distance.spec.ts` — both selector cases pass no `selfCoord` and no
  connected peers.
- `test/selector.connected-first.spec.ts` — legacy path, untouched.

## Baseline

`yarn test` from `packages/fret/` at this ticket's HEAD: **428 passing, 0 failing** (~5 min).
No pre-existing failures, so no `.pre-existing-error.md` is in play.

## Related, not blocking

`tickets/plan/24-sim-router-realism.md` records that nothing under
`packages/fret/test/simulation/` imports the shipped selector, so there is no routing-success
or hop-count number that this change would move. That harness is what would let arm 2's
constants be tuned on evidence rather than reasoned defaults; this ticket does not wait for
it, and arm 3's property test is where the invariant is actually provable today.

## TODO

### Phase 1 — correctness floor

- Replace `nearSelfDist` in `chooseNextHopCost` with a general `selfDist` filter applied to
  all scored candidates before the near/far partition; keep a strict `lexLess` comparison.
- Walk each of the five branches listed in arm 1 and confirm only the "self far, all
  candidates far" case changes behavior.
- Update the comments at that site: the "no fall-through to far mode" rationale now falls
  out of the general rule, and the `selfCoord` JSDoc on `NextHopOptions` still describes a
  near-mode-only filter.

### Phase 2 — commensurable weights

- Express the connected-first bias as an allowance in binary orders of ring distance and
  remove the separate flat `w_conn` term; keep the confidence adjustment's direction.
- Give link quality the same treatment.
- Decide whether backoff stays dominant over distance; if it does, record it as a `NOTE:` at
  the weight.
- Re-run the reproduction table above by hand or in a scratch script and confirm the
  connected-but-farther peer now loses at realistic separations.

### Phase 3 — tests

- Add the `fast-check` property test asserting the strictly-closer invariant across
  arbitrary pools, keys, self coordinates, near radii and confidences.
- Generalize the multi-hop walk test to run at both a near-saturating and a far-mode radius,
  with connected peers in the pool.
- Confirm the property test fails when the phase-1 filter is reverted (it should — that is
  what makes it a regression test rather than a restatement).

### Phase 4 — docs and validation

- Rewrite the far-mode bullets in `docs/fret.md` as described in arm 4; delete the text that
  documents this defect as a known gap.
- `npx tsc --noEmit` from `packages/fret/` — clean.
- `yarn test` from `packages/fret/` in the foreground, no redirection — expect ≥ 428 passing,
  0 failing.
- Hand off to `review/` naming honestly: which constants in phase 2 are reasoned rather than
  measured, and whether the property test's generators actually reach the far-mode partition
  (assert on generated-case distribution if unsure, rather than assuming).
