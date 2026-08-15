description: On small networks the cohort assembly could return fewer members than requested even when enough distinct members exist; this is now fixed with a regression test.
files: packages/fret/src/service/cohort.ts, packages/fret/test/cohort.properties.spec.ts
---

## What changed

`assembleCohort` (packages/fret/src/service/cohort.ts) over-fetches `wants * 2` ids from each of `neighborsRight`/`neighborsLeft`, then alternately merges them. On a small ring (n ≈ wants) both directional walks wrap and can return the *same* underlying ids in different orders. The old merge loop counted a duplicate crossing the two walks as if it were a distinct entry while advancing toward `wants`, then a **trailing** `Array.from(new Set(out))` collapsed duplicates *after* the loop had already stopped early — shrinking the result below `wants` even though the ring held `wants` distinct members.

Fix: track a `seen` set alongside the caller's `exclude` set *inside* the merge loop, so a duplicate crossing the two walks is skipped immediately and the loop keeps pulling from both walks until it actually collects `wants` distinct ids (or exhausts both). The trailing dedup was removed — `out` is now distinct by construction.

## Design notes / rationale

- `seen` lives in the same `take()` helper as the `exclude` check, so both checks are unconditionally inline in the hot path — no separate dedup pass to forget.
- No signature change: `assembleCohort(store, hashedCoord, wants, exclude?, filter?)` is unchanged, so callers (`FretService.assembleCohort` and direct store users like the design simulator) are unaffected beyond getting more correct results.

## How to validate

- `cd packages/fret && npx tsc --noEmit` — clean
- `cd packages/fret && yarn test` — **285 passing, 0 failing** (re-ran full suite during this handoff to confirm current tree, not just at fix time)
- Targeted: `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cohort.properties.spec.ts" "test/cohort.assembly.spec.ts" "test/ring-membership.spec.ts" --timeout 30000` — 39 passing

## Use cases exercised

- `packages/fret/test/cohort.properties.spec.ts` previously carried its own **local duplicate** of the (buggy) `assembleCohort` algorithm instead of importing the real implementation — its property suite was never exercising production code. Replaced with a direct import of the real `assembleCohort` from `src/service/cohort.ts`, so all existing property tests now run against the fixed code path: no-duplicates, `size = min(wants, n)`, monotonic expansion, exclusion respected, deterministic same-input→same-output, n=1, all-peers-at-same-coordinate.
- New deterministic regression test — `'small ring (n ≈ wants): full distinct count returned despite cross-walk overlap'` — uses a 3-peer ring layout that reproduces the bug against the old algorithm (verified failing pre-fix, passing post-fix) and asserts both `cohort.length === n` and `new Set(cohort).size === n`.

## Known gaps / where the reviewer should push

- Only `assembleCohort` in `cohort.ts` was touched. `FretService.assembleCohort` (fret-service.ts:1170) is a thin pass-through, so no other caller needed changes; the reviewer may still want to spot-check that pass-through.
- Call sites at fret-service.ts:1140, 1181, 1262, 1275, 1542 were not touched — behavior there is strictly additive (more distinct members returned when the ring actually holds them), no signature/semantics change. Worth a reviewer skim to confirm none of them assumed the old (buggy) under-fill behavior as a feature.
- No new test exercises `assembleCohort`'s `filter` parameter (member-only ring scoping) crossed with the small-ring duplicate scenario specifically — the general property suite covers `filter` separately (via `ring-membership.spec.ts`) and the new regression test covers small-ring duplication separately, but the two haven't been combined into one case. Low risk (the fix is inside the `take()` helper, upstream of where `filter` is applied by the store), but flagging so the reviewer can judge whether that combination is worth an explicit case.
