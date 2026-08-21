description: Two code comments and one design-doc section that described the old "scoring creates a peer on a miss" rule now state the new "scoring never creates" rule.
files: packages/fret/test/rpc.snapshot-merge-cap.spec.ts, docs/fret.md
difficulty: easy
----

Comment/doc-only change, split off `26-scoring-never-creates-tests`. The underlying source change
(`applyTouch` / `applySuccess` / `applyFailure` / `applyContactFailure` opening with an early
return on a store miss, `coord` parameter dropped) landed earlier in
`packages/fret/src/service/fret-service.ts`.

## What shipped

**`docs/fret.md`**, *Relevance scoring and table management* — a new paragraph after "Frequency
counts proven contact, not hearsay.": the four scoring helpers never create an entry; scoring a
peer not in the routing table is a silent no-op; creation belongs to `noteDiscovered` and the
explicit insert sites. Verified against `fret-service.ts:566-700` — each helper opens with
`const entry = this.store.getById(id); if (!entry) return;`, and `applyContactFailure` inherits
the guard via `applyFailure`. Accurate as written.

**`packages/fret/test/rpc.snapshot-merge-cap.spec.ts`** — the doc comment above `countUpserts`
had its stale middle paragraph replaced. The implement-stage replacement text was itself wrong
about where the counted upserts come from; corrected in this review pass (below).

## Review findings

**Checked:** the implement diff read first, before the handoff; both edited prose passages
cross-checked line-by-line against the current source (`applyTouch` / `applySuccess` /
`applyFailure` / `applyContactFailure` at `fret-service.ts:566-700`, `noteDiscovered` at 604,
and both merge loops — `mergeAnnounceSnapshot` ~1972 and `fetchAndMergeSnapshot` ~2562);
the spec's own assertions re-read to confirm the comment describes what the test actually
counts; `npx tsc --noEmit`; the touched spec run in full.

**Major — none.** Nothing here changes behavior, so there is no class of defect to climb to; the
one finding was a false statement in prose, fixed at its only site.

**Minor — one, fixed in this pass.** The implement-stage comment claimed "every id in a merged
snapshot (`from`, and each successor/predecessor/sample id) reaches the store through
`noteDiscovered`". False for `from` in both directions:
  - Announce path: `mergeAnnounceSnapshot` upserts the sender **directly and unconditionally** —
    `this.store.upsert(from, senderCoord)` — before the list loops, and only *then* calls
    `applyTouch(from)`. That direct upsert is exactly the `1 +` in the spec's
    `1 + successors + predecessors + sample` expectation, so the comment misattributed the very
    count it sits above.
  - Fetch path: `fetchAndMergeSnapshot` never upserts the sender at all — a fact the spec asserts
    outright ("the fetch path never upserts the sender", and its counts are correspondingly one
    lower). The old text implied otherwise.

  Replaced with text naming the real mechanism: `applyTouch` upserts nothing at all now (so it
  cannot double-count, full stop); the announce path's single `from` upsert is direct and
  unconditional; the fetch path has none; and the list ids are what go through `noteDiscovered`,
  whose early return on an already-held id is what keeps a repeated id to at most one upsert.

**Tripwires — none.** Nothing conditional was noticed: this diff carries no code, no allocation,
no growth term, so there is no "fine now, matters if X" to park.

**Considered-and-declined — none encountered.** No accepted-tradeoff `NOTE:` sits at either
edited site. (The `NOTE:` immediately below the corrected paragraph is the stacked-counter-wrapper
one, which is about the helper's own design and was correctly left untouched.)

**Docs.** `docs/fret.md` was the change, and it is the only doc that describes scoring creation
semantics — the `#### Relevance score calculation` subsection nearby talks about `accessCount`
sources and is consistent with the new paragraph, needing no edit. No other file the change
touches, or should have touched, carries a stale statement of the old rule.

**Not in scope, deliberately:** the source change itself (`fret-service.ts`) — validated by prior
work on the parent ticket and covered by the sibling `26b-scoring-never-creates-tests` full-suite
run.

## Validation

- `cd packages/fret && npx tsc --noEmit` — clean.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/rpc.snapshot-merge-cap.spec.ts" --timeout 30000` — **21 passing**, 0 failing, including both
  `applies the same caps on the fetch path, and never upserts the snapshot sender` cases, which
  are the ones the corrected comment describes.
- No lint step exists in this repo (`yarn format` is documented as unusable — no prettier config;
  `yarn check` is the gate). Full suite left to the sibling ticket, per its stated scope.
- No pre-existing failures surfaced.
