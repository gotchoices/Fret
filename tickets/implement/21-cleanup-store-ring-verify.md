description: After the peer routing table cleanup lands, double check a handful of older cleanup items are still fixed and run the project's normal type-check and test suite.
files: packages/fret/src/store/digitree-store.ts, packages/fret/src/store/relevance.ts, packages/fret/src/ring/distance.ts, packages/fret/src/ring/hash.ts
prereq: cleanup-store-ring-walker
difficulty: easy
----
Follow-on to `cleanup-store-ring-walker` (item 4 of the original `cleanup-store-ring` ticket).
That ticket does the ring-walker extraction in `digitree-store.ts`; this ticket does the
remaining verify-then-noop checks (item 5 of the original) plus the full build/test gate, once
the walker extraction has landed.

relevance.ts's own cleanup (inlining `withCounters`, fixing `touch`'s access-count basis, removing
the dead half-life clamp) is already done and verified — nothing to check there.

## Grep-confirm items (no-op if still true; re-run these, don't trust old results)

Original plan asserted these are already fixed elsewhere in the codebase. If any grep turns up
more than described below, flag it in the review handoff rather than expanding scope to fix it:

- coord-to-hex duplication: confirm `digitree-store.ts` is still the only user of `coordToHex`
  from `../ring/hash.js` (`grep -rn coordToHex packages/fret/src`).
- lexicographic-less padding: confirm `ring/distance.ts` `lexLess` is still the only such
  comparator (`grep -rn lexLess packages/fret/src`).
- metadata `Record<string, any>`: confirm zero `Record<string, any>` / bare `: any` matches in
  `packages/fret/src` (`grep -rn "Record<string, any>\|: any" packages/fret/src`).
- mirrored-index xor loop: confirm nothing matches a descending/mirrored-index xor pattern outside
  `lexLess` itself.

## Build/test gate

- Run `cd packages/fret && npx tsc --noEmit` — confirm the walker extraction plus the earlier
  relevance.ts edits type-check clean together.
- Run `cd packages/fret && yarn test` — pay particular attention to
  `test/digitree.invariants.spec.ts`, `test/digitree.neighbors.spec.ts`,
  `test/relevance.eviction.spec.ts` (the regression backstop named in the original plan for this
  whole cleanup).

## TODO

- Re-run the 4 grep-confirm checks above; no-op if still true, flag in review handoff if not
- Run `cd packages/fret && npx tsc --noEmit`
- Run `cd packages/fret && yarn test`

Expected behavior: no code changes expected from this ticket unless a grep turns up a regression
or the build/test gate surfaces a fallout from the walker extraction or the earlier relevance.ts
edits — in which case fix it here, since it is the last stop before review.

References: review store section, cleanup finding "Mechanical cleanups" (digitree-store.ts:208-294)
and minor finding on relevance (relevance.ts:103-113). Prior tickets `20-cleanup-store-ring`
(original, now split into `cleanup-store-ring-walker` + this ticket).
