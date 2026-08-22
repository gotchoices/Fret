description: Reviewed a new small class that tracks how long to wait before retrying a peer that failed to answer. The extraction is faithful, its tests pass, and two small test gaps were handed to the follow-up ticket that already owns that file.
files: packages/fret/src/service/probe-backoff.ts (new, 181 lines), packages/fret/test/probe-backoff.spec.ts (new, 289 lines, 15 cases), packages/fret/src/utils/expiring-map.ts (backing map, unchanged), packages/fret/src/service/fret-service.ts (unchanged)
---
`ProbeBackoff` (`src/service/probe-backoff.ts`) is the per-peer escalating retry window, lifted out
of `FretService` so its arithmetic can be unit-tested against an injected clock instead of sleeps
and a libp2p node. The change is **purely additive**: two new files, and `FretService` still runs
its own private copy. Nothing imports the class yet — the sibling `probe-backoff-rewire` ticket
switches the service over and deletes the original, and `backoff-test-surface-migration` then
converts the eight spec files that reach the old private field.

Reviewed across two passes; the first was cut short by a budget warning after the read-and-reason
work but before the suite ran, and a continuation ticket carried the rest forward.

## Review findings

### Ran

- **Full suite, `yarn test` from `packages/fret`: 1263 passing, 0 failing, ~10 min.** This was the
  implementer's explicitly-deferred item and the review ticket's top priority. All 15
  `ProbeBackoff` cases pass. Nothing pre-existing was red, so `tickets/.pre-existing-error.md` was
  not written.
- No lint step exists in this repo (`AGENTS.md`: `yarn format` / `format:check` are known-broken
  against the house tab style and must not be run; `yarn check` is the gate). Typecheck is covered
  by the suite's own compile-on-import loader plus the passing run.

### Checked and clean — no finding

- **The extraction is faithful, symbol by symbol.** `record` / `clear` / `penalty` / `prune` are
  line-for-line the service's `recordBackoff` / `clearBackoff` / `getBackoffPenalty` /
  `pruneBackoffMap`, with `Date.now()` replaced by the injected clock and the three private statics
  replaced by instance fields. The `set`-never-read-modify-write rule, retention measured from the
  last failure rather than the first, and the `< now` vs `>= now` boundary all match the original.
- **`isBackedOff` and `penalty` are exact complements, not merely usually in agreement.**
  `isBackedOff` is `until >= now`; `penalty` returns 0 exactly when `until < now`, and otherwise
  `min(1, factor / maxFactor)` over a retained `factor >= 1`. So `penalty > 0` iff `isBackedOff`,
  by construction — and the spec samples the pair at every instant of a six-step schedule rather
  than trusting the argument.
- **`prune` walking `ExpiringMap.keys()` is safe.** That method returns a fresh array of live keys,
  so deleting during the walk is fine. Expired-but-retained entries are invisible to `prune`, but
  `sweep` is what drops those, so no entry is unreachable by both reapers — and the spec pins that
  orthogonality in both directions rather than asserting only the easy half.
- **Additive-only.** The implement commit `a958f81` touched exactly two source files, both new,
  plus ticket files. `fret-service.ts` mentions the class only in a prose comment (`:986`); there
  is no import, so the class is dead code until the rewire lands. That is the intended shape of
  this ticket, not an oversight.
- **Docs are accurate as they stand, and were left alone deliberately.** `docs/fret.md` describes
  this logic under *Security and abuse considerations* (the bounded bookkeeping maps) and under
  *Stabilization and churn handling*, naming the service-private symbols. `FretService` is
  unchanged, so every one of those sentences is still true today. Naming `ProbeBackoff` there now
  would document intent rather than reality; it belongs with the rewire, and
  `backoff-test-surface-migration` already carries `docs/fret.md` in its `files:`.

### Found, and where each went

- **Two test gaps → appended as an arm on `backoff-test-surface-migration`** (implement stage),
  which already owns `probe-backoff.ts` and that spec's neighbours. Neither is a defect; both are
  behaviours nothing asserts. (1) Two failures inside one still-open window escalate, because
  `record` looks at whether an entry is *retained*, not at whether its window is *open* — faithful
  to the service, since the 500 ms spacing rule guards `contactFailures` and never the backoff
  map, but unpinned. (2) The `clear` case checks `factor` is 0 without recording again, so it does
  not distinguish "forgotten" from "retained at 0". Filed as an arm rather than a fresh ticket per
  the Nth-instance rule — same site, same pass, already-open ticket.
- **`maxFactor: 0` poisons `penalty` with `NaN` → tripwire `NOTE:`** at the `maxFactor` option doc
  in `probe-backoff.ts`. From the second failure `factor` is `min(0 * 2, 0)` = 0 and `penalty` is
  `Math.min(1, 0 / 0)` = `NaN`, which would spread silently through the routing cost sum. Genuinely
  conditional, not a latent defect: the sole production caller passes the static default, no config
  knob reaches the option, so the path cannot run today. The `NOTE:` states the revisit condition
  as "if this ever becomes caller- or config-supplied".

### Weighed against the implementer's four declared gaps

- **The unenforced `retainMs > baseMs * maxFactor` invariant** — already an accepted tradeoff with a
  stated reason at the constructor: specs construct with deliberately tiny windows, so a
  constructor assert would fire in them, and the inequality is pinned as a test over the shipped
  defaults instead, exactly as `test/stabilize-budget-invariants.spec.ts` treats the tick budgets.
  Decision already made at the site; not re-filed.
- **`capacity` normalization inherited from `ExpiringMap`** — not actually undocumented. The field
  doc says so ("Normalized by the backing map"), the constructor reads `capacity` back off the map
  rather than echoing the argument, and the spec asserts the readback. No finding.
- **`sweep()` discarding `ExpiringMap.sweep`'s dropped count** — the service's `pruneBackoffMap`
  discarded it too, so this is not a regression, and no caller wants the number. Widening the
  return type is a one-line change the day a diagnostic needs it. Too small to be a ticket and too
  unconditional to be a tripwire; recorded here and nowhere else.
- **Class-vs-service equivalence argued rather than tested** — the correct fix is the chain that is
  already queued, not a new ticket. `probe-backoff-rewire` deletes the original so the two cannot
  disagree, and `backoff-test-surface-migration` then re-points the eight existing specs at the
  class, which is what actually exercises the extracted code against the service's own scenarios.
  A parallel equivalence test would be obsolete the moment the rewire lands.

### Empty categories, with reasons

- **No `blocked/` ticket.** Nothing here needs a human decision or an out-of-repo dependency.
- **No new `fix/` or `backlog/` ticket.** The only two findings resolved at a site an open ticket
  already claims, and the third was conditional. Climbing the architecture ladder produced nothing
  higher: the `NaN` case is one unreachable option value with no class behind it, and the two test
  gaps are covered by the migration ticket's existing shared-helper approach rather than by a new
  invariant.
- **No source-hygiene finding.** 181 lines, one class, every method 1–6 statements, names carry the
  meaning (`isBackedOff` / `penalty` / `factor` are three distinct reads of one entry and the doc
  comment says why each exists separately). The comment density is high for the file's size, but
  each block records a decision — why retention is not the window, why `set` rather than
  read-modify-write, why `prune` and `sweep` are both needed — rather than restating the code.
