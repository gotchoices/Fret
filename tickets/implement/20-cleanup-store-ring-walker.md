description: Extract the shared ring-walking logic that five near-identical methods in the peer routing table each repeat, so there is one place that logic lives instead of five.
files: packages/fret/src/store/digitree-store.ts
difficulty: medium
prereq:
----
Third attempt at this ticket's item 4. Prior two runs (see git log `cleanup-store-ring`) hit
budget before writing any code — this run hit budget even earlier, before reading the digitree
`Path` type, so still zero edits to `digitree-store.ts`. Splitting this off as its own ticket per
the original ticket's own guidance ("if a third [interruption] happens, consider whether item 4
needs to be split into its own ticket rather than re-attempted whole").

**relevance.ts cleanup (a separate item from the same original ticket) is done and does not
belong to this ticket** — verified intact as of this pass (re-read top to bottom): `withCounters`
inlined at all 3 call sites, `touch`'s access-count basis fixed, dead `Math.max(1, halfLifeMs)`
clamp removed. Nothing to do there. Do not re-verify again — trust this note.

## The work

`digitree-store.ts` carries a NOTE block at ~456-460 (search `plan/cleanup-store-ring`) describing
this extraction — read it in full before starting; it names the two soundness conditions
(one-entry-per-id makes a repeat mean "lapped"; a supplied filter must be pure) the new walker
must preserve. Five methods today all seek via `ceilPath`/`floorPath` (private helpers, ~355-369)
then walk `next`/`prior` with a `maxScan` bounded-scan guard when a filter is given:

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

**Typing note (unverified — check before writing the generator signature):** the digitree `Path`
type is expected to live in `packages/fret/node_modules/digitree/dist/path.d.ts` and
`.../dist/b-tree.d.ts` (confirmed these files exist on disk this pass, but their contents were
never read — do that first). `BTree.first()` / `.last()` / `.next(p)` / `.prior(p)` / `.find(k)`
should all return that same shape — verify against the real `.d.ts` rather than assuming.

A sketch was considered but never written or validated against the real types:

```ts
private *walkRing(
  start: Path, // from digitree — confirm exact type/import path first
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

**Edge cases to preserve (see docs/fret.md for full detail):**
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

Out of scope: the dead ring-distance exports (`clockwiseDistance` / `minDistance`
unused-export cleanup) belong to the separate `consolidate-ring-distance` ticket. The
grep-confirm no-op checks (coord-to-hex duplication, lexLess, `Record<string, any>`, mirrored-index
xor loop) and the type-check/test run belong to the follow-on ticket `cleanup-store-ring-verify`
(prereq on this one) — do not do them here.

## TODO

- Read `packages/fret/node_modules/digitree/dist/path.d.ts` and `.../dist/b-tree.d.ts` to confirm
  the exact `Path` type and method signatures before writing the generator
- Extract the shared directional ring walker and rewrite the 5 `digitree-store.ts` consumers to
  use it
- Delete the extraction NOTE block at digitree-store.ts (~456-460) once the walker lands
- Run `cd packages/fret && npx tsc --noEmit` to confirm the extraction compiles
- Run `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/digitree.invariants.spec.ts" "test/digitree.neighbors.spec.ts" --timeout 30000` to confirm behavior is unchanged before handing off (full suite belongs to the follow-on ticket, but these two are this extraction's direct regression backstop)

Expected behavior: identical behavior with less duplication — the ring walker duplication across
5 methods is gone, no method's documented edge-case behavior (empty store, single-entry ring,
zero-match filtered walk, evicted-cursor resume) changes.

References: review store section, cleanup finding "Mechanical cleanups" (digitree-store.ts:208-294).
Prior tickets `20-cleanup-store-ring` (original, now split — this ticket replaces its item 4 after
three budget-warning interruptions in a row on that one item).
