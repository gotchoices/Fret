description: Finish verifying a fix that stops a peer from sending a bogus "confidence" number outside the valid 0-100% range and having it corrupt the network's size estimate — the code change is done, most test coverage is done and passing, but the fix just added surfaced a stale test generator that now needs a matching update before this can go to review.
files: packages/fret/src/rpc/validate.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/src/service/fret-service.ts
difficulty: easy
---
<!-- resume-note -->
Sixth continuation of `wire-confidence-range-unchecked`, split off after a BUDGET_WARNING.

## Confirmed done (trust this, don't re-verify)

- `packages/fret/src/rpc/validate.ts`: `finiteNumberInRangeOr` and its use in `makeSnapshotParser`
  (ranges `size_estimate: [0, Infinity]`, `confidence: [0, 1]`) and `parsePingResponse` — confirmed
  present again this run.
- `packages/fret/src/service/fret-service.ts`: `calibrateSizeFromSnapshot` gates
  `snap.size_estimate > 0 && snap.confidence > 0` before calling `reportNetworkSize` — confirmed
  present again this run.
- `packages/fret/test/rpc.codec-properties.spec.ts` — the two hand-written boundary-case tests
  added by prior runs are in the file and **pass**:
  - `'drops out-of-range confidence/size_estimate independently, keeps in-range boundaries'`
    (NeighborSnapshot normalization) — passing this run.
  - `'parsePingResponse drops out-of-range confidence/size_estimate, keeps in-range boundaries'`
    (reply normalization) — passing this run.
- `cd packages/fret && npx tsc --noEmit` — **clean this run**, no output, no errors.
- **Skip, don't add**: a dedicated `fast-check` property for range accept/reject on the new
  boundary logic itself — hand-written boundary cases are sufficient for this easy-difficulty
  ticket. Still a conscious omission to note in the eventual review handoff.
- **`packages/fret/test/size-observer.spec.ts` gap** — investigated in a prior run, not fixed.
  Zero matches for `size_estimate` / `calibrateSizeFromSnapshot` / `reportNetworkSize` in that
  file, so there is no test asserting a `size_estimate: 0` snapshot is dropped rather than
  double-counted at the `SizeObserver` layer. `calibrateSizeFromSnapshot` is a private
  `FretService` method with no unit seam; testing it needs a service-level integration test,
  judged out of scope for this ticket. **Do not attempt to build it here** — note as a known gap
  in the review handoff, or file a small `debt-` ticket if judged worth one.

## New finding this run — the actual blocker

Ran the affected spec directly:
```
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/rpc.codec-properties.spec.ts" --timeout 30000
```
Result: **108 passing, 2 failing.** Both failures are in
`describe('wire-shape parsers' > 'never reject what our own encoder produced', ...)` — a
pre-existing (not written by this ticket) `fast-check` property suite that asserts: take a value
this node's own encoder would legally produce, round-trip it through the wire codec and the
parser, and it must come back byte-for-byte unchanged (never rejected, never normalized away).

Both failures are fast-check-shrunk counterexamples where the **generator** produced a *negative*
`size_estimate`:
1. `NeighborSnapshot` — counterexample `size_estimate: -5e-324` (smallest negative subnormal).
   `expected { v: 1, …(6) } to deeply equal { v: 1, …(7) }` — the parser correctly dropped the
   out-of-range field (per the ticket's own range-check fix), but the property still expected it
   to survive.
2. `PingResponse, projected to what sendPing returns` — counterexample `size_estimate: -1`. Same
   shape: parser correctly drops it, property expected it kept.

**Root cause: the generators are wrong, not the production code.** These "legal" generators are
meant to model exactly what this node's own encoder can produce — and this node's own
`calibrateSizeFromSnapshot`/estimator code never emits a negative `size_estimate` (see the
`docs/fret.md` note: "size_estimate has no upper bound (cluster size), only a floor of 0", which
is also the exact comment already sitting next to the hand-written boundary tests in this same
file). Before this ticket's range-check landed in `validate.ts`, the parser accepted *any* finite
number unchanged, so the generator's oversight (allowing negatives) never showed up. Now that the
parser correctly enforces the floor, the generator needs to match it.

**This is not a pre-existing-failure case.** It is directly caused by this ticket's own change
(the new range check) interacting with a test generator that was never scoped to the new
constraint. Do not route it through the `tickets/.pre-existing-error.md` protocol — fix it here.

### Fix needed

In `packages/fret/test/rpc.codec-properties.spec.ts`:
- `arbLegalSnapshot` (around line 1695): `size_estimate: arbJsonNumber` generates unconstrained
  finite numbers, including negatives. Replace with a generator that only produces finite numbers
  `>= 0` (no upper bound — mirror how `confidence` in the same record already uses
  `arbUnitInterval` to stay in-range, i.e. add an analogous "non-negative" arbitrary rather than
  reusing `arbJsonNumber`).
- `arbLegalPingResponse` (around line 1736): same field, same problem, same fix.
- Do **not** touch `arbNeighborSnapshot` / `arbRouteAndMaybeAct` / other "nasty"/illegal
  arbitraries used by the `'never throw, whatever arrives'` properties (e.g. the one at line 201) —
  those are deliberately unconstrained/hostile inputs and are a different test property (must not
  throw, not must-round-trip-unchanged). Only the two "legal" generators above need the range
  constraint.
- Check whether an existing non-negative-number arbitrary already exists in this file (grep
  `arbJsonNumber`, `arbUnitInterval`, `arbNonNegative` around lines 180-260 where the shared
  arbitraries are defined) before adding a new one — reuse if one already fits.

## What's left — do these in order

### 1. Fix the two generators
As described above, in `packages/fret/test/rpc.codec-properties.spec.ts`.

### 2. Type-check
`cd packages/fret && npx tsc --noEmit` — must stay clean (already confirmed clean before this
edit; a test-data-only change shouldn't affect it, but confirm).

### 3. Run the affected spec directly
`cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/rpc.codec-properties.spec.ts" --timeout 30000`

Confirm all tests pass now, including the previously-failing two properties, and nothing else
regressed. If `fast-check` still finds a counterexample, read it carefully — it may reveal another
field with the same generator-vs-range mismatch (e.g. double check `confidence` fields didn't have
a similar issue — `arbUnitInterval` should already be safe, but verify no other field in either
record uses an unconstrained generator for a now-range-checked field).

### 4. Full suite
`cd packages/fret && yarn test` before handoff.

### 5. Write the `review/` handoff ticket
Summarize the fix (range-checked `size_estimate`/`confidence` on the wire, dropped individually
when out of range rather than rejecting the whole message), list the test cases added (the two
hand-written boundary tests from prior runs) and what each covers, note the generator fix from
this run as part of getting the test suite green, and flag gaps honestly:
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
