description: Two code comments and one design-doc section still describe the old "scoring creates a peer on a miss" rule; they need to state the new "scoring never creates" rule instead.
files: packages/fret/test/rpc.snapshot-merge-cap.spec.ts, docs/fret.md
difficulty: easy
----

Split off `26-scoring-never-creates-tests` (parent ticket) to land the pure-mechanical half
first — no test-writing, no rig work, no validation risk. Purely comment/doc text edits.
The source change this refers to already landed in `packages/fret/src/service/fret-service.ts`
(`applyTouch`/`applySuccess`/`applyFailure`/`applyContactFailure` now open with
`const entry = this.store.getById(id); if (!entry) return;` before any `await`, and dropped
their `coord` parameter). Do not re-verify that — it is done and confirmed by tsc + 97 passing
tests across four targeted specs in prior work on the parent ticket.

## Edit 1: `packages/fret/test/rpc.snapshot-merge-cap.spec.ts`

Find the doc comment directly above `function countUpserts` (currently around line 134-149).
It currently reads, verbatim:

```
		/**
		 * Record every id the merge loop upserts, in order.
		 *
		 * `applyTouch` opens with `getById(id) ?? upsert(id, coord)` and the loop has always just
		 * upserted that id, so it does not double-count — a doubled count is the first assumption
		 * to re-check if these numbers ever drift.
		 *
		 * NOTE: this **stacks** wrappers rather than replacing them, and nothing restores. A second
```

Replace only the middle paragraph (the `applyTouch opens with...` one) with:

```
		 * `applyTouch` no longer creates on a miss — it returns early when the id isn't already in
		 * the store (see `docs/fret.md`, *Relevance scoring and table management*). Counted upserts
		 * still don't double-count for a different reason: every id in a merged snapshot (`from`,
		 * and each successor/predecessor/sample id) reaches the store through `noteDiscovered`, not
		 * `applyTouch`, and `noteDiscovered` itself returns early on an id the store already holds —
		 * so a repeated id upserts at most once, via that guard, not via `applyTouch`.
```

Leave the `NOTE:` paragraph and everything else in that doc comment untouched. Do not renumber
or reflow — tabs for indent, matching the surrounding file (see `AGENTS.md`).

The spec's actual assertions and counted numbers do not change — this file's tests already pass
against the landed source (confirmed). This is a comment-only fix.

## Edit 2: `docs/fret.md`

In the `### Relevance scoring and table management` section, find the paragraph beginning
"Frequency counts proven contact, not hearsay." (the one about `accessCount` and
`noteDiscovered`). Immediately after that paragraph (same section, new paragraph), add:

```
The scoring helpers themselves (`applyTouch`, `applySuccess`, `applyFailure`,
`applyContactFailure`) never create an entry — scoring a peer not already in the routing table
is a silent no-op. Creation belongs to `noteDiscovered` and the explicit insert sites
(`peer:connect`, bootstrap seeding, `importTable`); a peer only reaches scoring after one of
those has already placed it.
```

Use `grep -n "Frequency counts proven contact" docs/fret.md` (or equivalent) to find the exact
line rather than assuming a line number — the file is long and other tickets may have touched
nearby text.

## TODO

- Make Edit 1 above.
- Make Edit 2 above.
- Run `cd packages/fret && npx tsc --noEmit` (docs changes don't need it, but the test file edit
  is comment-only and should still type-check — quick sanity check, not a real risk).
- No need to run the full test suite for this ticket alone (comment-only change to an already
  passing spec); the sibling ticket `26b-scoring-never-creates-tests` runs full validation once
  all edits (including its own) have landed.
