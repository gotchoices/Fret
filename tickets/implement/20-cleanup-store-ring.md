description: Finish a batch of mechanical cleanups in the store and ring code — remove duplication and dead code in the peer routing table.
files: packages/fret/src/store/digitree-store.ts, packages/fret/src/store/relevance.ts
difficulty: easy
prereq:
----
<!-- resume-note -->
Prior run hit its token budget partway through. No log file — see this note and the diff
already on disk for what's done.

## Already done (relevance.ts) — do not redo

1. Inlined `withCounters` — deleted the function, all 3 call sites (`touch`, `recordSuccess`,
   `recordFailure`) now spread inline: `{ ...entry, lastAccess: now, relevance, ... }`.
2. Fixed `touch`'s access-count basis: `baseRelevance` now called with
   `{ ...entry, accessCount: entry.accessCount + 1 }`, matching `recordSuccess`/`recordFailure`'s
   pattern of computing base relevance off the post-increment entry.
3. Removed the dead `Math.max(1, halfLifeMs)` clamp — `lambda = Math.log(2) / halfLifeMs`.

Verify these three landed cleanly (read `packages/fret/src/store/relevance.ts` top to bottom —
it's short) before continuing; don't re-verify by diffing, just confirm the file reads sensibly.

## Remaining work

### Item 4 — extract shared directional ring walker (digitree-store.ts:385-548, NOTE block at ~456-460)

Not started. Full spec (unchanged from original plan, repeated here since it's the substantial
remaining piece):

`digitree-store.ts` carries a NOTE block (~456-460, search for `plan/cleanup-store-ring`) already
describing this extraction — read it in full before starting; it names the two soundness
conditions (one-entry-per-id makes a repeat mean "lapped"; a supplied filter must be pure) that
the new walker must preserve. Five methods today all seek via `ceilPath`/`floorPath` then walk
`next`/`prior` with a `maxScan` bounded-scan guard when a filter is given:

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
incidental to the loop shape. Delete the extraction NOTE block once done (it describes work now
done, not a remaining concern).

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

### Item 5 — verify-then-noop items (grep-confirm, don't redo work if still true)

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

- Confirm the 3 already-done relevance.ts fixes (see above) are intact
- Extract the shared directional ring walker and rewrite the 5 `digitree-store.ts` consumers to
  use it (item 4)
- Delete the extraction NOTE block at digitree-store.ts (~456-460) once the walker lands
- Grep-confirm the 4 "already fixed" items are still true; no-op if so, flag in handoff if not
  (item 5)
- Run `cd packages/fret && npx tsc --noEmit` — **not yet run this pass**, do this before anything
  else to catch fallout from the relevance.ts edits already made
- Run `cd packages/fret && yarn test` — pay particular attention to
  `test/digitree.invariants.spec.ts`, `test/digitree.neighbors.spec.ts`,
  `test/relevance.eviction.spec.ts` (all three are the regression backstop named in the original
  plan; none has been run against these changes yet)

Expected behavior: identical behavior with less duplication and no dead or misleading code; the
relevance touch path uses the same access-count basis as the other record paths (done); the ring
walker duplication across 5 methods is gone (not done).

References: review store section, cleanup finding "Mechanical cleanups" (digitree-store.ts:208-294)
and minor finding on relevance (relevance.ts:103-113). Prior ticket `20-cleanup-store-ring` (this
ticket replaces it after a budget-warning interruption).
