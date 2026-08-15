description: When a node tells a requester which neighbors sit nearest a key, it accidentally measured distance from a fixed zero point instead of from the key, so the neighbors it handed back were the wrong ones. The bug fix has already been applied; this ticket is to add regression coverage and confirm the fix under the full test suite.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/route.maybeact.integration.spec.ts
difficulty: easy
----
Root cause (fixed): `pickAnchors` (fret-service.ts, was ~line 1640) computed `chooseNextHop` against `new Uint8Array(32)` (the all-zero ring coordinate) instead of the key's coordinate. Both call sites — `nearAnchorOnly` (~line 1592) and `buildNearAnchor` (~line 1727) — already had the key's hashed coordinate (`coord`) in scope but never passed it through.

Fix already applied in this repo:
- `pickAnchors(candidates: string[], targetCoord: Uint8Array)` now takes the target coordinate as a parameter instead of hardcoding a zero coordinate internally.
- Both call sites now pass their local `coord` (the key's hashed ring coordinate) through to `pickAnchors`.

Verified so far:
- `npx tsc --noEmit` clean.
- Full suite (`yarn test`) green: 335 passing, no failures, no regressions.

What's left for this ticket — there is no existing unit test that pins anchor selection to the key's coordinate, so the original zero-coordinate bug could have shipped silently. Add regression coverage:

- Add a focused test (in `route.maybeact.integration.spec.ts` or a new `pick-anchors.spec.ts` alongside it) that builds a small ring of peers with known coordinates, requests a `NearAnchor` for a specific key, and asserts the returned `anchors` are the key's actual successor/predecessor by ring distance — not peers biased toward numerically small coordinates (which is what the zero-coordinate bug would produce). A good discriminating case: seed peers whose coordinates cluster far from the key but include at least one peer near coordinate zero and one peer that is the key's true nearest neighbor: with the bug, `pickAnchors` would favor the near-zero peer; with the fix, it favors the true nearest neighbor to the key.
- Run the new test plus full `yarn test` to confirm.

TODO
- write regression test pinning `pickAnchors` output to the key coordinate, not zero
- run full test suite to confirm green
