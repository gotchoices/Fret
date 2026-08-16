---
description: A node routing a message could hand it to a peer sitting farther from the destination than the node itself; the selector now refuses any hop that does not move the message closer, and the "prefer a peer we are already connected to" bias is capped instead of unlimited.
files: packages/fret/src/selector/next-hop.ts, packages/fret/test/nexthop-cost.spec.ts, docs/fret.md
difficulty: medium
---

## What shipped

All four arms of `tickets/implement/1-bug-far-mode-self-distance-floor.md` landed. Nothing
was deferred. One change goes beyond the literal TODO list — see *Beyond the ticket* below.

### Arm 1 — the self-distance floor is now general (`src/selector/next-hop.ts`)

The near-only `nearSelfDist` filter is gone. `chooseNextHopCost` now computes `selfDist`
once and filters **the whole scored array** on `lexLess(s.dist, selfDist)` *before* the
near/far partition:

```ts
const eligible = selfDist !== undefined ? scored.filter(s => lexLess(s.dist, selfDist)) : scored;
if (eligible.length === 0) return undefined;
```

The five branches from the ticket were walked and hold as predicted; only "self far, all
candidates far" changes behavior. The "no fall-through to far mode" rationale is retained
as a comment, now derived from the general rule rather than special-cased. `NextHopOptions.selfCoord`
JSDoc rewritten — it no longer claims to be near-mode-only.

No call site changed. `routeAct`'s forward path (`fret-service.ts:1754`) is still the only
caller supplying `selfCoord`; `iterativeLookup` and `pickAnchors` untouched.

### Arm 2 — cost terms are commensurable

`cost(peer) = w_d·adjNormDist + w_b·backoff`, where `adjNormDist` is the normalized log
distance **discounted by an allowance in binary orders of ring distance**. The flat
`− w_conn·connected − w_q·linkQ` terms are gone.

- `CONNECTED_SLACK_ORDERS = 8` (one byte, matching the legacy path's `connectedToleranceBytes`
  default of 1), swinging ±4 with confidence: 12 orders at confidence 0, 4 at confidence 1.
  Confidence direction preserved (low → wider).
- `QUALITY_SLACK_ORDERS = 4`, scaled by `linkQ ∈ [0,1]`.
- **Backoff kept dominant**, by decision, with a `NOTE:` at `farWeights` stating the
  reasoning (a backed-off peer likely costs a full timeout and buys no progress) and a
  revisit condition. At the far weights it is worth ≈ 64 orders.

### Arm 3 — tests (`test/nexthop-cost.spec.ts`)

- **New `fast-check` property**: `never returns a hop farther from the key than the caller,
  in any mode` — arbitrary peer sets, key/self coordinates, near radii, confidences,
  connected and backed-off subsets. Asserts the result is `undefined` or strictly closer
  than self. 500 runs.
- **Walk harness generalized**: `walkRing(...)` is one harness, driven by two `it`s — the
  original near-saturating radius, and a far-mode radius (`computeNearRadius(1000, 15)`)
  over coordinates spread across the ring at `v·2^248`, with a connected peer in the pool.

### Arm 4 — docs

`docs/fret.md` "Next-hop selection heuristic (connected-first bias)" rewritten. The bullet
that documented this defect as a known gap is deleted. The formula line, the far-mode slack
bullet, the near-mode bullet, and the confidence bullet all now describe the shipped rule.

## Beyond the ticket (call this out in review)

Near candidates are ordered by `betterByDist`, which already breaks equal distances by
peer id — the ring's documented lexicographic tie-break. That makes it a **total order**,
so the `connected` / `costVal` fallbacks in the near sort were unreachable. With arm 2
folding connectedness into the distance term, near-mode cost became entirely unread. So:

- the dead near-sort fallbacks were removed (near sort is now `betterByDist` alone);
- `weightsForContext(near, confidence)` became `farWeights(confidence)`;
- cost is evaluated **only for surviving far candidates**, after the floor and partition,
  instead of for every candidate in the scoring loop.

Net effect is strictly less work and no behavior change, but it is a structural edit the
ticket did not ask for. If the reviewer wants near mode to retain a cost-based tie-break,
that requires removing the id tie-break from `betterByDist` first — which contradicts
`docs/fret.md` "when equidistant, prefer lexicographic order of peer IDs".

## Validation performed

| Check | Result |
|---|---|
| `npx tsc --noEmit` (from `packages/fret/`) | clean |
| `yarn build` | clean |
| `yarn test` (from `packages/fret/`) | **430 passing, 0 failing** (~5 min) |

Baseline in the implement ticket was 428; +2 is the walk test splitting into two plus the
new property test. No test was edited, skipped, or loosened. No pre-existing failures, so
no `.pre-existing-error.md` is in play.

**Regression value confirmed empirically.** The phase-1 filter was temporarily reverted to
near-only and the spec re-run: all twelve deterministic tests still passed and **only the
property test failed** (after 5 runs, shrinking to a far-mode counterexample). That is the
ticket's phase-3 acceptance criterion, and it also says plainly that the deterministic tests
alone would not have caught this.

**Reproduction table re-measured** against the shipped selector (scratch script, since
deleted), key at coordinate 0, all-far pool, no `selfCoord`:

| Candidates | c=0 | c=0.5 | c=1.0 |
|---|---|---|---|
| connected 2^200 vs disconnected 2^0 (200 orders) | disconnected | disconnected | disconnected |
| connected 2^40 vs disconnected 2^24 (16 orders) | disconnected | disconnected | disconnected |
| connected 2^40 vs disconnected 2^34 (6 orders) | connected | connected | disconnected |
| connected 2^254 vs disconnected 2^253 (1 order) | connected | connected | connected |

Every row in the ticket's "before" table flipped where it should. The invariant rows:
self at 2^254 with a connected candidate behind it and a disconnected one ahead now picks
the disconnected one at all three confidences; with every candidate behind self, far mode
returns no hop.

## Use cases for the reviewer

- **The regime that actually matters**: `nearRadius` at `n_est = 1000, k = 15` is ≈ 2^251
  against a max ring distance of 2^255, so ~94% of the distance range is far. Far mode is
  the normal case for early hops at scale, and it now has a floor.
- **Small rings are unaffected**: below `n_est ≈ 60` the radius saturates the ring and every
  candidate is near, which is why the whole in-process test suite (small rings) is unchanged.
- **`undefined` is a normal answer.** Both callers handle it (`routeAct` → `NearAnchor`,
  `iterativeLookup` → `exhausted`). Worth confirming the reviewer agrees no-hop is preferable
  to a backwards hop on the forward path.

## Known gaps — flagged honestly

1. **The phase-2 constants are reasoned, not measured.** 8 ± 4 orders comes from matching
   the legacy `connectedToleranceBytes` default of 1 byte; `QUALITY_SLACK_ORDERS = 4` is "a
   few, not 64". There is no routing-success or hop-count number behind either, because
   nothing under `packages/fret/test/simulation/` imports the shipped selector — see
   `tickets/plan/24-sim-router-realism.md`. A `NOTE:` at `CONNECTED_SLACK_ORDERS` records
   this and names the retune condition. **The reviewer should not read these numbers as
   tuned.**
2. **Backoff dominance is a judgment call, not a measurement.** ≈ 64 orders is far more than
   the connected allowance. It is now stated rather than accidental, but a reviewer who
   disagrees has a real argument to make.
3. **The property test's distribution is asserted, not just assumed** — it counts near-mode,
   far-mode and no-hop outcomes and fails if any bucket is empty. It passed, so all three are
   genuinely reached. What is *not* asserted is the ratio; a future generator change could
   reach far mode only rarely and still pass.
4. **`iterativeLookup` still withholds `selfCoord` deliberately** (an originator aims at the
   key's cluster, every member of which is farther from the key than an originator sitting
   nearest it). That means the originating path has no floor at all. This is the documented
   deviation from `tickets/complete/9-selector-near-strict-improvement.md`, not new — but it
   is the one place the "one invariant everywhere" framing does not literally hold, and it is
   worth a reviewer's eye.
5. **The far-mode walk test's ring is hand-laid**, so it proves the floor holds over a real
   multi-hop descent that crosses the near radius, but it is one path, not a distribution.
   The property test is the general guard.

## Review findings — tripwires parked

- **Near-mode cost is unreachable by construction** (the id tie-break in `betterByDist` is a
  total order). Not parked as a `NOTE:` because the dead code was removed outright and the
  reason is stated in the comment at the near sort in `src/selector/next-hop.ts`.
- **Constants not measured** — parked as a `NOTE:` at `CONNECTED_SLACK_ORDERS` in
  `src/selector/next-hop.ts`, with the retune condition (a simulation harness that drives the
  shipped selector).
- **Backoff dominance accepted by design** — parked as a `NOTE:` at `farWeights` in
  `src/selector/next-hop.ts`, with what was decided, why, and the revisit condition.
