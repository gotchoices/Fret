description: Make repeated successful contact with a peer actually improve its score, and add a way to score a peer we have only been told about exactly once. This is the scoring-function half of the fix; the routing-table half follows in a companion ticket.
files: packages/fret/src/store/relevance.ts, packages/fret/test/relevance.properties.spec.ts
difficulty: easy

<!-- resume-note -->
Fifth run hit BUDGET_WARNING immediately after landing the final test edit — the Edit tool call
succeeded (confirmed by tool result) before the warning arrived, so no half-applied state. Nothing
else was touched this run.

**Everything is now done except running the verification pass and writing the review/ handoff.**

**Done — `packages/fret/src/store/relevance.ts`:** all 5 source edits, confirmed correct across
multiple prior runs (see git log for `ticket(implement): frequency-credit-relevance-core` for
detail — do NOT re-read, do NOT re-derive, source is finished):
1. `initialRelevance(entry, x, model, now = Date.now())` function (after `touch`, before
   `blendLatency`) — positional signature confirmed: entry, x, model, now.
2. `recordSuccess` increments `accessCount` (input object + returned patch).
3. JSDoc above `recordSuccess` documents the settled frequency-credit rule.
4. Accepted-tradeoff `NOTE:` on `healthScore` (pure-rate-by-design).
5. Unbounded-frequency tripwire `NOTE:` above `frequencyScore`.

**Done — `packages/fret/test/relevance.properties.spec.ts`:** all edits landed, including this
run's final one. Confirmed present in file as of this write:
- `initialRelevance` imported from `../src/store/relevance.js` (line 13).
- Stale comment block (citing the closed backlog slug) removed.
- `describe('recordSuccess', ...)` contains `'scores 500 successes strictly above 1 success'`
  (~line 315), added by a prior run.
- `describe('recordFailure', ...)` now contains `'does not score 500 failures above 1 failure'`,
  added this run, right after the existing `'advances lastAccess to now'` test, before that
  describe's closing `})`.
- A new top-level `describe('initialRelevance', ...)` block now exists, added this run, placed
  after `describe('recordFailure', ...)`'s closing `})` and before the outer
  `describe('Relevance scoring properties', ...)`'s own closing `})`. Contains two tests:
  `'does not move model.occupancy (a mention is not an observed distance)'` and
  `'scores strictly below a single recordSuccess on the same fresh entry, same clock/model'`.

The file should now have exactly these describe blocks under the outer describe, in order:
`sparsityBonus`, `observeDistance`, `normalizedLogDistance`, `healthScore`, `touch`,
`recordSuccess`, `recordFailure`, `initialRelevance`.

**Not started — the only remaining work:**

1. `cd packages/fret && npx tsc --noEmit && yarn test` — never run this pass on this file across
   any prior run. Source is already correct and tests are believed to match its behavior, but this
   has never been verified by actually running it. Run it for real; fix anything that doesn't
   compile or pass. If something fails, check first whether it's a source issue (unlikely — 5 runs
   have confirmed the source edits) vs. a test issue (more likely, since the test edits are newer
   and less scrutinized) vs. a genuinely pre-existing failure unrelated to this ticket (see the
   `.pre-existing-known.md` / `.pre-existing-error.md` protocol in the ticket workflow rules if so).
2. Produce the review/ handoff ticket per the standard implement-stage output: distilled summary,
   emphasis on test coverage and use cases for validation, honest about any gaps found while
   running the above. Delete this ticket from `tickets/implement/` once the handoff lands in
   `tickets/review/`.

## Why this is split out (unchanged from prior tickets)

Carved off `25-frequency-credit-only-from-gossip` after repeated agent runs were budget-capped
before finishing. Source file has been done for several runs; the test file edits are now
complete as of this run. Nothing in this ticket touches `fret-service.ts` or `docs/fret.md` — both
belong to the companion ticket `frequency-credit-service-gossip`, which has this one as its
`prereq:`.

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

- `cd packages/fret && npx tsc --noEmit && yarn test` — run for real, fix anything that doesn't
  compile/pass.
- Produce the review/ handoff per the standard implement-stage output (distilled summary,
  emphasis on test coverage/use cases, honest about any gaps found while applying the above).
- Leave `docs/fret.md` and `fret-service.ts` alone — the companion ticket owns those.

## End
Work ticket as described above. Do NOT commit — runner handles commits after you complete.
