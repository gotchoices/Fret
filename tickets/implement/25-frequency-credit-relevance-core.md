description: Make repeated successful contact with a peer actually improve its score, and add a way to score a peer we have only been told about exactly once. This is the scoring-function half of the fix; the routing-table half follows in a companion ticket.
files: packages/fret/src/store/relevance.ts, packages/fret/test/relevance.properties.spec.ts
difficulty: easy

<!-- resume-note -->
Fourth run hit BUDGET_WARNING before making any edits — spent its budget re-reading both files to
verify prior-run claims, made zero changes. Both reads confirm the third run's resume-note below is
accurate and current; nothing has drifted. Specifically verified this run:
- `packages/fret/src/store/relevance.ts` — all 5 source edits present exactly as described below,
  including `initialRelevance(entry, x, model, now = Date.now())` signature (line 128) — matches
  the call shape used in the "not started" test snippets below (`initialRelevance(entry, 0.5,
  model, now)` positional order: entry, x, model, now). Do not second-guess this signature again.
- `packages/fret/test/relevance.properties.spec.ts` — `initialRelevance` import present (line 13),
  stale comment block gone, the `'scores 500 successes strictly above 1 success'` test present
  and correct (lines 315-326). The two "not started" edits below are still, in fact, not started.

Next run: skip re-verification, go straight to applying the two edits below, then run
`cd packages/fret && npx tsc --noEmit && yarn test`, then write the review/ handoff. Do not re-read
relevance.ts — it is done, confirmed twice now.

Third run hit BUDGET_WARNING mid-edit. No half-applied state in either file — each edit that
landed was a complete, verified Edit tool call. What's done vs left:

**Done — `packages/fret/src/store/relevance.ts`:** all 5 source edits from earlier runs, unchanged
and confirmed correct by reading the file this run (see prior resume-note history in git log for
detail — do NOT re-apply, do NOT re-derive, source is finished):
1. `initialRelevance` function (after `touch`, before `blendLatency`).
2. `recordSuccess` increments `accessCount` (input object + returned patch).
3. JSDoc above `recordSuccess` documents the settled frequency-credit rule.
4. Accepted-tradeoff `NOTE:` on `healthScore` (pure-rate-by-design).
5. Unbounded-frequency tripwire `NOTE:` above `frequencyScore`.

**Done this run — `packages/fret/test/relevance.properties.spec.ts`:**
- `initialRelevance` added to the import list from `../src/store/relevance.js`.
- Stale comment block ("The uncontroversial half of...", citing the closed backlog slug
  `bug-frequency-credit-only-from-gossip`) deleted. The test right after it —
  `'scores a success above a failure from the same starting entry'` — is untouched, still passes
  byte-for-byte as before.
- New test added inside `describe('recordSuccess', ...)`, right after the above test, before that
  describe's closing `})`:
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
- **Known transient diagnostic (expected, will self-resolve):** editor reports
  `'initialRelevance' is declared but its value is never read. [6133]` — true right now because the
  `initialRelevance` describe block below hasn't been added yet. Not a real problem, don't
  "fix" it by removing the import; the next task adds its only caller.

**Not started — still need these exact edits to
`packages/fret/test/relevance.properties.spec.ts`:**

1. Inside `describe('recordFailure', ...)`, add (anywhere in the block, before its closing `})`):
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
2. New top-level `describe('initialRelevance', ...)` block, placed after
   `describe('recordFailure', ...)`'s closing `})`, before the outer
   `describe('Relevance scoring properties', ...)`'s own closing `})`:
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

**Not started at all:**
- `cd packages/fret && npx tsc --noEmit && yarn test` — never run this pass on this file. Run it
  for real after the two edits above land, fix anything that doesn't compile/pass (source is
  already correct and tests match its behavior — verify, don't assume).
- review/ handoff ticket — not written. Standard implement-stage output: distilled summary,
  emphasis on test coverage/use cases, honest about gaps.

## Why this is split out (unchanged from prior tickets)

Carved off `25-frequency-credit-only-from-gossip` after repeated agent runs were budget-capped
before finishing. Source file is done and has been for several runs — only the test file has
outstanding edits, now down to two small additions. Nothing in this ticket touches `fret-service.ts`
or `docs/fret.md` — both belong to the companion ticket `frequency-credit-service-gossip`, which
has this one as its `prereq:`.

## The decision (settled — do not re-open, and do not re-derive — it's already implemented)

The relevance base is `w_r·recency + w_f·frequency + w_h·health` (0.4 / 0.2 / 0.4). Three rules,
implemented in source (see "Done" above):

1. **A completed RPC is an access.** `recordSuccess` increments `accessCount`, exactly as `touch`
   does. Fixes "500 successes score what 1 success does".
2. **A failed RPC is not.** `recordFailure` leaves `accessCount` alone (already true, untouched).
3. **A mention scores an entry once, at creation, and never again.** `initialRelevance` exists for
   this; the companion ticket wires it up at the call site in `fret-service.ts`.

**Health stays a pure rate** — recorded as an accepted-tradeoff `NOTE:` at `healthScore`, done.

## TODO (execution order)

- Apply the two test edits above to `relevance.properties.spec.ts` exactly as specified.
- Leave `docs/fret.md` and `fret-service.ts` alone — the companion ticket owns those.
- `cd packages/fret && npx tsc --noEmit && yarn test` — run for real, fix anything that doesn't
  compile/pass.
- Produce the review/ handoff per the standard implement-stage output (distilled summary,
  emphasis on test coverage/use cases, honest about any gaps found while applying the above).

## End
Work ticket as described above. Do NOT commit — runner handles commits after you complete.
