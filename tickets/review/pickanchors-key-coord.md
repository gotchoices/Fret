description: Anchor peers returned for a lookup key are now confirmed to be picked by distance to the key itself (not a fixed zero point) — this ticket adds the regression test that proves it and confirms the fix under the full test suite.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/pick-anchors.spec.ts
----
Fix itself landed in a prior session (already committed): `pickAnchors(candidates, targetCoord)`
in `fret-service.ts` (~line 1640) takes the target ring coordinate as a parameter instead of
hardcoding `new Uint8Array(32)` internally. Both call sites — `nearAnchorOnly` (~line 1597) and
`buildNearAnchor` (~line 1727) — pass their local `coord` (the key's hashed ring coordinate)
through. This ticket's job was regression coverage only; no production code changed here.

### What was added

New `packages/fret/test/pick-anchors.spec.ts`, two tests:

1. **Unit-level, white-box.** Seeds a bare `FretService`'s store directly (`s.store.upsert`) with
   four peers: one numerically near the all-zero coordinate (what the old bug would have
   gravitated to), one one-bit-flip away from the actual key coordinate (the true nearest peer),
   and two decoys far from both. Calls the private `pickAnchors` method directly
   (`(svc as any).pickAnchors(candidates, keyCoord)`) and asserts the first returned anchor is
   `true-nearest`, not `near-zero`. This is the most direct trip-wire against the exact bug: if
   `pickAnchors` ever reverts to an internal zero coordinate, this fails immediately regardless of
   how callers gather candidates.
2. **End-to-end.** Same peer-clustering idea, but drives it through the public `routeAct` API with
   a no-activity message on a service where the seeded peers make it in-cluster, so the response
   comes back through `buildNearAnchor` → `pickAnchors` exactly as production traffic would. Asserts
   `anchors[0] === 'true-nearest'`.

### Verified

- New spec alone: `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/pick-anchors.spec.ts" --timeout 30000` — 2 passing.
- `npx tsc --noEmit` — clean.
- Full `yarn test` — 337 passing (was 335 before this ticket's two new tests), no failures, no regressions.

### Known gaps — treat as a starting point

- The unit-level test reaches into a private method via `(svc as any).pickAnchors(...)` and seeds
  the store directly rather than going through the normal ring-walk that narrows candidates before
  `pickAnchors` ever sees them. That's deliberate — it isolates `pickAnchors`'s own distance math
  from candidate-gathering — but a reviewer may want an additional test that removes the cast in
  favor of exercising only the public surface, if `pickAnchors` is ever promoted out of `private`.
- Only the `buildNearAnchor` call site is exercised end-to-end (via the in-cluster/no-activity
  branch of `routeAct`). The sibling call site, `nearAnchorOnly` (used for breadcrumb-loop,
  TTL-expired, and no-next-hop fallbacks), is not separately driven end-to-end — it calls the same
  `pickAnchors` with the same signature, so the unit-level test already covers the regression risk
  there, but no test proves those specific `routeAct` branches route through it correctly.
- No test covers a tie (two candidates truly equidistant from the key) or the empty-candidates
  path (`pickAnchors([], coord)` — already returns `[]`, untested directly, low risk).
