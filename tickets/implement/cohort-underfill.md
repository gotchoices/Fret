description: On small networks the cohort assembly could return fewer members than requested even when enough distinct members exist; this is now fixed with a regression test.
files: packages/fret/src/service/cohort.ts, packages/fret/test/cohort.properties.spec.ts
difficulty: easy
----
## Root cause (confirmed)
`assembleCohort` (packages/fret/src/service/cohort.ts) over-fetches `wants * 2` ids from each of `neighborsRight`/`neighborsLeft`, then alternately merges them, checking only the caller's `exclude` set. When the ring is small (n ≈ wants), both walks wrap the ring and can return the *same* underlying ids in different orders. The alternating loop counted a duplicate id (present in both `succIds` and `predIds`) as if it were two distinct entries while advancing `out.length` toward `wants`, then a **final** `Array.from(new Set(out))` collapsed the duplicates — shrinking the result below `wants` even though the ring held `wants` distinct members.

Reproduced directly against `DigitreeStore`/old algorithm: 3 peers on the ring, `wants = 3` → old code returned only 2 distinct ids (`['p0_0', 'p1_0']`); the ring genuinely holds 3.

## Fix
Track a `seen` set alongside `exclude` *inside* the merge loop (not just at the end), so a duplicate crossing the two walks is skipped immediately and the loop keeps pulling from the walks until it actually collects `wants` distinct ids (or exhausts both). The trailing `Array.from(new Set(...))` dedup was removed since dedup now happens inline — `out` is guaranteed distinct by construction.

```ts
const seen = new Set<string>();
const take = (id: string | undefined) => {
	if (id && !ex.has(id) && !seen.has(id)) {
		seen.add(id);
		out.push(id);
	}
};
// ...alternating walk calls take(succIds[si++]) / take(predIds[pi++])
return out.slice(0, wants);
```

## Test coverage added
`packages/fret/test/cohort.properties.spec.ts` previously carried its own **local duplicate** of the (buggy) `assembleCohort` algorithm instead of importing the real implementation from `src/service/cohort.ts` — so its property suite was never exercising production code. Replaced the local copy with a direct import of the real `assembleCohort`, so all existing property tests (no-duplicates, `size = min(wants, n)`, monotonic expansion, exclusion, determinism, same-coordinate, n=1) now run against the actual fixed code path.

Added a new deterministic regression test, `'small ring (n ≈ wants): full distinct count returned despite cross-walk overlap'`, using the exact 3-peer/coord layout that reproduced the bug against the old algorithm (verified failing pre-fix, passing post-fix).

## Verification
- `cd packages/fret && npx tsc --noEmit` — clean
- `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cohort.properties.spec.ts" "test/cohort.assembly.spec.ts" "test/ring-membership.spec.ts" --timeout 30000` — 39 passing
- `cd packages/fret && yarn test` (full suite) — 285 passing, 0 failing

## Gaps for reviewer
- Only `assembleCohort` in `cohort.ts` was touched; `FretService.assembleCohort` (fret-service.ts:1170) is a thin pass-through so no other caller needed changes.
- Did not touch the `assembleCohort` usage sites (fret-service.ts:1140, 1181, 1262, 1275, 1542) — behavior there is strictly additive (more distinct members returned when available), no signature/semantics change.
