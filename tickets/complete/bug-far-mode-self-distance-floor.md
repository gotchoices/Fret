---
description: A node routing a message could hand it to a peer sitting farther from the destination than the node itself; the selector now refuses any hop that does not move the message closer, and the "prefer a peer we are already connected to" bias is capped instead of unlimited.
files: packages/fret/src/selector/next-hop.ts, packages/fret/test/nexthop-cost.spec.ts, docs/fret.md
---

## What shipped

The next-hop selector gained one rule and lost one incommensurable comparison.

**The self-distance floor is general.** `chooseNextHopCost` computes the caller's own distance
to the key once and filters the whole scored array on `dist < selfDist` *before* the near/far
partition, so a hop can never be farther from the key than the node already is. The near-only
filter it replaced is subsumed rather than supplemented: when a near node has no closer near
candidate, every far candidate is beyond the near radius and therefore also beyond the node's
own distance, so the general rule removes them too and the selector answers "no hop" — the
deliberate no-fall-through-to-far-mode, now falling out of the rule instead of being written
as a special case. The only behavior that changes is the one the ticket exists for: a far node
whose candidates are all far may no longer pick one behind itself.

**The non-distance preferences are stated in binary orders of ring distance.** `cost(peer) =
w_d·adjNormDist + w_b·backoff`, where connectedness and link quality discount the distance term
instead of sitting beside it as flat units. That is what makes them comparable: the normalized
log distance spreads its entire dynamic range of 1.0 over 256 binary orders, so the old flat
`w_conn = 0.4` outranked the whole ring and a connected candidate beat a disconnected one at any
separation a real pool can express. A connected peer now gives up 8 orders (12 at confidence 0,
4 at confidence 1); link quality gives up up to 4.

Near mode's cost-based tie-breaks were removed as dead code — the ring's lexicographic peer-id
tie-break already makes distance ordering a total order, so nothing downstream of it could ever
run. Cost is therefore computed only for far candidates that survive the floor.

`routeAct`'s forward path is still the only caller that supplies the node coordinate;
`iterativeLookup` withholds it deliberately (an originator aims at the key's cluster, every
member of which is farther from the key than an originator sitting nearest it) and anchor
selection runs the legacy path, which ignores it.

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `yarn build` | clean |
| `yarn test` | **434 passing, 0 failing** (5m) |

434 is the implement stage's 430 plus the four allowance tests added during review. No test was
edited, skipped, or loosened, and no pre-existing failures surfaced, so no
`.pre-existing-error.md` is in play. There is no lint step in this repo — `yarn check`
(typecheck + build + test) is the gate, per `AGENTS.md`.

## Review findings

Read the implement diff (`6b56ff7`) before the handoff summary. Everything below was found
against the code, then checked against the handoff's claims.

### Verified, not merely accepted

- **The subsumption argument holds.** Walked all five branches against the actual `isNear` /
  `lexLess` semantics rather than the prose. Only "self far, all candidates far" changes.
- **The "orders" arithmetic is literal, not a metaphor.** `normalizedLogMagnitude` returns
  bit-length ÷ 256 and the cost function divides the allowance by `dist.length * 8` = 256, so
  one unit of slack really is one binary order. Both candidates carry the same `w_d`, so
  confidence shifts only the backoff tradeoff, not the connected comparison — consistent with
  what `docs/fret.md` now claims.
- **The dead-code claim is true.** `betterByDist` breaks equal distances by peer id, so it is a
  total order and the removed `connected` / `costVal` fallbacks in the near sort were
  unreachable. Removing them changed no behavior.
- **Call sites match the handoff.** `routeAct` is the only caller passing the node coordinate
  into the cost path; `iterativeLookup` omits it; `pickAnchors` runs the legacy path. The other
  `selfCoord:` occurrences near that code are size-estimator calls, not selector calls. Both
  callers handle the `undefined` answer (NearAnchor reply, `exhausted` progress).
- **Board site-claim check.** Two open tickets mention this file (`plan/2-dead-state-transition`,
  `plan/24-sim-router-realism`); neither claims the cost path, and 24 is the simulation-harness
  ticket the constants' own `NOTE:` already names as its retune enabler.

### Minor — fixed in this pass

- **Documentation had already drifted, in the same commit that wrote it.** `docs/fret.md`
  pointed the backoff decision at a `NOTE:` on `weightsForContext`, a function that commit
  renamed to `farWeights`. Repointed.
- **The near-mode documentation was incomplete.** It said the connected allowance is inert in
  near mode, which is true but partial: the backoff term is inert there too, so the whole cost
  function is. Stated, with the reason.
- **Both winner picks sorted the entire array to read element 0**, and neither comparator can
  return 0 — for two entries carrying the same id, `betterByDist` is false in both directions,
  which is an inconsistent `sort` comparator. `iterativeLookup` passes a remote-supplied anchor
  list straight through without deduplicating (only `pickAnchors` dedups), so a repeated id is
  reachable from the wire. Replaced both with a `best()` min-scan: linear instead of
  `O(n log n)`, and well-defined on a repeat.
- **The new allowance had no test pinning its bound**, which is the only property that
  distinguishes it from the defect it replaced. The pre-existing "prefers connected when far"
  test compares distances 10 and 15 — the same bit-length — so it never spends a single order
  of slack. Confirmed the gap empirically: setting `CONNECTED_SLACK_ORDERS` to 200, restoring
  an effectively unbounded bias, passed the entire suite. Added four deterministic tests at
  exact powers of two (spends 6 orders, refuses 16, narrows at confidence 1, widens at
  confidence 0) and verified two of them fail under that reintroduction.

### Major — none

No finding warranted a new ticket. The floor's correctness, the commensurability rewrite, and
the dead-code removal all hold as claimed; the gaps that remain are measurement and coverage,
handled above or already carrying a `NOTE:`.

### Tripwires parked

- **Backoff is inert in near mode**, so near mode will prefer the nearest peer to a live one a
  step behind it even when the nearest just failed. Long-standing near-mode behavior rather than
  something this diff introduced, and inside the near radius the runner-up is barely farther, so
  the skipped timeout buys little. Parked as a `NOTE:` at the near sort in
  `src/selector/next-hop.ts`, with the revisit condition, and stated in the `docs/fret.md`
  near-mode bullet.

### Considered and declined

- **`iterativeLookup` has no floor at all** (the handoff flags this as its gap 4). Not a defect:
  the deviation is argued in `docs/fret.md` and pinned by `test/iterative-lookup.spec.ts` — an
  originator aims at the key's cluster, so filtering there would refuse to send rather than
  prevent a loop. Left alone.
- **The allowance constants are reasoned, not measured** (gaps 1 and 2). Both already carry a
  `NOTE:` stating what was decided, why, and the retune condition, and the harness that would
  measure them is an open plan ticket. Re-filing would duplicate a decision already recorded at
  the site.
- **`Math.max(0.1, …)` in `farWeights` is unreachable** for any confidence in [0,1]. Left as a
  defensive clamp on an externally-supplied number; removing it trades a real guard for a
  cosmetic line.
