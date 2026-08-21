description: Finish verifying a fix that stops a peer from sending a bogus "confidence" number outside the valid 0-100% range and having it corrupt the network's size estimate — the code change is done, it just needs tests and a build/test check before it can move on for review.
files: packages/fret/src/rpc/validate.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/src/service/fret-service.ts
difficulty: easy
---
<!-- resume-note -->
Fourth continuation of `wire-confidence-range-unchecked`, split off after a BUDGET_WARNING (this
run only re-read code and located exact insertion points; wrote nothing). **The code change is
done and does not need to be redone.** No test file edits have been made in any run yet.

## Confirmed already done (do not re-verify, just trust this)

`packages/fret/src/rpc/validate.ts`:
- `finiteNumberInRangeOr(value, min, max, fallback)` at lines 52-59. Returns `value` only when
  finite and within `[min, max]` inclusive, else `fallback`.
- `makeSnapshotParser` (line 242) uses it at lines 260-263: `size_estimate` range `[0, Infinity]`,
  `confidence` range `[0, 1]`. Each dropped individually (deleted from `out`) when out of range.
- `parsePingResponse` (line 360) does the identical thing at lines 364-367 for the same two fields.

`packages/fret/src/service/fret-service.ts`:
- `calibrateSizeFromSnapshot` (lines 1863-1867), confirmed in a prior run: gates on
  `snap.size_estimate > 0 && snap.confidence > 0` before calling `reportNetworkSize` — the
  downstream double-guard (parser accepts `size_estimate: 0`, this call site's strict `> 0` drops
  it one layer down). Not re-checked this run; trust the prior confirmation unless you have reason
  not to.

## What's left — do these in order

### 1. Add test coverage — exact edits, ready to paste

File: `packages/fret/test/rpc.codec-properties.spec.ts`. The file already imports
`makeSnapshotParser` and `parsePingResponse` (lines 36, 40) — no new imports needed. The
`describe('wire-shape parsers', ...)` block (starts line 1666) has a `parseSnapshot` built from
`CAPS` at line 1670, and a `snap(over)` helper at line 1852 (`{ v: 1, from: legalPeerIds[0],
timestamp: 1, successors: [], predecessors: [], sig: '', ...over }`) inside `describe('NeighborSnapshot
normalization', ...)`.

**Edit A** — insert a new test into `describe('NeighborSnapshot normalization', ...)`, right after
the existing test `'drops advisory numerics of the wrong type, keeping the message'` (ends at line
1936 with `expect(kept?.confidence).to.equal(0.25)` then `})`) and before
`'drops \`metadata\` unless it is a non-null non-array object'` (line 1938). Use `Edit` with
`old_string` = the tail of the advisory-numerics test plus the start of the metadata test (to
anchor uniquely), i.e.:

```
				const kept = parseSnapshot(snap({ size_estimate: 42, confidence: 0.25 }))
				expect(kept?.size_estimate).to.equal(42)
				expect(kept?.confidence).to.equal(0.25)
			})

			it('drops `metadata` unless it is a non-null non-array object', () => {
```

`new_string` = the same text with this new test spliced in between:

```
				const kept = parseSnapshot(snap({ size_estimate: 42, confidence: 0.25 }))
				expect(kept?.size_estimate).to.equal(42)
				expect(kept?.confidence).to.equal(0.25)
			})

			it('drops out-of-range confidence/size_estimate independently, keeps in-range boundaries', () => {
				// confidence must land in [0, 1]; out of range drops the field, not the message
				const tooHigh = parseSnapshot(snap({ confidence: 1_000_000_000 }))
				expect(tooHigh, 'huge confidence never rejects the message').to.not.equal(undefined)
				expect(tooHigh).to.not.have.property('confidence')
				expect(parseSnapshot(snap({ confidence: -1 }))).to.not.have.property('confidence')

				// inclusive boundaries kept - 0 is a legitimate "no information" value (see
				// handlePingRequest's NearAnchor-empty reply), 1 is full confidence
				expect(parseSnapshot(snap({ confidence: 0 }))?.confidence).to.equal(0)
				expect(parseSnapshot(snap({ confidence: 1 }))?.confidence).to.equal(1)

				// size_estimate has no upper bound (cluster size), only a floor of 0
				expect(parseSnapshot(snap({ size_estimate: -1 }))).to.not.have.property('size_estimate')
				expect(parseSnapshot(snap({ size_estimate: 0 }))?.size_estimate).to.equal(0)
				expect(parseSnapshot(snap({ size_estimate: 1_000_000_000 }))?.size_estimate).to.equal(1_000_000_000)

				// each field drops independently: an in-range field survives an out-of-range sibling
				// without affecting it or rejecting the whole message
				const mixed = parseSnapshot(snap({ confidence: 0.5, size_estimate: -5 }))
				expect(mixed, 'mixed in/out-of-range never rejects').to.not.equal(undefined)
				expect(mixed?.confidence).to.equal(0.5)
				expect(mixed).to.not.have.property('size_estimate')

				const mixed2 = parseSnapshot(snap({ confidence: -5, size_estimate: 500 }))
				expect(mixed2).to.not.have.property('confidence')
				expect(mixed2?.size_estimate).to.equal(500)
			})

			it('drops `metadata` unless it is a non-null non-array object', () => {
```

**Edit B** — insert a new test into `describe('reply normalization', ...)`, right after
`'parsePingResponse drops advisory numerics individually'` (ends at line 1987 with
`.to.deep.equal({ ok: true, confidence: 0.5 })` then `})`) and before
`'parseNearAnchor rejects a reply that cannot state its numerics'` (line 1989). `old_string`:

```
				expect(parsePingResponse({ ok: true, ts: 1, size_estimate: 'x', confidence: 0.5 }))
					.to.deep.equal({ ok: true, confidence: 0.5 })
			})

			it('parseNearAnchor rejects a reply that cannot state its numerics', () => {
```

`new_string`:

```
				expect(parsePingResponse({ ok: true, ts: 1, size_estimate: 'x', confidence: 0.5 }))
					.to.deep.equal({ ok: true, confidence: 0.5 })
			})

			it('parsePingResponse drops out-of-range confidence/size_estimate, keeps in-range boundaries', () => {
				expect(parsePingResponse({ ok: true, confidence: 1_000_000_000 })).to.not.have.property('confidence')
				expect(parsePingResponse({ ok: true, confidence: -1 })).to.not.have.property('confidence')
				expect(parsePingResponse({ ok: true, confidence: 0 })?.confidence).to.equal(0)
				expect(parsePingResponse({ ok: true, confidence: 1 })?.confidence).to.equal(1)

				expect(parsePingResponse({ ok: true, size_estimate: -1 })).to.not.have.property('size_estimate')
				expect(parsePingResponse({ ok: true, size_estimate: 0 })?.size_estimate).to.equal(0)
				expect(parsePingResponse({ ok: true, size_estimate: 1_000_000_000 })?.size_estimate)
					.to.equal(1_000_000_000)

				const mixed = parsePingResponse({ ok: true, confidence: 0.5, size_estimate: -5 })
				expect(mixed?.confidence).to.equal(0.5)
				expect(mixed).to.not.have.property('size_estimate')
			})

			it('parseNearAnchor rejects a reply that cannot state its numerics', () => {
```

(Line numbers above were accurate as of this run but may drift by a few lines if another edit
landed first — re-locate with `grep -n "drops advisory numerics\|drops .metadata.\|parseNearAnchor rejects a reply"
packages/fret/test/rpc.codec-properties.spec.ts` if the `old_string` anchors don't match verbatim.)

**Skip, don't add**: a dedicated fast-check property for range accept/reject (mentioned in an
earlier draft of this ticket) — the hand-written boundary cases above are sufficient coverage for
an easy-difficulty ticket; note in the review handoff that this was consciously not added rather
than silently omitted.

### 2. Downstream double-guard, remaining piece
Check whether `packages/fret/src/service/size-observer.ts` and
`packages/fret/src/estimate/size-estimator.ts` need anything, and whether
`packages/fret/test/size-observer.spec.ts` already covers a `size_estimate: 0` snapshot being
dropped rather than double-counted. Add a small test there only if it's a cleaner site than the
codec-properties file for this specific assertion; skip if already covered — say which in the
handoff.

### 3. Type-check
`cd packages/fret && npx tsc --noEmit` — must be clean.

### 4. Run the affected spec directly
`cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/rpc.codec-properties.spec.ts" --timeout 30000`

### 5. Full suite
`cd packages/fret && yarn test` before handoff.

### 6. Write the `review/` handoff ticket
Summarize the fix, list test cases added, flag gaps honestly (e.g. the skipped fast-check property
from step 1, and whatever step 2 concludes).

## Edge cases already covered by the code (reference, unchanged from prior handoffs)
- `confidence: NaN` / `Infinity` / `-Infinity`: rejected by `isFiniteNumber` inside
  `finiteNumberInRangeOr` by construction.
- `confidence` as a string, `null`, or missing: falls to `fallback` (field absent).
- `size_estimate: 0`: parser accepts it (`0 >= 0`); downstream `> 0` gate in
  `calibrateSizeFromSnapshot` still drops it.

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
