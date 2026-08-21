description: Finish verifying a fix that stops a peer from sending a bogus "confidence" number outside the valid 0-100% range and having it corrupt the network's size estimate — the code change and its test coverage are both done now; only the build/test verification pass and the review handoff are left.
files: packages/fret/src/rpc/validate.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/src/service/fret-service.ts
difficulty: easy
---
<!-- resume-note -->
Fifth continuation of `wire-confidence-range-unchecked`, split off after a BUDGET_WARNING. **Both
the code change and the test coverage are done now — do not redo either.**

## Confirmed done (trust this, don't re-verify)

`packages/fret/src/rpc/validate.ts`: `finiteNumberInRangeOr` (lines 52-59) and its use in
`makeSnapshotParser` (lines 260-263, ranges `size_estimate: [0, Infinity]`, `confidence: [0, 1]`)
and `parsePingResponse` (lines 364-367) — unchanged from prior runs, confirmed present again this
run.

`packages/fret/src/service/fret-service.ts`: `calibrateSizeFromSnapshot` (lines 1863-1867) gates
`snap.size_estimate > 0 && snap.confidence > 0` before calling `reportNetworkSize` — re-confirmed
this run by direct read. `size_estimate: 0` never reaches the size observer.

**`packages/fret/test/rpc.codec-properties.spec.ts` — test coverage added this run, already in
the file, do not re-add:**
- `'drops out-of-range confidence/size_estimate independently, keeps in-range boundaries'` inside
  `describe('NeighborSnapshot normalization', ...)`, right after `'drops advisory numerics of the
  wrong type, keeping the message'` and before `'drops `metadata` unless it is a non-null
  non-array object'`. Covers: huge/negative confidence dropped, boundaries 0 and 1 kept, negative
  size_estimate dropped, 0 and huge size_estimate kept, mixed in/out-of-range fields drop
  independently without rejecting the message.
- `'parsePingResponse drops out-of-range confidence/size_estimate, keeps in-range boundaries'`
  inside `describe('reply normalization', ...)`, right after `'parsePingResponse drops advisory
  numerics individually'` and before `'parseNearAnchor rejects a reply that cannot state its
  numerics'`. Same boundary/independence coverage for the ping-response parser.

Both edits applied via `Edit` tool this run and confirmed successful (no re-read needed — trust
the tool result). A stray pre-existing TS diagnostic batch appeared in this same file at lines
~292-541 (`'await' has no effect`, `Cannot find name 'process'`) — **unrelated to this ticket's
edits**, nowhere near the two insertion points (~1928-1966 and ~1984-2007), pre-existing at HEAD.
Do not touch; if `tsc --noEmit` below surfaces the same errors, follow the pre-existing-failure
protocol (check `tickets/.pre-existing-known.md` first, else write
`tickets/.pre-existing-error.md`) rather than fixing them in this ticket.

**Skip, don't add** (per original ticket's explicit decision, still valid): a dedicated
`fast-check` property for range accept/reject — hand-written boundary cases above are sufficient
for an easy-difficulty ticket. Note this as a conscious omission in the review handoff.

**`packages/fret/test/size-observer.spec.ts` gap — investigated, not fixed, note in handoff.**
Grepped this run: zero matches for `size_estimate` / `calibrateSizeFromSnapshot` /
`reportNetworkSize` in that file. So there is no existing (or new) test asserting that a
`size_estimate: 0` snapshot is dropped rather than double-counted at the `SizeObserver` layer.
`calibrateSizeFromSnapshot` is a *private* `FretService` method with no unit seam — testing it
needs a service-level integration test (build a `FretService`, feed it a crafted snapshot via the
real merge path, assert on `getNetworkSizeEstimate()`), which is bigger than this ticket's "easy"
scope. **Do not attempt to build that integration test in this ticket** — if it's worth doing,
say so plainly in the handoff as a known gap (or file a small `debt-` ticket for it if you judge
it worth a dedicated ticket) rather than scope-creeping this one.

## What's left — do these in order

### 1. Type-check
`cd packages/fret && npx tsc --noEmit` — must be clean. If it surfaces the pre-existing diagnostic
batch noted above (unrelated `process`/`await` errors in `rpc.codec-properties.spec.ts` around
lines 292-541), that's pre-existing — follow the pre-existing-failure protocol, don't fix inline,
don't let it block this ticket's own change.

### 2. Run the affected spec directly
`cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/rpc.codec-properties.spec.ts" --timeout 30000`

Confirm the two new tests pass and nothing else regressed.

### 3. Full suite
`cd packages/fret && yarn test` before handoff.

### 4. Write the `review/` handoff ticket
Summarize the fix (range-checked `size_estimate`/`confidence` on the wire, dropped individually
when out of range rather than rejecting the whole message), list the two test cases added and
what each covers, and flag gaps honestly:
- the skipped fast-check property (deliberate, per above)
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
