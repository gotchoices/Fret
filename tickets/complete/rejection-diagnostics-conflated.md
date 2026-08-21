description: Reviewed a change that gave each kind of rejected inbound message its own diagnostic counter, and that fixed a case where certain malformed messages were dropped silently. Everything checked out; two small comment/ordering cleanups made in this pass.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/rpc.handler-fuzz.wire.spec.ts, docs/fret.md
---

## What shipped

Two commits, both at HEAD, verified by reading the diffs rather than the ticket history:

- **`71be306`** — the counter split. `diag.rejected.rateLimited` went from a bare number to
  `{neighbors, ping, maybeAct, leave, announce}`, with each of the five inbound token-bucket
  rejection sites incrementing its own field. New sibling `diag.rejected.concurrencyLimited`
  took over the maybeAct inflight-cap rejection, which previously shared `rateLimited` — so a
  "the peer is rate-limiting me" rejection and a "the peer is already at its concurrent-work
  cap" rejection are now separate numbers rather than one number plus a guess at
  `retry_after_ms`. `registerMaybeAct` gained an `onMalformed` callback and a `try/catch`
  around `decodeJson`.
- **`9285e95`** — the behavior fix. `71be306`'s new catch still replied with a static empty
  `NearAnchor`; this deleted that reply so an undecodable maybeAct body drops silently. The
  reason is position, not taste: `decodeJson` runs *upstream* of the maybeAct token bucket, so
  replying there is a reply-per-message amplification path that never spends a token. Metered
  guards answer; unmetered ones drop.

## Review findings

### Gate

`npx tsc --noEmit` clean; `yarn test` **1223 passing, 0 failing** (7m), from `packages/fret/`.
Re-run after this pass's edits: `tsc` clean, and the two touched specs (`rpc.handler-fuzz`,
`rpc.codec-properties`) 267 passing. No pre-existing failures surfaced, so no
`.pre-existing-error.md` was written.

### Checked and correct — no action

- **Counter split is complete and exact.** Every `rejected.rateLimited` reference in `src/` uses
  a keyed field; none is a bare unindexed counter. Five increment sites, one per protocol
  (`fret-service.ts` lines 1293, 1301, 1384, 1841, 2002 as of the implement commit), no site
  left unconverted and no double-increment. `concurrencyLimited` has exactly one increment site,
  on the inflight arm, and the bucket arm above it no longer shares it.
- **Attribution is asserted, not just the total.** `rpc.codec-properties.spec.ts` was moved off a
  summed assertion to a per-field one. This matters: a sum of 5 also passes when one path
  double-counts and another counts nothing — precisely the mis-keying a split makes possible.
  Asserting per field is what actually pins the thing the split bought.
- **The deleted test helper is genuinely obsolete.** `test/helpers/rate-limited.ts` (a
  `sumRateLimited` helper) was deleted in `6429356`. Its sole importer was
  `rpc.codec-properties.spec.ts`, updated in that same commit to the stronger per-field
  assertion above. Nothing else in `test/` or `src/` imports it. Not inlined into one caller and
  dropped from the others — the summing behavior is simply no longer wanted anywhere.
- **The undecodable-body path has real end-to-end coverage, on both halves.** This was the
  highest-risk item, because a test asserting only the counter would not catch a regression back
  to the abort tier — which tears down the connection instead of politely closing the stream.
  Both halves are asserted:
  - `rpc.handler-fuzz.spec.ts` drives an invalid-JSON body and a non-object (`null`) body through
    the real `registerMaybeAct` handler and asserts `{closes: 1, aborts: 0}` **and**
    `sends === 0`. That is the close-not-abort assertion, plus proof no reply frame is written.
  - `rpc.handler-fuzz.wire.spec.ts` drives four undecodable bodies (invalid JSON, truncated JSON,
    `null`, array) over a real transport with `expect: 'drop', counts: 'malformed'` — so the
    counter increment and the on-the-wire drop are pinned together, not separately.

  The wire spec also documents why its `abort` matrix arm now has no rows: a payload string
  cannot produce a *frame*-level failure, since those come out of `readFramed`, above anything a
  raw send can express. The arm is kept as the assertion that the two tiers stay
  distinguishable. That is the right call — deleting it would quietly retire the two-tier split's
  only structural check.
- **Docs are current.** Read directly rather than inherited from the prior run's claim. All three
  passages in `docs/fret.md` name the keyed shape correctly: the leave rate-limit note (line 94,
  `diag.rejected.rateLimited.leave`), the *Operating profiles* concurrency-cap bullet (lines
  358–359, naming both `rateLimited.maybeAct` and the `concurrencyLimited` sibling), and the
  security/abuse rate-limiting bullet (line 373, spelling out `{neighbors, ping, maybeAct, leave,
  announce}`). `9285e95`'s own one-line docs edit — extending the two-tier `registerJsonHandler`
  paragraph to state that all five handlers follow the rule and that maybeAct is the fifth,
  off-seam — is accurate. No doc action needed.
- **`diag` has no declared interface, and that is fine here.** It is a `private readonly diag =
  {...}` object literal, surfaced as `getDiagnostics(): Readonly<typeof this.diag>`. The shape is
  structural-only, but `typeof` propagates it: a consumer still reading `rejected.rateLimited` as
  a number gets a compile error at *its own* call site. That is the loud failure, which is what
  you want — a hand-written interface would only add a second copy of the shape to keep in sync.
  All six current consumers are in-repo (five test files plus the service itself) and all read
  the keyed shape.

### Fixed in this pass — minor

- `fret-service.ts` — the `malformed` field's doc comment said *"Inbound maybeAct messages that
  failed `parseRouteAndMaybeAct` (structure/type)"*. Stale in two directions: `71be306` wired
  `registerMaybeAct`'s `onMalformed` into the same counter, and it was already stale before that
  for the three `registerJsonHandler` seam call sites that also increment it. One counter, four
  handlers, two tiers, and a comment naming one of them — the same conflation this ticket exists
  to remove, sitting in the field next door to the one that got split. Replaced with a comment
  naming every increment source, plus a `NOTE:` recording that keeping it as one counter is
  deliberate (no caller has needed decode-vs-parse or per-protocol resolution) with the revisit
  condition stated. (Landed by the interrupted prior run; verified in place.)
- `maybe-act.ts` — `71be306` inserted `import { createLogger }` **and** the `const log = ...` it
  builds into the middle of the import block, splitting the imports in two around a statement.
  Moved the const below the imports. Cosmetic, no behavior change.

### Tripwires — recorded at the site, not filed

- `getDiagnostics` returns `Readonly<typeof this.diag>`, but `Readonly<>` is shallow and
  `rejected` is now a *nested* record — so a caller can mutate the counters through the returned
  handle, which is the live object rather than a copy. Nothing does today; every reader takes a
  reading. The one instance of this biting in practice was a test spreading `rejected` and
  aliasing the counter record underneath, already caught and commented in
  `rpc.codec-properties.spec.ts`. Parked as a `NOTE:` at `getDiagnostics` in `fret-service.ts`
  naming the deep-freeze/deep-clone fix if a consumer ever needs a stable snapshot. Conditional,
  so not a ticket.

### Empty categories

- **Major findings: none.** The split is complete, the two rejection kinds are genuinely
  separable now, the drop-vs-reply decision in `9285e95` is argued from where the parse sits
  relative to the token bucket (not from taste), and both are pinned by tests that would fail if
  either regressed. Nothing here needs a new ticket.
- **New tickets filed: none**, for the reason above. No site-claim grep was needed since nothing
  was filed.
- **Considered-and-declined findings encountered: none.** No accepted-tradeoff `NOTE:` sits at
  any site this change touches.

## Process note

Six budget kills across what is conceptually one focused change, and one handoff whose commit
list did not survive contact with `git log` (it named seven commits, of which the three checked
touched only `tickets/*.md`, and omitted `71be306` — the commit that made the entire source
change). Retrospective material for whoever tunes ticket sizing. Nothing to fix in the code, and
deliberately not filed as a ticket.
