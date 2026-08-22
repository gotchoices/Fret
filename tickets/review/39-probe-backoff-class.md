description: Continue the review of a new small class that tracks how long to wait before retrying a peer that failed to answer. Part of the review is done; the rest — running the test suite and reading the new test file — still needs doing.
files: packages/fret/src/service/probe-backoff.ts (new, 175 lines), packages/fret/test/probe-backoff.spec.ts (new, 289 lines, 15 cases — NOT YET READ), packages/fret/src/utils/expiring-map.ts (backing map, unchanged), packages/fret/src/service/fret-service.ts (unchanged; live copy at 3162-3192, constants at 246-268, construction at 509-517)
difficulty: medium
---
Continuation of the review of `probe-backoff-class`. A `BUDGET_WARNING` fired partway through this
review pass, before the test suite was run. This ticket carries the review forward; it replaces the
original review ticket, whose full implement-stage handoff is still readable at
`git show a958f81` (and `git show 788eed3` for the ticket-split commit that preceded it).

**Nothing was changed in the working tree by the interrupted pass** — it was read-only. `git status`
should still show only the two new files from the implement commit plus `tickets/.in-progress`.

## What the interrupted pass already checked

Read in full and reasoned over: `src/service/probe-backoff.ts` and its backing
`src/utils/expiring-map.ts`, plus a symbol-by-symbol comparison against the live copy still in
`FretService` (`recordBackoff` / `clearBackoff` / `getBackoffPenalty` / `pruneBackoffMap` at
`fret-service.ts:3162-3192`, the three constants at 246-268, and the map construction at 509-517).
The following were checked and came back clean — **do not re-derive these**:

- **The extraction is faithful.** `record`, `clear`, `penalty` and `prune` are line-for-line the
  service's logic with `Date.now()` replaced by the injected clock and the private statics replaced
  by instance fields. The `set`-never-read-modify-write rule, the retention-measured-from-last-
  failure property, and the `< now` vs `>= now` boundary all match the original.
- **`isBackedOff` and `penalty` are exact complements, not merely usually-in-agreement.**
  `isBackedOff` is `until >= now`; `penalty` returns 0 exactly when `until < now` and otherwise
  `min(1, factor / maxFactor)` with a retained `factor >= 1`, so `penalty > 0` iff `isBackedOff`.
  The class's own doc comment claims this; the claim holds by construction.
- **`prune` walking `ExpiringMap.keys()` is safe.** That method returns a fresh array (of live keys
  only), so deleting during the walk is fine. Expired-but-still-retained entries are not visited by
  `prune`, but `sweep` is what drops those, so no entry is unreachable by both reapers.
- **The additive-only claim holds.** The implement commit `a958f81` touched exactly two source
  files, both new, plus ticket files.

## What still needs doing

- **Run the full suite — this is the single most important item.** The implementer explicitly
  skipped it under its own budget warning and asked for it first thing in review. From
  `packages/fret`: `yarn test` (or `yarn check` from root for typecheck + build + test). If it is
  red, check `tickets/.pre-existing-known.md` before attributing anything to this ticket; the change
  is additive, so a failure in an existing spec is almost certainly pre-existing and belongs in
  `tickets/.pre-existing-error.md` per the workflow rules.
- **Read `test/probe-backoff.spec.ts` (289 lines) adversarially.** It was never opened. The implement
  handoff lists what it believes the 15 cases cover — escalation ladder, closed-window vs forgotten
  entry, retention-measured-from-last-failure, `penalty`/`isBackedOff` agreement, `prune` vs `sweep`
  orthogonality, capacity, and the retention inequality over the defaults. Confirm each is actually
  asserted rather than merely described, and look for what is missing: `clearAll`, `size`, `factor`
  after `clear`, a zero/negative `baseMs` or `maxFactor`, and `record` on the same id twice within
  one window.
- **Docs pass.** `docs/fret.md` describes this logic under *Security and abuse considerations* (the
  bounded bookkeeping maps) and under *Stabilization and churn handling*, naming the service-private
  symbols. Those descriptions are still accurate because `FretService` is unchanged — confirm that,
  and decide whether `ProbeBackoff` should be named there now or only when `probe-backoff-rewire`
  lands and deletes the originals. The interrupted pass's read is that it belongs with the rewire,
  since documenting a class nothing calls would describe intent rather than reality.
- **Weigh the implementer's four declared gaps** (all in `git show a958f81` on the ticket file):
  the unenforced `retainMs > baseMs * maxFactor` invariant, `capacity` normalization being inherited
  from `ExpiringMap` and undocumented on `ProbeBackoff`, `sweep()` discarding the dropped count, and
  the class-vs-service equivalence being argued rather than tested. Each is a candidate for a
  tripwire `NOTE:` or for an arm on the sibling `probe-backoff-rewire` ticket rather than a new
  ticket of its own — the rewire is where both implementations exist at once.
- **Then produce the `complete/` ticket** with the `## Review findings` section, folding in the
  already-clean checks listed above so that work is not lost.
