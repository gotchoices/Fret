description: Make repeated successful contact with a peer actually improve its score, and add a way to score a peer we have only been told about exactly once. This is the scoring-function half of the fix; the routing-table half follows in a companion ticket.
files: packages/fret/src/store/relevance.ts, packages/fret/test/relevance.properties.spec.ts
difficulty: easy

<!-- resume-note -->
Prior run hit BUDGET_WARNING before making any edit — pure investigation, no code touched, no
partial state to clean up. Both target files were fully read this run; every edit below is exact
and ready to apply with `Edit`, no further discovery needed. This replaces the identical prior
ticket 1:1 (same decision, same shape, same tests) — just adding surgical line-level instructions
so the next run does not re-read either file.

## Why this is split out (unchanged from prior ticket)

Carved off `25-frequency-credit-only-from-gossip` after two earlier agent runs were budget-capped
before making any edit. Nothing in this ticket touches `fret-service.ts` or `docs/fret.md` — both
belong to the companion ticket `frequency-credit-service-gossip`, which has this one as its
`prereq:`. Keep the split: one file of source, one file of test, no service reading.

## The decision (settled — do not re-open)

The relevance base is `w_r·recency + w_f·frequency + w_h·health` (0.4 / 0.2 / 0.4). Two facts
about it produce the reported inversion (a peer contacted 500 times ranking *below* one merely
named 500 times in other peers' snapshots):

- `frequency = log1p(accessCount)/5`, and **only `touch` increments `accessCount`** — and `touch`
  is what the snapshot-merge paths run for every id a *remote peer* names. So hearsay accrues
  frequency without bound.
- `health` is a *ratio*, so it saturates on the first success. `recordSuccess` touches neither
  counter that grows, so the 2nd and the 500th successful round trip add nothing.

Three rules, each checkable in isolation:

1. **A completed RPC is an access.** `recordSuccess` increments `accessCount`, exactly as `touch`
   does. Fixes "500 successes score what 1 success does".
2. **A failed RPC is not.** `recordFailure` leaves `accessCount` alone.
3. **A mention scores an entry once, at creation, and never again.** That is what
   `initialRelevance` below is for; the companion ticket wires it up.

**Health stays a pure rate — a deliberate decline, not an oversight.** Record it at `healthScore`
as an accepted-tradeoff `NOTE:` so the next reviewer does not re-file it. Revisit condition: if
the frequency term is ever removed or re-weighted to near zero.

## Exact edits — `packages/fret/src/store/relevance.ts`

**1. Add `initialRelevance`.** Insert immediately after the `touch` function (currently ends at
line 112, right before the `blendLatency` doc comment at line 114):

```ts
/**
 * Score a brand-new entry once, from its own empty counters.
 * No counter is incremented and the KDE is NOT observed: a name we were handed is not
 * a distance we accessed.
 */
export function initialRelevance(entry: PeerEntry, x: number, model: SparsityModel, now = Date.now()): number {
	const base = baseRelevance(entry, now);
	const bonus = sparsityBonus(model, x);
	return base * bonus;
}
```

Deliberately no `observeDistance(model, x)` call — that is the one thing that makes it different
from a `touch` with the increment removed.

**2. `recordSuccess` (currently lines 154–167): increment `accessCount` in both places.**

Current body:
```ts
export function recordSuccess(entry: PeerEntry, latencyMs: number | undefined, x: number, model: SparsityModel, now = Date.now()): PeerEntry {
	observeDistance(model, x);
	const avgLatencyMs = blendLatency(entry.avgLatencyMs, latencyMs);
	const base = baseRelevance({ ...entry, avgLatencyMs, successCount: entry.successCount + 1 }, now);
	const bonus = sparsityBonus(model, x);
	const relevance = base * bonus;
	return {
		...entry,
		lastAccess: now,
		relevance,
		successCount: entry.successCount + 1,
		avgLatencyMs
	};
}
```

Change to (add `accessCount: entry.accessCount + 1` to the `baseRelevance` input object, and add
`accessCount: entry.accessCount + 1` to the returned patch):
```ts
export function recordSuccess(entry: PeerEntry, latencyMs: number | undefined, x: number, model: SparsityModel, now = Date.now()): PeerEntry {
	observeDistance(model, x);
	const avgLatencyMs = blendLatency(entry.avgLatencyMs, latencyMs);
	const base = baseRelevance({ ...entry, avgLatencyMs, successCount: entry.successCount + 1, accessCount: entry.accessCount + 1 }, now);
	const bonus = sparsityBonus(model, x);
	const relevance = base * bonus;
	return {
		...entry,
		lastAccess: now,
		relevance,
		successCount: entry.successCount + 1,
		accessCount: entry.accessCount + 1,
		avgLatencyMs
	};
}
```

`recordFailure` and `touch` are unchanged.

**3. Replace the JSDoc directly above `recordSuccess`** (currently lines 129–153, the ~20-line
`NOTE:` block quoting 1.2600 / 1.5275 / 1.0449 / 0.8619 and pointing at the closed backlog slug
`tickets/backlog/bug-frequency-credit-only-from-gossip`). Replace the whole comment block with:

```ts
/**
 * Record a completed RPC against `entry`.
 *
 * `latencyMs` is **optional** because not every success carries a usable measurement — see
 * `blendLatency` above. Callers that supply no sample must likewise omit `avgLatencyMs` from
 * any patch they derive from the result.
 *
 * Frequency credit rule (settled): a completed RPC counts as an access, so `accessCount` is
 * incremented here exactly as `touch` increments it — repeated proven contact now raises
 * relevance instead of saturating after the first success. `recordFailure` does not accrue
 * frequency. A peer we were merely *told about* (never contacted) scores once at creation via
 * `initialRelevance`, and never again — it does not accumulate frequency from being renamed in
 * subsequent snapshots.
 */
```

**4. Accepted-tradeoff `NOTE:` at `healthScore`.** Add to its existing doc comment (currently
lines 74–81, just above `export function healthScore`):

```
 * NOTE: accepted tradeoff — health is deliberately a pure rate (saturates after the first
 * success) rather than a term that also grows with volume; volume lives in `frequencyScore`
 * instead. Putting volume in both would double-count it and force every weight to be re-tuned.
 * Revisit if the frequency term is ever removed or re-weighted to near zero.
```

**5. Unbounded-frequency tripwire `NOTE:` at `frequencyScore`.** Add a comment above the function
(currently line 70):

```ts
// NOTE: log1p slows but does not cap — frequency is unbounded in principle. Bounded in practice
// by real traffic now that hearsay (touch-only) accrual is gone: at accessCount 1e6 the term
// contributes 0.55 against recency/health ceilings of 0.4 each. Not a defect today; if it ever
// shows up as a problem, consider capping or re-scaling the term.
function frequencyScore(entry: PeerEntry): number {
```

## Exact edits — `packages/fret/test/relevance.properties.spec.ts`

Add `initialRelevance` to the import list at line 4–13 (alongside `recordSuccess`, `recordFailure`).

**Replace lines 300–313** (the comment block that starts "The uncontroversial half of..." and
ends just before `it('scores a success above a failure from the same starting entry'...)` at line
314) — that comment cites the now-closed slug and must go. The test at 314–324 itself
(`'scores a success above a failure from the same starting entry'`) stays **unchanged** — the
ticket requires it keep passing as-is.

Replace the deleted comment block, and add new tests, inside the `describe('recordSuccess', ...)`
block (after the existing "success above failure" test, i.e. after line 324, before the closing
`})` of that describe at line 325). Use `makeEntry` and `FIXED_NOW` already defined in the file.
Fresh `createSparsityModel()` per call so the sparsity bonus is constant across compared calls
(see existing tests in the file for the pattern):

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

And inside `describe('recordFailure', ...)`:
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

New top-level `describe('initialRelevance', ...)` block (import `initialRelevance` as above):
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

- Apply edit 1–5 to `relevance.ts` exactly as specified above.
- Apply the test edits to `relevance.properties.spec.ts` exactly as specified above.
- Leave `docs/fret.md` alone — the companion ticket owns every doc edit.
- `cd packages/fret && npx tsc --noEmit && yarn test`
- Produce the review/ handoff per the standard implement-stage output (distilled summary,
  emphasis on test coverage/use cases, honest about any gaps found while applying the above).

## End
Work ticket as described above. Do NOT commit — runner handles commits after you complete.
