description: The scoring code that decides how much a peer's connection history counts toward its routing-table relevance now credits repeated successful contact and one-time mentions correctly; this ticket hands that work to review.
files: packages/fret/src/store/relevance.ts, packages/fret/test/relevance.properties.spec.ts
difficulty: easy

## What changed and why

Old behavior: `recordSuccess` never touched `accessCount`, so the frequency component of relevance
was flat regardless of how many times a peer answered — "500 successes scored what 1 success did."
There was also no way to score a peer we only ever heard about via gossip (a mention), separate
from one we actually contacted.

Three rules now implemented in `packages/fret/src/store/relevance.ts`:

1. **A completed RPC is an access.** `recordSuccess` increments `accessCount` (input object +
   returned patch), exactly as `touch` already did. This raises the frequency-score component,
   which is why one test's golden relevance value moved (see "Gap to flag" below).
2. **A failed RPC is not an access.** `recordFailure` deliberately leaves `accessCount` alone —
   unchanged behavior, pinned by an existing passing assertion.
3. **A mention scores an entry once, at creation, never again.** New function `initialRelevance(entry, x, model, now = Date.now())`, positioned after `touch` and before `blendLatency`. Wiring
   this up at the actual gossip call site (`fret-service.ts`) is explicitly **out of scope** —
   that's the companion ticket `frequency-credit-service-gossip`, which has this ticket as its
   `prereq:`.

Also landed:
- JSDoc above `recordSuccess` documenting the settled frequency-credit rule (so a future reader
  doesn't have to re-derive it from git blame).
- Accepted-tradeoff `NOTE:` on `healthScore` — it stays a pure rate (success/failure ratio), not
  frequency-weighted, by design.
- Tripwire `NOTE:` above `frequencyScore` — flags that frequency is currently unbounded (log-slowing
  but no ceiling); noted as a watch item, not fixed here.

## Test coverage — what to look at for validation

`packages/fret/test/relevance.properties.spec.ts`, `describe('Relevance scoring properties', ...)`:

- `describe('recordSuccess', ...)`: `'scores 500 successes strictly above 1 success'` — the actual
  regression-shaped test for rule 1 (frequency isn't flat/capped-at-one-access).
- `describe('recordFailure', ...)`: `'does not score 500 failures above 1 failure'` — mirror test
  proving rule 2 (failures still don't accrue frequency credit) holds under repetition too, not
  just the single-failure case.
- `describe('initialRelevance', ...)` (new top-level block, placed after `recordFailure`'s):
  - `'does not move model.occupancy (a mention is not an observed distance)'` — a mention must not
    perturb the sparsity KDE the way an actual observed distance would.
  - `'scores strictly below a single recordSuccess on the same fresh entry, same clock/model'` —
    pins the ordering rule 3 implies: hearing about a peer once is worth less than actually
    contacting it once.

## Gap to flag for the reviewer

One golden-value test needed updating as a **direct, intended consequence** of rule 1, not a
regression: `'scores a success above a failure from the same starting entry'` (line ~301). Before
this ticket, `recordSuccess` didn't touch `accessCount`, so `succeeded.relevance` computed to
`1.26`. With `accessCount` now incremented, the correct value is `1.3099065970003163` — the
`greaterThan` comparison on the line above it already passed both before and after, and the
`failed.relevance` golden value (`0.63`, from `recordFailure`, which is intentionally untouched by
this ticket) did not move. Worth a second pair of eyes confirming `1.3099065970003163` is actually
right rather than rubber-stamped — it was derived by running the actual code, not hand-calculated
against the formula in `docs/fret.md`.

## Explicitly out of scope (companion ticket)

`fret-service.ts` and `docs/fret.md` are untouched. Calling `initialRelevance` at the gossip
ingestion site, and any doc updates describing the wired-up behavior, belong to
`tickets/implement/frequency-credit-service-gossip` (or wherever that ticket currently sits),
which lists this ticket as its `prereq:`.

## Verification run this pass

- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && yarn test` — **1200 passing, 0 failing.**

No pre-existing/unrelated failures encountered.
