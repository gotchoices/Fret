description: Routing could hand a request to a peer farther from the key than the sender, so messages drifted backwards; forwarding now refuses any hop that is not strictly closer, and answers with routing hints instead.
files: packages/fret/src/selector/next-hop.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/nexthop-cost.spec.ts, packages/fret/test/iterative-lookup.spec.ts, docs/fret.md
difficulty: medium
----

## What changed

### Selector (`packages/fret/src/selector/next-hop.ts`)

- `NextHopOptions` gained `selfCoord?: Uint8Array` — the caller's own ring coordinate.
- `chooseNextHopCost` computes `selfDist = minDistance(selfCoord, targetCoord)`. When the
  caller itself is near (`isNear(selfDist, nearRadius)`), near-mode eligibility is restricted
  to candidates with `lexLess(dist, selfDist)`. If none remain it returns `undefined` — there
  is **no** fall-through to far mode, because every far candidate sits beyond
  `nearRadius ≥ selfDist` and is therefore guaranteed worse than staying put.
- When the caller is far from the key, the filter is a no-op by construction (every near
  candidate is already inside `nearRadius < selfDist`).
- Omitting `selfCoord` leaves behavior byte-for-byte as before.
- Second arm: `weightsForContext(near, confidence)` was called once per candidate inside the
  scoring loop though it depends only on `(near, confidence)`. Hoisted to `nearW` / `farW`
  computed once before the loop. Pure hoist — no behavior change.

### Service (`packages/fret/src/service/fret-service.ts`)

- `buildNextHopOptions(sizeEstimate, confidence, selfCoord?)` passes the coordinate through.
- `routeAct` supplies `await this.selfCoord()`.
- `pickAnchors` untouched (legacy path, ranks peers for someone else's resend).

## Deviation from the ticket — read this first

**The ticket's TODO said to thread `selfCoord` through `iterativeLookup` as well. I did not,
and the ticket's own validation step is what surfaced why.** Wiring it there made two existing
tests fail (`iterative-lookup.spec.ts` "returns complete when activity handler is set and
in-cluster", `maybeact-dedup-phases.spec.ts` "completes a find-then-act lookup end to end"),
both with `exhausted` and zero probes sent.

The reason is not test fragility:

- `routeAct` forwards only when it is **not** in-cluster (`distIdx <= 1` fails), which means at
  least two peers sit closer to the key. Strict improvement there is exactly right, and a
  no-hop result genuinely means the local view is exhausted.
- `iterativeLookup` **originates**. Its destination is the key's *cluster* — the k peers
  nearest the key, spanning both sides — not the key point. A node that happens to be the
  peer nearest the key must still contact a cluster member, and every cluster member is
  farther from the key than it is. The filter empties, `undefined` comes back, the walk yields
  `exhausted`, and the activity is silently never performed. In a two-node ring that is a coin
  flip on peer-id ordering: half of all lookups become undeliverable.
- It also buys nothing there. `iterativeLookup` already has a `visited` set, so it cannot loop
  the way a forwarded message can. And when the filter is *not* empty it changes nothing:
  if any candidate is strictly closer than self, the nearest candidate overall is strictly
  closer, so it survives the filter and near mode picks it either way. The filter's only
  observable effect is the empty case — desirable on the forward path, destructive at the
  originator.

Both the code comment on `buildNextHopOptions` and the docs state this. **A reviewer who
disagrees should look at the new `iterative-lookup.spec.ts` regression test first** — it pins
the behavior down deterministically rather than leaving it to peer-id luck.

## Use cases to test / validate

Selector level (`packages/fret/test/nexthop-cost.spec.ts`, new describe block):

- Near node, every candidate behind it → `undefined`. This is the ticket's repro inverted.
- Near node, mixed candidates → picks the strictly-closer one; a *connected* candidate behind
  the node does not rescue it.
- Node far from the key → a near candidate is still chosen (filter is a no-op).
- No `selfCoord` supplied → prior near-mode result unchanged.

Service level (`packages/fret/test/iterative-lookup.spec.ts`, new test):

- Two-node mesh; the test searches candidate keys until it finds one the **initiator** is
  strictly nearest to, then asserts the lookup still completes and the activity runs exactly
  once. Deterministic despite random peer ids.

Worth exercising by hand or eye:

- A near-but-not-in-cluster node receiving a `maybeAct` it cannot improve on now answers with
  a `NearAnchor` (hints) instead of forwarding backwards. That is the intended behavior change;
  the sender falls back to its own local cohort for the next attempt.
- Ring wrap-around: `minDistance` is used throughout, so a candidate across the seam is
  measured as adjacent. `test/ring-wrap-distance.spec.ts` covers the cost path and still passes.

## Known gaps / where to push

- **No multi-hop convergence test.** Nothing asserts that a message forwarded across several
  hops now monotonically approaches the key. The simulation suite passes (routing success rate
  90%, avg hops 0.8 in the churn run), but those numbers were the same before this change —
  the test meshes are small enough that most routes are one hop, so they do not really
  exercise the invariant. A larger deterministic ring with an assertion on per-hop distance
  would be the real proof.
- **No test for `routeAct` returning a `NearAnchor` specifically because the strict filter
  emptied.** The new coverage proves the selector does the right thing and proves the
  originator path is unharmed; it does not prove the forward path's fall-through is reached in
  a live service. Constructing that needs a node that is near, not in-cluster, and whose whole
  dialable cohort is behind it — plausible to build, I did not.
- **The `selfIsNear` gate reuses `isNear(selfDist, nearRadius)`.** With a small network the
  near radius saturates and effectively the whole ring is "near", so the filter is active
  everywhere. That is correct but means small-network routing is now strictly greedy on the
  forward path, with no connected-peer slack at all. No test pins the intended behavior at the
  boundary where `nearRadius` stops saturating.
- The hoist of `weightsForContext` was asserted only by "all existing tests still pass" — no
  test distinguishes per-candidate from per-call weights, because by construction nothing can.

## Validation run

From `packages/fret/`:

- `npx tsc --noEmit` — clean.
- `yarn test` — **366 passing, 0 failing** (~4 min). Log:
  `tickets/.logs/selector-near-strict-improvement.test.log`.
