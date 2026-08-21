description: Finish verifying a fix that stops a peer from sending a bogus "confidence" number outside the valid 0-100% range and having it corrupt the network's size estimate — the code change is done, most test coverage is done and passing, and the stale test generator flagged by the prior run has now been patched; needs a fresh test run to confirm before this goes to review.
files: packages/fret/src/rpc/validate.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/src/service/fret-service.ts
difficulty: easy
---
<!-- resume-note -->
Seventh continuation of `wire-confidence-range-unchecked`, split off after a BUDGET_WARNING.

## Confirmed done (trust this, don't re-verify)

- `packages/fret/src/rpc/validate.ts`: `finiteNumberInRangeOr` and its use in `makeSnapshotParser`
  (ranges `size_estimate: [0, Infinity]`, `confidence: [0, 1]`) and `parsePingResponse` — confirmed
  present again this run.
- `packages/fret/src/service/fret-service.ts`: `calibrateSizeFromSnapshot` gates
  `snap.size_estimate > 0 && snap.confidence > 0` before calling `reportNetworkSize` — confirmed
  present again this run.
- `packages/fret/test/rpc.codec-properties.spec.ts` — the two hand-written boundary-case tests
  added by prior runs are in the file and were passing as of last confirmed run:
  - `'drops out-of-range confidence/size_estimate independently, keeps in-range boundaries'`
  - `'parsePingResponse drops out-of-range confidence/size_estimate, keeps in-range boundaries'`
- `cd packages/fret && npx tsc --noEmit` — clean as of last confirmed run (before this run's edit).
- **Skip, don't add**: dedicated `fast-check` property for range accept/reject on the boundary
  logic itself — hand-written boundary cases judged sufficient for this easy ticket. Note as
  conscious omission in the review handoff.
- **`packages/fret/test/size-observer.spec.ts` gap** — investigated in a prior run, not fixed.
  No test asserts a `size_estimate: 0` snapshot is dropped rather than double-counted at the
  `SizeObserver` layer. `calibrateSizeFromSnapshot` is a private `FretService` method with no unit
  seam; testing it needs a service-level integration test, judged out of scope for this ticket.
  **Do not attempt to build it here** — note as known gap in review handoff, or file a small
  `debt-` ticket if judged worth one.

## This run's change (done, NOT YET VERIFIED by a test run)

Prior run found: `arbLegalSnapshot` and `arbLegalPingResponse` in
`packages/fret/test/rpc.codec-properties.spec.ts` generated `size_estimate` via unconstrained
`arbJsonNumber` (including negatives), which fails the `'never reject what our own encoder
produced'` property now that `validate.ts` correctly floors `size_estimate` at 0 — the generator
was wrong, not the production code (this node's own estimator never emits a negative
`size_estimate`).

Fix applied this run:
- Added `arbNonNegativeJsonNumber` (same shape as `arbJsonNumber`, floored at 0, `-0`-filtered)
  right after `arbUnitInterval`'s definition, ~line 128.
- `arbLegalSnapshot`'s `size_estimate` field (~line 1695) switched from `arbJsonNumber` to
  `arbNonNegativeJsonNumber`.
- `arbLegalPingResponse`'s `size_estimate` field (~line 1736) switched the same way.
- Deliberately untouched: `arbNeighborSnapshot`, `arbRouteAndMaybeAct`, and every other "nasty"/
  illegal arbitrary — those back the `'never throw, whatever arrives'` properties, a different
  contract, not round-trip-unchanged.
- No existing non-negative-number arbitrary was found in the file before this addition (checked
  lines 100-260); `arbNonNegativeJsonNumber` is new, not a duplicate.

**Not yet run**: no test command has been executed against this edit. The edit is mechanical and
narrowly scoped (only touches the two `size_estimate` generator fields), but it has not been
confirmed to fix the two failures the prior run found, and has not been confirmed not to break
anything else (e.g. `fc.integer({ min: 0 })` / `fc.double({ min: 0, ... })` composing correctly
inside `fc.oneof`).

## What's left — do these in order

### 1. Type-check
`cd packages/fret && npx tsc --noEmit` — must be clean. Test-data-only change, low risk, but
unconfirmed this run.

### 2. Run the affected spec directly
`cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/rpc.codec-properties.spec.ts" --timeout 30000`

Confirm all tests pass, including the two properties that were failing before this run's fix
(`'never reject what our own encoder produced'` > `'NeighborSnapshot'` and
`'PingResponse, projected to what sendPing returns'`), and nothing else regressed. If `fast-check`
still finds a counterexample, read it carefully — it may reveal another field with the same
generator-vs-range mismatch (double-check `confidence` fields didn't have a similar issue —
`arbUnitInterval` should already be safe since it's `[0,1]` by construction, but verify).

### 3. Full suite
`cd packages/fret && yarn test` before handoff.

### 4. Write the `review/` handoff ticket
Summarize the fix (range-checked `size_estimate`/`confidence` on the wire, dropped individually
when out of range rather than rejecting the whole message), list the test cases added (the two
hand-written boundary tests from prior runs) and what each covers, note the generator fix
(this run, on top of a prior run's diagnosis) as part of getting the test suite green, and flag
gaps honestly:
- the skipped fast-check property for the range logic itself (deliberate, per above)
- the `size-observer.spec.ts` coverage gap (investigated, not fixed — service-level integration
  test needed, judged out of scope for this ticket)

Use `## Review findings`-style honesty per the ticket workflow rules — the reviewer treats this as
a starting point, not a finished proof.

## Edge cases already covered by the code (reference, unchanged from prior handoffs)
- `confidence: NaN` / `Infinity` / `-Infinity`: rejected by `isFiniteNumber` inside
  `finiteNumberInRangeOr` by construction.
- `confidence` as a string, `null`, or missing: falls to `fallback` (field absent).
- `size_estimate: 0`: parser accepts it (`0 >= 0`); downstream `> 0` gate in
  `calibrateSizeFromSnapshot` still drops it.

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
