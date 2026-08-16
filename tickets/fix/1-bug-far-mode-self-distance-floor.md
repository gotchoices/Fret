----
description: When a node is still far from a key, it can hand a message to a peer that sits farther from that key than the node itself, because "already connected" outweighs distance by an enormous margin — so messages move away from where they are headed and can run out of hops before arriving.
files: packages/fret/src/selector/next-hop.ts, packages/fret/test/nexthop-cost.spec.ts, docs/fret.md
difficulty: medium
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: The connected-peer preference exists on purpose — it avoids serial dial chains, which matter most on mobile/edge nodes — and nobody has measured what the distance/connection balance should be, so a maintainer may reasonably want the routing-measurement harness in place before touching the weights.
----

## What is wrong

The next-hop selector runs in two modes. **Near mode** (the node is within the near
radius of the key) now requires a hop strictly closer to the key than the node itself.
**Far mode** has no such floor at all: it ranks candidates purely by a cost function, and
in that function the "peer is already connected" bonus swamps the distance term.

Concretely, from `weightsForContext` / `cost` in `next-hop.ts`:

- The distance term is `w_d · normalizedLogMagnitude(dist)`. That helper returns a
  *log-scale position in [0,1]* over a 256-bit space, so one binary order of magnitude of
  ring distance moves it by `1/256 ≈ 0.0039`, worth `w_d/256 ≈ 0.002`.
- The connection bonus is a flat `w_conn`, which is `0.3–0.5` depending on confidence.

So a connected candidate outranks a disconnected one unless the disconnected one is more
than roughly `w_conn / (w_d/256)` ≈ 150 binary orders of magnitude closer to the key —
which cannot happen among candidates drawn from the same neighbourhood. In practice, when
connectedness differs, **far mode ignores distance entirely.**

Measured by calling the shipped selector directly (all peers at handmade coordinates,
`nearRadius` set so both candidates are far):

| Candidates | confidence 0 | 0.5 | 1.0 |
|---|---|---|---|
| connected at dist ≈ 2^200 vs disconnected at dist 1 | connected | connected | disconnected |
| connected at dist ≈ 2^40 vs disconnected at dist ≈ 2^24 | connected | connected | connected |

The second row is the realistic case — candidates a handful of orders apart — and the
connected-but-farther peer wins at every confidence level.

The design document has always said far mode should "prefer already-connected peers even
if **slightly** farther". There is no bound on "slightly" in the code, and in particular
nothing stops the chosen hop from being farther from the key than the sender.

## Why it matters

Routing candidates come from a cohort walk around the *key*, so this is not an
unrestricted random walk — the damage is bounded to the handful of peers the node knows
nearest the key. But the sender itself is excluded from that set, and the peers that are
genuinely closer can be excluded as breadcrumbs or skipped as undialable. When that
happens, every remaining candidate is behind the sender and far mode will cheerfully pick
one. The message then moves away from the key, and only the hop budget and the breadcrumb
trail stop it. That is exactly the failure the near-mode work in
`selector-near-strict-improvement` set out to remove; it was only removed for near mode.

**This is dormant on small rings.** The near radius saturates the whole ring below
`n_est ≈ 2·β·k` (≈60 peers at the defaults — there is a `NOTE:` recording that at
`computeNearRadius` in `payload-heuristic.ts`), so every candidate counts as near and far
mode never runs. It becomes reachable once a network exceeds roughly sixty peers, which is
the scale FRET is built for. Nothing in the test suite or the simulation harness runs at
that scale today, so no existing test would notice.

## What to build

The finding is one instance of a broader missing guarantee, so please fix the guarantee
rather than the instance:

**A hop is never farther from the key than the node choosing it, beyond a stated
tolerance — in every mode of the selector.** The node's coordinate is already plumbed into
the selector (`NextHopOptions.selfCoord`); today only the near branch consults it.

Two things worth settling as part of the work:

- What the far-mode tolerance should be. A hard "strictly closer" floor is the simplest
  and matches near mode, but it removes the connected-first slack entirely and may force
  dials that the bias exists to avoid. A bounded slack (allow a connected peer up to some
  number of binary orders farther, but never past the node's own distance) is the middle
  ground. Whichever is chosen, the connection bonus and the distance term need to be
  commensurable — at present they are not, and that is the root cause.
- A general test, not a point test. A property/walk test over a seeded ring asserting that
  the distance to the key falls on every hop would cover both modes and any future mode.
  `test/nexthop-cost.spec.ts` now has a near-mode version of exactly this
  ("converges monotonically over a multi-hop walk") that can be generalized.

Related, not blocking: `tickets/plan/24-sim-router-realism.md` observes that nothing under
`test/simulation/` imports the shipped selector, so there is no routing-success or
hop-count number that a selector change would move. That harness is what would let the
tolerance above be tuned on evidence rather than guessed; this ticket does not depend on
it, but the two should be aware of each other.
