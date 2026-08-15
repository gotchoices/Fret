description: Anchor peers suggested in a lookup reply are now measured against the key being looked up rather than a fixed point, and regression tests plus documentation now pin that behavior down.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/pick-anchors.spec.ts, docs/fret.md
----
### What shipped

The production fix landed in an earlier stage (commit `099f9eb`): `pickAnchors(candidates, targetCoord)`
takes the target ring coordinate as a parameter instead of measuring every candidate against
`new Uint8Array(32)` internally. Both callers — `nearAnchorOnly` and `buildNearAnchor` — pass the
key's hashed coordinate through.

The implement stage added `packages/fret/test/pick-anchors.spec.ts` (2 tests). This review pass
rewrote that spec (6 tests), added intent documentation at the two anchor-building sites, and
corrected the design document, which still described the reply's anchors as one successor and one
predecessor of the key.

Final state — `packages/fret/test/pick-anchors.spec.ts`, 6 tests in two groups:

- **Distance math** (shared service, direct `pickAnchors` calls): key-nearest peer beats
  zero-nearest peer; empty candidate list → no anchors; single candidate → single anchor;
  candidate ids absent from the store are skipped rather than returned unmeasured.
- **Reply paths** (per-test service, seeded ring): `routeAct` → `buildNearAnchor` and a
  breadcrumb-loop `handleMaybeAct` → `nearAnchorOnly`, each asserting the key-nearest peer is the
  primary anchor. Both anchor-building call sites are now covered end to end.

## Review findings

**Checked:** the implement diff (`771798e`) read before the handoff summary; the production fix
(`099f9eb`) and both call sites; `chooseNextHop`'s legacy selection path that `pickAnchors` relies
on; every consumer of `NearAnchorV1` fields; test-suite conventions across the existing specs;
`docs/fret.md` sections on the routing rule, cohort anchors, and the NearAnchor wire format;
`docs/review.html` (a dated 2026-07-03 snapshot — left as the historical record it is).

**Do the tests actually catch the bug?** Verified by re-introducing it: `pickAnchors` was
temporarily forced back to an all-zero target, the spec was run (3 of 6 tests failed, one per
anchor-producing path), and the source was restored. `git diff` confirms no production behavior
change remains from that experiment.

**Minor — fixed in this pass:**

- The spec threw bare `Error`s instead of using Chai, skipped the `stopAll` helper, and leaked its
  libp2p node whenever an assertion failed (cleanup ran after the assertion, never in a `finally`).
  Rewritten to house style: `expect`, `stopAll`, `try`/`finally`.
- `const s: any = svc` discarded typing for the whole test body, against the project's no-`any`
  rule. Replaced with a named `AnchorInternals` interface for the private surface, so a signature
  change now fails the type-check instead of failing mysteriously at runtime.
- Coverage gaps the handoff listed as known: empty candidates, single candidate, and the
  `nearAnchorOnly` call site are all covered now. Also added a candidate-absent-from-store case,
  which nothing exercised.
- The handoff claimed the end-to-end test drove the in-cluster/no-activity branch. It does not —
  the service is never started, so self is not in the ring and the in-cluster test fails; `ttl: 0`
  then blocks the forward and the reply comes from `buildNearAnchor`'s fallback arm. Same method,
  different branch. The test comment now says so.
- Six nodes were being started where two suffice; the distance-math tests share one service.
  Suite runtime for this spec is ~30ms.
- `docs/fret.md` described the reply's anchors as `[succ, pred]` in both the routing rule and the
  wire format. The implementation returns the two candidates *nearest the key*, which may sit on
  the same side of it. Documented the real contract, including why a fixed measuring point is a
  correctness bug rather than a bias.
- `pickAnchors` had no comment stating that its target must be the key's coordinate — the exact
  invariant that was violated. Added.

**Major:** none. The fix is correct at both call sites, and no consumer of the anchors was found
that the change breaks.

**Tripwires (recorded, not ticketed):**

- `nearAnchorOnly` reports a hardcoded `estimated_cluster_size` (the configured k) and a flat
  `confidence` of 0.5. Harmless today because no consumer reads either field — `iterativeLookup`
  uses only `anchors`. `NOTE:` at the method saying it must compute the real estimate if that
  changes.
- The same method is the reject-path reply (breadcrumb loop, TTL expired, oversized payload,
  `routeAct` threw), and those guards answer *before* the maybeAct token bucket, so its cost is
  what an abusive sender gets for free. That is why it is deliberately the cheaper twin of
  `buildNearAnchor` rather than being merged with it; recorded in the same `NOTE:` so the next
  reader does not "fix" the duplication by making the reject path more expensive.

**Considered and declined:**

- An equidistant-candidates test, listed as a gap in the handoff. XOR distance to a fixed target is
  injective, so two peers with distinct coordinates can never tie; the lexicographic tie-break in
  `selector/next-hop.ts` is unreachable from `pickAnchors`. Recorded as a comment in the spec so
  the "missing" case is not re-filed.
- Merging `nearAnchorOnly` into `buildNearAnchor` — see the tripwire above; the duplication is
  load-shedding, not an accident.

**Verified:** `npx tsc --noEmit` clean; `yarn build` clean; full `yarn test` — **341 passing**, 0
failing (335 before the ticket, 337 after implement's 2 tests, 341 with this pass's 6). No
pre-existing failures surfaced.
