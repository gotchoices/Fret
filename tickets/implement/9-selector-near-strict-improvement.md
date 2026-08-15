description: When a node is already close to a key, routing can still hand the request to a peer that is farther from the key than the node itself, so requests drift backwards and only the hop limit stops them looping.
files: packages/fret/src/selector/next-hop.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/nexthop-cost.spec.ts, docs/fret.md
difficulty: medium
repro: verified
----

## What is wrong

`chooseNextHopCost` (packages/fret/src/selector/next-hop.ts:122-173) partitions candidates
into "near" (ring distance to the key ≤ `nearRadius`) and "far", and in near mode it sorts
purely by distance to the key. It never compares any candidate against *the node's own*
distance to the key — the selector is not even given the node's coordinate. So when every
near candidate sits behind the node, the selector returns one of them and the message moves
away from the key.

The design (docs/fret.md, *Next-hop selection heuristic*) says near mode requires strict
distance improvement (ε_near ≈ 0). Without it, forward progress is not guaranteed and loop
safety rests entirely on breadcrumbs plus TTL.

### Reproduction (ran it, saw it)

Unit-level, against the selector directly:

```ts
const key  = coordByte(200)
const self = coordByte(201)          // self distance to key = 1
store.upsert('behind-a', coordByte(210))   // distance 10
store.upsert('behind-b', coordByte(220))   // distance 20
chooseNextHop(store, key, ['behind-a','behind-b'], () => false, () => 0.5,
              { nearRadius: computeNearRadius(10, 5), confidence: 0.9 })
// → 'behind-a'  (10 > 1: strictly farther from the key than the node itself)
```

Both call sites hit this: `FretService.routeAct` (fret-service.ts:1730) forwards whenever the
node is *not* in-cluster, which includes near-but-not-in-cluster, and `iterativeLookup`
(fret-service.ts:2043) picks its probe target the same way. Both build options through
`buildNextHopOptions` (fret-service.ts:1780), which supplies `nearRadius` but no self
coordinate.

`pickAnchors` (fret-service.ts:1683) also calls `chooseNextHop`, but on the legacy path (no
options) and for a different purpose — anchors are the peers *closest to the key*, hints for
a resend, not hops the node takes. It must keep its current behavior; do not give it a self
coordinate.

## Fix shape

Give the selector the node's own coordinate and make near mode reject anything that is not a
strict improvement.

- Add `selfCoord?: Uint8Array` to `NextHopOptions`. Optional keeps every existing caller
  (and the exported-standalone / simulator usage) byte-for-byte unchanged.
- In `chooseNextHopCost`: `selfDist = minDistance(selfCoord, targetCoord)`. When the node
  itself is near (`isNear(selfDist, nearRadius)`), only candidates with
  `lexLess(dist, selfDist)` are eligible; if none remain, return `undefined`.
- Do **not** fall through to far mode in that case. When the node is near, every far
  candidate is by definition beyond `nearRadius ≥ selfDist`, so falling through would pick a
  hop that is guaranteed worse than the node — the exact bug.
- When the node is *far* from the key (`selfDist > nearRadius`), the filter is a no-op:
  every near candidate is already inside `nearRadius < selfDist`, so it improves by
  construction. Leave far-mode cost ordering alone; slack ε_far there is intended.

Returning `undefined` is an already-handled outcome at both call sites: `routeAct` falls
through to its `buildNearAnchor` reply, and `iterativeLookup` yields `exhausted`. Behavior
change worth watching in the test run: a near node with no improving candidate now stops
and answers with hints instead of wandering.

### Second arm — redundant weight computation

`weightsForContext(near, confidence)` is called once per candidate inside the scoring loop
(next-hop.ts:143), but it depends only on `(near, confidence)` — two possible results per
call. In near mode the resulting `costVal` is only ever a tertiary tie-break (equal distance
*and* equal connectedness, next-hop.ts:160-162), so most of that work is discarded.

Hoist rather than delete: compute `nearW` and `farW` once before the loop and select per
candidate. That removes the redundant work while keeping the near-mode tie-break's link-quality
and backoff signal, so no behavior changes.

## Service wiring

`buildNextHopOptions` gains a self-coordinate argument (or reads `this.selfCoord()` — it is
currently synchronous, so passing it in from the two async callers is the smaller change):

- `routeAct`: `await this.selfCoord()` alongside the existing `hashKey(keyBytes)`.
- `iterativeLookup`: `selfCoord` is already in scope (fret-service.ts:1989).

## TODO

- Add `selfCoord?: Uint8Array` to `NextHopOptions` with a comment stating why it is optional.
- In `chooseNextHopCost`, compute `selfDist` and, when the node is near, restrict eligibility
  to strictly-closer candidates; return `undefined` when none qualify (no far-mode fallback).
- Hoist `weightsForContext` out of the candidate loop into `nearW` / `farW`.
- Thread the self coordinate through `buildNextHopOptions` from `routeAct` and
  `iterativeLookup`; leave `pickAnchors` on the legacy path untouched.
- Extend `packages/fret/test/nexthop-cost.spec.ts`:
  - near node, all candidates behind it → `undefined` (this is the repro above, inverted).
  - near node, mixed candidates → picks the strictly-closer one, never the behind one.
  - node far from the key → a near candidate is still chosen (filter is a no-op).
  - no `selfCoord` supplied → existing near-mode result unchanged.
- Update docs/fret.md *Next-hop selection heuristic* to state that strict near-mode
  improvement is measured against the node's own distance to the key, and that no eligible
  hop yields a NearAnchor / exhausted outcome rather than a backwards hop.
- Validate: `cd packages/fret && npx tsc --noEmit`, then `yarn test` (whole suite — routing
  and simulation tests are the ones that could depend on backwards hops still succeeding).
