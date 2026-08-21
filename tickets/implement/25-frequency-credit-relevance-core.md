description: Make repeated successful contact with a peer actually improve its score, and add a way to score a peer we have only been told about exactly once. This is the scoring-function half of the fix; the routing-table half follows in a companion ticket.
files: packages/fret/src/store/relevance.ts, packages/fret/test/relevance.properties.spec.ts
difficulty: easy

<!-- resume-note -->
Prior run hit BUDGET_WARNING right after finishing all 5 source edits — no partial/half-applied
state in `relevance.ts`. Confirmed by reading the file section-by-section during that run before
editing. What's done vs left:

**Done — `packages/fret/src/store/relevance.ts` (all 5 edits applied, verified via successful
Edit tool calls, do NOT re-apply):**
1. `initialRelevance` function added (right after `touch`, before the `blendLatency` doc comment).
2. `recordSuccess` now increments `accessCount` in both the `baseRelevance` input object and the
   returned patch (alongside `successCount`).
3. The ~20-line JSDoc above `recordSuccess` (the one quoting 1.2600/1.5275/1.0449/0.8619 and
   pointing at the closed backlog slug) replaced with the settled-rule version documenting the
   frequency-credit decision.
4. Accepted-tradeoff `NOTE:` appended to `healthScore`'s doc comment (pure-rate-by-design).
5. Unbounded-frequency tripwire `NOTE:` added above `frequencyScore`.

**Not started — `packages/fret/test/relevance.properties.spec.ts`:** none of the test edits from
the ticket body below have been applied yet. Needed:
- Add `initialRelevance` to the import list at the top (alongside `recordSuccess`,
  `recordFailure`, etc.).
- Delete the stale comment block at (was) lines 300–313 — starts "The uncontroversial half of...",
  cites the now-superseded backlog slug `bug-frequency-credit-only-from-gossip`. **Leave the test
  right after it — `'scores a success above a failure from the same starting entry'` — completely
  unchanged**, it must keep passing byte-for-byte as-is.
- Add new test `'scores 500 successes strictly above 1 success'` inside `describe('recordSuccess', ...)`.
- Add new test `'does not score 500 failures above 1 failure'` inside `describe('recordFailure', ...)`.
- Add new top-level `describe('initialRelevance', ...)` block with two tests: KDE-not-observed,
  and initial < a single recordSuccess on the same fresh entry/clock/model.
- Exact code for all of the above is spelled out verbatim in the "Exact edits —
  `packages/fret/test/relevance.properties.spec.ts`" section further down this ticket file
  (unchanged from the prior version — still accurate, just re-verify line numbers since the file
  may have shifted slightly; search by the quoted comment/test text, not by line number).

**Not started at all:**
- `cd packages/fret && npx tsc --noEmit && yarn test` — never run this pass. Source compiles
  conceptually (types match existing `PeerEntry` shape used elsewhere in the file) but not
  verified by a real compiler run yet.
- review/ handoff ticket — not written.

## Why this is split out (unchanged from prior tickets)

Carved off `25-frequency-credit-only-from-gossip` after two earlier agent runs were budget-capped
before making any edit, and this run made the source edit but was budget-capped before the test
edit. Nothing in this ticket touches `fret-service.ts` or `docs/fret.md` — both belong to the
companion ticket `frequency-credit-service-gossip`, which has this one as its `prereq:`. Keep the
split: one file of source (done), one file of test (pending), no service reading.

## The decision (settled — do not re-open, and do not re-derive — it's already implemented)

The relevance base is `w_r·recency + w_f·frequency + w_h·health` (0.4 / 0.2 / 0.4). Three rules,
now implemented in source:

1. **A completed RPC is an access.** `recordSuccess` increments `accessCount`, exactly as `touch`
   does. Fixes "500 successes score what 1 success does".
2. **A failed RPC is not.** `recordFailure` leaves `accessCount` alone (already true, untouched).
3. **A mention scores an entry once, at creation, and never again.** `initialRelevance` exists for
   this; the companion ticket wires it up at the call site in `fret-service.ts`.

**Health stays a pure rate** — recorded as an accepted-tradeoff `NOTE:` at `healthScore`, done.

## Exact edits — `packages/fret/test/relevance.properties.spec.ts` (still to apply)

Add `initialRelevance` to the import list (currently reads, roughly):
```ts
import {
	createSparsityModel,
	sparsityBonus,
	observeDistance,
	normalizedLogDistance,
	touch,
	recordSuccess,
	recordFailure,
	healthScore,
} from '../src/store/relevance.js'
```
→ add `initialRelevance,` to that list.

Find the comment block that starts `// The uncontroversial half of "success up-ranks a peer"...`
and ends immediately before `it('scores a success above a failure from the same starting entry'`.
Delete that comment block entirely (it cites the closed backlog slug and stale measured numbers).
**Do not touch the test itself** — `'scores a success above a failure from the same starting
entry'` (asserts succeeded.relevance > failed.relevance, ~1.26 vs ~0.63) stays exactly as-is,
including its own trailing comment about separate models for the sparsity bonus.

After that test, still inside `describe('recordSuccess', ...)`, before its closing `})`, add:
```ts
// Frequency credit: settled by tickets/implement/25-frequency-credit-relevance-core (formerly
// tickets/backlog/bug-frequency-credit-only-from-gossip). A completed RPC is an access.
it('scores 500 successes strictly above 1 success', () => {
	const now = FIXED_NOW
	let one = makeEntry({ lastAccess: now })
	one = recordSuccess(one, undefined, 0.5, createSparsityModel(), now)

	let five_hundred = makeEntry({ lastAccess: now })
	for (let i = 0; i < 500; i++) {
		five_hundred = recordSuccess(five_hundred, undefined, 0.5, createSparsityModel(), now)
	}

	expect(five_hundred.relevance).to.be.greaterThan(one.relevance)
})
```

Inside `describe('recordFailure', ...)`, add:
```ts
it('does not score 500 failures above 1 failure', () => {
	const now = FIXED_NOW
	let one = makeEntry({ lastAccess: now })
	one = recordFailure(one, 0.5, createSparsityModel(), now)

	let five_hundred = makeEntry({ lastAccess: now })
	for (let i = 0; i < 500; i++) {
		five_hundred = recordFailure(five_hundred, 0.5, createSparsityModel(), now)
	}

	expect(five_hundred.relevance).to.not.be.greaterThan(one.relevance)
})
```

New top-level `describe('initialRelevance', ...)` block (place it near the other top-level
describes, e.g. after `describe('recordFailure', ...)`'s closing `})`, before the outer
`describe('Relevance scoring properties', ...)`'s own closing `})`):
```ts
describe('initialRelevance', () => {
	it('does not move model.occupancy (a mention is not an observed distance)', () => {
		const model = createSparsityModel()
		const before = Float64Array.from(model.occupancy)
		initialRelevance(makeEntry(), 0.5, model, FIXED_NOW)
		expect(Array.from(model.occupancy)).to.deep.equal(Array.from(before))
	})

	it('scores strictly below a single recordSuccess on the same fresh entry, same clock/model', () => {
		const now = FIXED_NOW
		const entry = makeEntry({ lastAccess: now })
		const initial = initialRelevance(entry, 0.5, createSparsityModel(), now)
		const succeeded = recordSuccess(entry, undefined, 0.5, createSparsityModel(), now)
		expect(initial).to.be.lessThan(succeeded.relevance)
	})
})
```

## TODO (execution order)

- Apply the test edits above to `relevance.properties.spec.ts` exactly as specified.
- Leave `docs/fret.md` and `fret-service.ts` alone — the companion ticket owns those.
- `cd packages/fret && npx tsc --noEmit && yarn test` — run for real this time, fix anything that
  doesn't compile/pass (should be clean given the source is already correct and tests match its
  behavior, but verify — don't assume).
- Produce the review/ handoff per the standard implement-stage output (distilled summary,
  emphasis on test coverage/use cases, honest about any gaps found while applying the above).

## End
Work ticket as described above. Do NOT commit — runner handles commits after you complete.
