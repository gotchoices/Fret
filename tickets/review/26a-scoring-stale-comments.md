description: Two code comments and one design-doc section that described the old "scoring creates a peer on a miss" rule now state the new "scoring never creates" rule.
files: packages/fret/test/rpc.snapshot-merge-cap.spec.ts, docs/fret.md
difficulty: easy
----

Mechanical comment/doc-only ticket, split off `26-scoring-never-creates-tests` (parent) to land
without touching test logic or rig behavior. The underlying source change (`applyTouch` /
`applySuccess` / `applyFailure` / `applyContactFailure` opening with an early return on a miss,
dropped `coord` param) already landed in `packages/fret/src/service/fret-service.ts` in prior
work on the parent ticket — not re-verified here, and not in scope for this ticket's review either
(covered by the sibling `26b-scoring-never-creates-tests` full-suite validation).

## What changed

**`packages/fret/test/rpc.snapshot-merge-cap.spec.ts`** — the doc comment above `countUpserts`
(~line 134) had its middle paragraph rewritten. Old claim: "`applyTouch` opens with
`getById(id) ?? upsert(id, coord)`" (no longer true — it now returns early on a miss). New text
explains upserts still don't double-count, but for the real current reason: every id in a merged
snapshot reaches the store through `noteDiscovered` (which itself no-ops on an id already held),
not through `applyTouch`. The `NOTE:` paragraph after it (about stacked counter wrappers) was left
untouched, as instructed. No code/assertions/counted numbers changed — text-only.

**`docs/fret.md`** — added one new paragraph in `### Relevance scoring and table management`,
directly after the "Frequency counts proven contact, not hearsay." paragraph (before its existing
sub-bullets): states that `applyTouch`/`applySuccess`/`applyFailure`/`applyContactFailure` never
create an entry — scoring a peer not already in the table is a silent no-op — and that creation
belongs to `noteDiscovered` and the explicit insert sites (`peer:connect`, bootstrap seeding,
`importTable`).

## Validation done

- `cd packages/fret && npx tsc --noEmit` — clean, no errors (confirms the comment-only test-file
  edit didn't break parsing/types).
- Diffed both edits against the ticket's verbatim old/new text — exact match, tabs preserved,
  matching surrounding indent (`^I^I *` in the spec file).
- Did **not** run the spec file or the full suite — ticket explicitly says not needed (comment-only
  change to an already-passing spec; sibling ticket `26b-scoring-never-creates-tests` covers full
  validation once all edits land).

## What the reviewer should check

- Read the two diffs directly — this is prose, so "correct" here means faithful to the actual
  current source behavior (`applyTouch` etc. early-return on miss; `noteDiscovered` early-returns
  on an id already held) rather than anything mechanically testable. Cross-check against
  `packages/fret/src/service/fret-service.ts` if in doubt.
- No test assertions, counted numbers, or code paths were touched by this ticket — if the reviewer
  wants that verified, it's the sibling ticket's job, not this one's.
