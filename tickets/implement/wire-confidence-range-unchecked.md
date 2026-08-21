description: Finish verifying a fix that stops a peer from sending a bogus "confidence" number outside the valid 0-100% range and having it corrupt the network's size estimate — the code change is done, it just needs tests and a build/test check before it can move on for review.
files: packages/fret/src/rpc/validate.ts, packages/fret/test/rpc.codec-properties.spec.ts
difficulty: easy
---
<!-- resume-note -->
Continuation of the original `wire-confidence-range-unchecked` ticket, split off after a
BUDGET_WARNING mid-implementation. **The code change is already made and does not need to be
redone** — this ticket is only the verification + handoff tail.

## What's already done

In `packages/fret/src/rpc/validate.ts`:

- Added `finiteNumberInRangeOr(value, min, max, fallback)` beside `finiteNumberOr` (~line 55):
  returns the value only when it is a finite number within `[min, max]` inclusive, else
  `fallback`.
- `makeSnapshotParser` (~line 258-265): `confidence` now uses
  `finiteNumberInRangeOr(msg.confidence, 0, 1, undefined)`; `size_estimate` now uses
  `finiteNumberInRangeOr(msg.size_estimate, 0, Infinity, undefined)` (floor only, matching the
  "finite and >= 0" rule — cluster size has no fixed max).
- `parsePingResponse` (~line 365-368): same two changes, same helper calls.

Both are drop-in: an out-of-range value is dropped and falls back to `undefined`, exactly like
the existing non-finite case — no caller-visible shape change beyond a stricter accept predicate.
`FretService.calibrateSizeFromSnapshot`'s own "> 0" gate is untouched and now only ever sees
values already in range (or absent).

## What's left (in order)

1. **Add/extend unit test coverage.** In `test/rpc.codec-properties.spec.ts` (or a nearby spec if
   that file's structure doesn't fit), assert for both `makeSnapshotParser` and
   `parsePingResponse`:
   - `confidence: 1_000_000_000` and `confidence: -1` are dropped (parsed result has no
     `confidence` field / falls to fallback).
   - `confidence: 0` and `confidence: 1` are kept (inclusive boundaries — `0` is a legitimate
     "no information" value used elsewhere, e.g. `handlePingRequest`'s NearAnchor-empty reply).
   - `size_estimate: -1` is dropped; `size_estimate: 0` is still accepted at the parser (unchanged
     from before — it's `>= 0`), and confirm `calibrateSizeFromSnapshot`'s existing `> 0` check
     still drops it downstream (no double-guard gap).
   - A snapshot with an in-range `confidence` but a negative `size_estimate` (or vice versa): each
     field drops independently, doesn't reject the other field or the whole message.
   - That file likely already generates arbitrary numeric values for these fields via
     `fast-check` for its round-trip/never-throws properties — check whether it needs a new
     property (in-range accepted, out-of-range rejected) rather than just "some finite number".
2. **Type-check**: `cd packages/fret && npx tsc --noEmit` — must be clean.
3. **Run the affected spec(s) directly**: `cd packages/fret && node --import ./register.mjs
   node_modules/mocha/bin/mocha.js "test/rpc.codec-properties.spec.ts" --timeout 30000`, plus
   anything exercising `calibrateSizeFromSnapshot` / `reportNetworkSize` / `SizeObserver` if that
   lives in a separate spec file (grep for `calibrateSizeFromSnapshot` under `test/` to find it).
4. **Full suite**: `cd packages/fret && yarn test` before handoff, to catch anything unrelated the
   targeted runs miss.
5. Write the `review/` handoff ticket per the normal implement→review flow: summarize the fix,
   list the test cases added, flag any gaps honestly (e.g. if step 1's fast-check property wasn't
   extended, say so rather than silently skipping it).

## Edge cases already covered by the code (carried over from the original ticket, for reference)

- `confidence: NaN` / `Infinity` / `-Infinity`: rejected by `isFiniteNumber` inside the new helper
  by construction — no separate check needed.
- `confidence` as a string, `null`, or missing: unaffected, still falls to `fallback`.
- `size_estimate: 0`: parser still accepts it (0 >= 0); downstream `> 0` gate still drops it —
  confirm in step 1/3 that this two-layer behavior is actually still true, not just assumed.
