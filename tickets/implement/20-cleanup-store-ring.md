description: Finish a batch of mechanical cleanups in the store and ring code — remove duplication and dead code in the peer routing table.
files: packages/fret/src/store/digitree-store.ts, packages/fret/src/store/relevance.ts
difficulty: easy
prereq:
----
<!-- resume-note -->
Second interruption on this ticket — prior run hit budget partway through item 4 (relevance.ts
work); this run hit budget again while still reading/designing item 4, before writing any code.
No log file either time — see this note for state.

## Already done (relevance.ts) — verified intact this pass, do not redo

Read `packages/fret/src/store/relevance.ts` top to bottom this pass and confirmed all three land
cleanly:

1. `withCounters` inlined — deleted, all 3 call sites (`touch`, `recordSuccess`, `recordFailure`)
   spread inline: `{ ...entry, lastAccess: now, relevance, ... }`.
2. `touch`'s access-count basis fixed: `baseRelevance` called with
   `{ ...entry, accessCount: entry.accessCount + 1 }`, matching `recordSuccess`/`recordFailure`.
3. Dead `Math.max(1, halfLifeMs)` clamp removed — `lambda = Math.log(2) / halfLifeMs`.

No further verification needed on relevance.ts — just trust this and move on.

## Remaining work — item 4: extract shared directional ring walker

Not started (no edits made to digitree-store.ts across either interrupted run). Full spec:

`digitree-store.ts` carries a NOTE block at ~456-460 (search `plan/cleanup-store-ring`) describing
this extraction — read it in full before starting; it names the two soundness conditions
(one-entry-per-id makes a repeat mean "lapped"; a supplied filter must be pure) the new walker
must preserve. Five methods today all seek via `ceilPath`/`floorPath` then walk `next`/`prior`
with a `maxScan` bounded-scan guard when a filter is given:

- `successorOfCoord` / `predecessorOfCoord` (~385-423): find first match, single result.
- `neighborsRight` / `neighborsLeft` (~462-506): collect into a `Set` up to `count`, with
  early-exit-on-repeat-id.
- `walkFrom` (~524-548): paged/resumable, returns `PeerEntry[]` (not ids) plus a resume cursor,
  starts strictly after a given cursor rather than at the seek point.

Build one private generator/iterator over one direction (`next` or `prior`) from a start path,
wrapping past the end, bounded at `size()` entries when filtered (unbounded when not — preserves
today's byte-for-byte behavior on the unfiltered path), yielding matching entries in order. Each
of the 5 public methods becomes a thin consumer:
- `successorOfCoord`/`predecessorOfCoord`: take first yielded entry.
- `neighborsRight`/`neighborsLeft`: collect ids into a `Set` until `count` or a repeat id is seen
  (repeat check stays in the consumer, since only these two need it).
- `walkFrom`: take entries until `count`, tracking the resume cursor per entry (its "strictly
  after start" semantics come from what start path it hands the generator, not from generator
  logic).

Keep the `neighborsRight`/`neighborsLeft` early-exit-on-repeat behavior and the `walkFrom`
strictly-after/paging behavior exactly as documented in their existing docblocks — behavior, not
incidental to the loop shape. Delete the extraction NOTE block once done.

**Typing note for next agent** (found this pass, not yet used): the digitree `Path` type lives in
`packages/fret/node_modules/digitree/dist/path.d.ts` and `.../dist/b-tree.d.ts` — check those
first for the exported path type before hand-rolling a generator signature; `BTree.first()` /
`.last()` / `.next(p)` / `.prior(p)` / `.find(k)` all return that same shape. A sketch considered
but not yet written or validated against the real types:

```ts
private *walkRing(
  start: Path, // from digitree, see above
  direction: 'next' | 'prior',
  filter?: (e: PeerEntry) => boolean
): Generator<PeerEntry, void, undefined> {
  const step = direction === 'next' ? (p: Path) => this.byKey.next(p) : (p: Path) => this.byKey.prior(p);
  const wrapTo = direction === 'next' ? () => this.byKey.first() : () => this.byKey.last();
  const maxScan = filter ? this.size() : Number.POSITIVE_INFINITY;
  let p = start.on ? start : wrapTo();
  let scanned = 0;
  while (scanned < maxScan) {
    if (!p.on) { p = wrapTo(); if (!p.on) return; }
    const e = this.byKey.at(p)!;
    scanned++;
    if (!filter || filter(e)) yield e;
    p = step(p);
  }
}
```
This reproduces `successorOfCoord`'s existing unfiltered short-circuit for free (first yield with
`maxScan = Infinity` on a non-empty ring is the same as the current "return p.on ? at(p) :
undefined"), but has NOT been checked against `walkFrom`'s distinct start-position rule (strictly
after cursor, not at the seek point) — `walkFrom` seeks its own start path before calling in
(`cursor ? next(find(cursor.key)) : first()`), so the generator itself doesn't need to know about
cursors; confirm that composition works before committing to this shape. Treat the sketch as a
starting point, not a settled design — verify it compiles and passes tests, don't just transcribe it.

**Edge cases to preserve (see original ticket history / docs/fret.md for full detail):**
- Empty store: `successorOfCoord`/`predecessorOfCoord` → `undefined`, `neighborsRight`/`neighborsLeft`
  → `[]`, `walkFrom` → `{ entries: [], next: cursor }`.
- Single-entry ring: `neighborsRight`/`neighborsLeft` with `count > 1` must terminate via the
  repeat-id exit (this is the exact regression the original early-exit fix targeted — a 4-entry
  ring measurement is cited in the class's existing docblock). `walkFrom` on a one-peer ring must
  re-yield that peer on every page.
- Filtered walk with zero matches: all five methods must terminate via the `maxScan` guard, not
  spin on wrap-around.
- Don't make the early-exit-on-repeat logic depend on filter purity in any new way; every caller
  passes a pure filter today (`isLiveMember` or a plain field comparison).
- `walkFrom` cursor pointing at a since-evicted entry: `byKey.next(byKey.find(cursor.key))` must
  still land on the right ring position even if that key is gone (the "crack" case) — confirm
  through the extracted walker.

## Remaining work — item 5: verify-then-noop items (grep-confirm, don't redo work if still true)

Not started. Original plan asserted these are already fixed elsewhere in the codebase; re-run the
greps below before touching anything — if they still show what's described, these are no-ops:

- coord-to-hex duplication: confirm `digitree-store.ts` is still the only user of `coordToHex`
  from `../ring/hash.js` (`grep -rn coordToHex packages/fret/src`).
- lexicographic-less padding: confirm `ring/distance.ts` `lexLess` is still the only such
  comparator (`grep -rn lexLess packages/fret/src`).
- metadata `Record<string, any>`: confirm zero `Record<string, any>` / bare `: any` matches in
  `packages/fret/src` (`grep -rn "Record<string, any>\|: any" packages/fret/src`).
- mirrored-index xor loop: confirm nothing matches a descending/mirrored-index xor pattern outside
  `lexLess` itself.

If any grep turns up more than the original ticket described, flag it in the review handoff
rather than expanding scope here.

Out of scope (unchanged): the dead ring-distance exports (`clockwiseDistance` / `minDistance`
unused-export cleanup) belong to the separate `consolidate-ring-distance` ticket.

## TODO

- Extract the shared directional ring walker and rewrite the 5 `digitree-store.ts` consumers to
  use it (item 4) — check the digitree `Path` type first, see typing note above
- Delete the extraction NOTE block at digitree-store.ts (~456-460) once the walker lands
- Grep-confirm the 4 "already fixed" items are still true; no-op if so, flag in handoff if not
  (item 5)
- Run `cd packages/fret && npx tsc --noEmit` — still not run across either interrupted pass; do
  this before anything else to catch fallout from the relevance.ts edits (already landed and
  content-verified, but never type-checked)
- Run `cd packages/fret && yarn test` — pay particular attention to
  `test/digitree.invariants.spec.ts`, `test/digitree.neighbors.spec.ts`,
  `test/relevance.eviction.spec.ts` (all three are the regression backstop named in the original
  plan; none has been run against these changes yet)

Expected behavior: identical behavior with less duplication and no dead or misleading code; the
relevance touch path uses the same access-count basis as the other record paths (done); the ring
walker duplication across 5 methods is gone (not done).

References: review store section, cleanup finding "Mechanical cleanups" (digitree-store.ts:208-294)
and minor finding on relevance (relevance.ts:103-113). Prior tickets `20-cleanup-store-ring`
(this ticket replaces it after two budget-warning interruptions in a row — if a third happens,
consider whether item 4 needs to be split into its own ticket rather than re-attempted whole).
