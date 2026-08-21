description: A malicious or badly-broken peer can send a "how sure am I" number wildly outside the sane 0-100% range, letting it single-handedly overwrite everyone else's estimate of the network's size.
files: packages/fret/src/rpc/validate.ts, packages/fret/src/service/fret-service.ts
difficulty: easy
---
Two wire parsers in `src/rpc/validate.ts` accept a `confidence` field but only check it is a
finite number, not that it falls in the `[0, 1]` range the design (`docs/fret.md`, *Network size
estimation*) defines:

- `makeSnapshotParser` (line ~253, `NeighborSnapshotV1.confidence`)
- `parsePingResponse` (line ~357, ping reply `confidence`)

Both currently use `finiteNumberOr(value, fallback)` (defined line ~50), which drops the field
only when it is non-finite. An out-of-range value — e.g. `confidence: 1_000_000_000` or a negative
number — passes straight through. `FretService.calibrateSizeFromSnapshot`
(`src/service/fret-service.ts` ~1863) gates only on "> 0" and feeds the value straight into
`SizeObserver.report`, which weights the blended network-size estimate by `recency × confidence`.
An oversized confidence swamps every honest observation (including the node's own locally computed
one); a negative one subtracts weight. See the ticket that found this
(`tickets/complete/24-wire-confidence-range-unchecked.md` after this ticket lands, currently
`tickets/plan/`) for the full analysis — not repeated here.

## The fix

Add one new helper beside `finiteNumberOr` in `src/rpc/validate.ts`:

```ts
/** The value when it is a finite number within [min, max] inclusive, else `fallback`. */
function finiteNumberInRangeOr(
	value: unknown,
	min: number,
	max: number,
	fallback: number | undefined,
): number | undefined {
	return isFiniteNumber(value) && value >= min && value <= max ? value : fallback;
}
```

Then:

- In `makeSnapshotParser`, replace the `confidence` line's `finiteNumberOr(msg.confidence,
  undefined)` with `finiteNumberInRangeOr(msg.confidence, 0, 1, undefined)`.
- In `parsePingResponse`, replace the `confidence` line's `finiteNumberOr(msg.confidence,
  undefined)` the same way.
- Leave `size_estimate` alone in both parsers (still `finiteNumberOr`, no upper bound — cluster
  size has no fixed max) but tighten its floor: use `finiteNumberInRangeOr(msg.size_estimate, 0,
  Infinity, undefined)` — equivalent to "finite and >= 0" — so a negative `size_estimate` is
  dropped at the parser seam too, rather than only being caught by
  `calibrateSizeFromSnapshot`'s existing `> 0` gate. This mirrors the ticket's suggestion to review
  whether `size_estimate`'s "greater than zero" rule belongs at the parser.

Both changes are drop-in: an out-of-range field is dropped (falls back to `undefined`), exactly
like the existing non-finite case — no caller-visible shape change, just a stricter accept
predicate. `calibrateSizeFromSnapshot`'s own "> 0" gate and the ping-response consumer are
unaffected and can stay as-is; they now only ever see values already in range (or absent).

## Edge cases & interactions

- `confidence` exactly `0` or exactly `1`: must still pass (inclusive bounds) — `0` is a
  legitimate "no information" value used elsewhere (e.g. `handlePingRequest`'s NearAnchor-empty
  reply, `buildNearAnchor`'s placeholder).
- `confidence: NaN` / `Infinity` / `-Infinity`: already rejected by the existing `isFiniteNumber`
  check inside the new helper — confirm this still holds (it does, by construction).
- `confidence` as a string, `null`, or missing: unaffected, still falls to `fallback` via
  `isFiniteNumber` returning `false`.
- `size_estimate: 0`: was previously accepted by the parser and only later dropped by
  `calibrateSizeFromSnapshot`'s `> 0` check; after this change it's still accepted at the parser
  (0 is `>= 0`) and still dropped downstream — no behavior change, confirm the downstream gate
  still fires so this isn't silently double-guarded into a gap.
- A snapshot with an in-range `confidence` but a negative `size_estimate` (or vice versa): each
  field is dropped independently — confirm one bad field doesn't reject the other or the whole
  message (matches existing per-field-drop behavior for `size_estimate` / `confidence`).
- Existing tests to check for coverage/regressions: `test/rpc.codec-properties.spec.ts` (wire-shape
  parser round-trip and never-throws properties — likely already generates arbitrary numeric
  values for these fields, so confirm it now asserts in-range acceptance and out-of-range
  rejection rather than just "some finite number"), and anything exercising
  `calibrateSizeFromSnapshot` / `reportNetworkSize` / `SizeObserver`.

## TODO

- Add `finiteNumberInRangeOr` helper in `src/rpc/validate.ts`.
- Apply it to `confidence` in `makeSnapshotParser` and `parsePingResponse`.
- Apply it (floor only, `[0, Infinity]`) to `size_estimate` in the same two parsers.
- Add/extend a unit test (in `test/rpc.codec-properties.spec.ts` or a nearby spec) asserting an
  out-of-range `confidence` (e.g. `1e9`, `-1`) is dropped by both parsers, and in-range boundary
  values (`0`, `1`) are kept.
- Run `cd packages/fret && npx tsc --noEmit` and the relevant spec file(s) directly (see AGENTS.md
  quickstart for the single-test invocation) before handoff.
