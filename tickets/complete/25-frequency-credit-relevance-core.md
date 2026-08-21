description: Repeated successful contact with a peer now raises its routing-table relevance instead of counting the same as a single contact, and there is a new way to score a peer we have only ever been told about. Reviewed and complete.
files: packages/fret/src/store/relevance.ts, packages/fret/test/relevance.properties.spec.ts

## What shipped

Three rules in `packages/fret/src/store/relevance.ts`:

1. **A completed RPC is an access.** `recordSuccess` increments `accessCount` (both the object it
   scores against and the entry it returns), exactly as `touch` already did. Previously it did
   not, so the frequency component of relevance was flat: 500 successes scored what 1 success did.
2. **A failed RPC is not an access.** `recordFailure` leaves `accessCount` alone — unchanged
   behavior, now directly asserted rather than assumed.
3. **A mention scores once, at creation, never again.** New `initialRelevance(entry, x, model, now)`
   scores a brand-new entry from its own empty counters, incrementing nothing and deliberately not
   feeding the sparsity KDE — a name we were handed is not a distance we measured.

Plus a JSDoc block on `recordSuccess` stating the settled rule, an accepted-tradeoff `NOTE:` on
`healthScore` (stays a pure success/failure rate; volume lives in the frequency term instead), and
a tripwire `NOTE:` on `frequencyScore` (unbounded in principle).

`initialRelevance` has no production caller yet. That is by design — the gossip-ingestion call site
in `fret-service.ts`, and the matching `docs/fret.md` update, belong to the companion ticket
`frequency-credit-service-gossip`, which lists this one as its `prereq:`.

## Review findings

**Checked:** the full implement-stage diff (source and tests) read before the handoff summary; the
scoring arithmetic re-derived by hand; every comment the change added or rewrote checked against
what the code at HEAD actually does; the `touch` / `applyTouch` call graph in `fret-service.ts`;
test coverage against the three rules the ticket claims to implement; naming and house style;
`npx tsc --noEmit`; the `relevance.properties.spec.ts` suite.

**The flagged golden value is correct — confirmed independently, not rubber-stamped.** The handoff
asked for a second pair of eyes on `succeeded.relevance` moving from `1.26` to
`1.3099065970003163`, noting it was read off the running code rather than derived. Derived from the
formula here: a fresh entry at `lastAccess === now` gives recency 1; one success with
`accessCount` 0→1 gives frequency `ln(2)/5 = 0.1386294`; health is `0.5·1 + 0.5·(1 − 0.5) = 0.75`
(unmeasured latency takes the neutral 0.5 penalty). Base is
`0.4·1 + 0.2·0.1386294 + 0.4·0.75 = 0.72772589`. A fresh sparsity model has zero occupancy, so the
bonus clamps to `sMax` = 1.8, giving `1.3099065970003163` exactly. The companion `failed` value of
`0.63` was re-derived the same way and is likewise unchanged, as expected — `recordFailure` never
touched `accessCount`. So the moved value is an intended consequence of rule 1, not a regression.

**Fixed in this pass (minor):**

- *Two new comments described the companion ticket's end state as if it were already true.* The
  `frequencyScore` tripwire claimed frequency was "bounded in practice by real traffic now that
  hearsay (touch-only) accrual is gone", and the `recordSuccess` JSDoc claimed a peer we were merely
  told about "scores once at creation via `initialRelevance`, and never again". Neither holds at
  HEAD: `applyTouch` is still called from both snapshot-merge paths
  (`fret-service.ts:1939`, `:1963`, `:2529`, `:2540`), so gossip still accrues frequency on every
  merge. A reader at HEAD was being told the opposite of the truth by the very comments added to
  prevent re-derivation. Both rewritten to state today's behavior and name
  `frequency-credit-service-gossip` as what changes it.
- *The ticket's headline rule was only pinned indirectly.* Coverage asserted relevance *ordering*
  (500 successes above 1), which would still pass if `accessCount` were incremented by any positive
  amount, or if the ordering came from some other term. Added two direct assertions —
  `recordSuccess` increments `accessCount` by exactly 1, and `recordFailure` leaves it alone —
  mirroring the existing `touch` test. These pin rules 1 and 2 at the counter rather than through
  the score.
- *Snake_case test locals (`five_hundred`) against a camelCase codebase.* Renamed.

**Verified as correct, no change needed:** `initialRelevance` not observing the KDE (pinned by the
occupancy test, and correct — a mention is not an observed distance); `recordFailure`'s unchanged
`accessCount` behavior; the weak-looking `to.not.be.greaterThan` in the 500-failures test, which is
the right assertion since repeated failures produce an identical relevance rather than a decreasing
one; the `healthScore` accepted-tradeoff `NOTE:`, which states what was declined, why, and its
revisit condition.

**Major findings: none.** No ticket filed. The change is small, single-purpose, confined to one
pure scoring module with no resource or error-handling surface, and the one architectural question
it raises (gossip still accruing frequency through `touch`) is already owned by an existing
companion ticket rather than being a new class of defect.

**Tripwires: none new.** The `frequencyScore` unbounded-frequency `NOTE:` the implementer added is
itself a correctly-placed tripwire and was kept, with its factual claim corrected as above.

**Docs:** `docs/fret.md` deliberately untouched, and correctly so. Its relevance-scoring section
describes the score formula and the `avgLatencyMs` nullable, neither of which this change alters;
the user-visible behavior change (gossip no longer earning frequency credit) does not exist until
the companion ticket wires up `initialRelevance`, so documenting it now would repeat exactly the
error corrected in the two code comments above.

## Verification

- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/relevance.properties.spec.ts"` — **32 passing, 0 failing.**
- The implementer ran the full suite (`yarn test`) green at this source state — 1200 passing. This
  review pass did not re-run it: every edit made here is a comment rewrite, a test-local variable
  rename, or a new assertion inside this one spec file, none of which can reach another spec. Stated
  plainly rather than implied.

No pre-existing or unrelated failures encountered.
