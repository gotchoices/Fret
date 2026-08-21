----
description: The peer routing table rebuilds a throwaway 64-character text key every time it looks a peer up, and its ring walks keep circling a small ring long after they have seen every peer. Both waste measurable work on paths that run constantly.
files: packages/fret/src/store/digitree-store.ts, packages/fret/src/ring/hash.ts, packages/fret/test/digitree.invariants.spec.ts, packages/fret/test/cohort.properties.spec.ts
difficulty: medium
----

Two independent allocation problems in `DigitreeStore`, both at the same file, resolved
together because they are the same class of waste on the same hot object.

## Measured, at the current HEAD

Benchmark: 2048 entries with random 32-byte coordinates, Node 22 on Windows, `process.hrtime`,
warm-up run discarded. The bench file was temporary and has been deleted; the arithmetic below is
reproducible from the numbers stated.

**Arm A — tree key rebuild.** `digitree`'s `BTree.indexOfEntry` calls the key-extractor function
once per binary-search probe inside a leaf node (`node_modules/digitree/dist/b-tree.js:285`).
Measured **5 extractor calls per `find`**, 6 per `ceilPath`/`floorPath`-style seek. Every one of
those calls runs `coordToHex` (a 32-iteration loop building a 64-character string) plus a
concatenation with the peer id.

| 20 000 `find` calls | wall time |
|---|---|
| key rebuilt per probe (today) | 39.0 ms |
| key cached per entry in a `WeakMap` | 6.4 ms |

**6.1× faster; the rebuild is ~83% of a `find`.** This settles the tending note on the source
plan ticket, which suspected the `coordToHex` lookup-table change had already taken most of this
win. It had not — it made each string cheaper, but building 5 of them per lookup is still where
the time goes.

`find` is not a rare call: `getById`, `remove`, `update`, `put`, and the seek that starts every
single ring walk each perform one.

**Arm B — wrap walks that lap.** `neighborsRight` / `neighborsLeft` push ids into an array and
dedup afterwards with `Array.from(new Set(out))`. Unfiltered, `maxScan` is `Infinity` and the
loop condition is `i < count`, so on a ring smaller than `count` the walk **keeps circling**,
pushing the same ids over and over, until it has pushed `count` of them.

| ring of 4 entries, 2000 walks | wall time | ids actually returned |
|---|---|---|
| `neighborsRight(coord, 4)` | 3.5 ms | 4 |
| `neighborsRight(coord, 20)` | 3.9 ms | 4 |
| `neighborsRight(coord, 200)` | 19.9 ms | 4 |
| `neighborsRight(coord, 2000)` | 98.9 ms | 4 |

Cost is O(`count`), not O(ring size). Production `count` values reach ~30 (`assembleCohort` asks
for `wants * 2 + excludeSet.size`; `fret-service.ts:1561` asks for `m * 2` = 16), so on a young or
small ring this is a ~7× lap factor today — bounded, not catastrophic, but pure waste, and the
bound is an accident of today's callers rather than a property of the walk.

## Arm A — cache the tree key per entry

Cache in a **module-level `WeakMap<PeerEntry, string>`**, populated inside `makeKey` itself so
that `put`'s own `makeKey(entry)` call primes it before the entry reaches the tree and there is no
separate priming step to forget.

Why a `WeakMap` and not a field on the entry — this is the decision, not an implementation detail:

- `PeerEntry` is an exported public interface. A key field would appear in every consumer's type.
- Worse, it would be **silently stale**. Every write path builds its new entry by spreading the
  old one (`{ ...prev, coord, lastAccess: now }` in `upsert`, `{ ...cur, ...patch }` in `update`),
  so a coordinate change — a re-key, the exact case the store's write seam exists to handle —
  would carry the previous entry's key across into the new object. A non-enumerable
  symbol-keyed property dodges the spread but costs a `defineProperty` per write and a shape
  transition on the hottest object in the package.
- Keying on **object identity** makes staleness unrepresentable instead: every stored entry object
  is freshly constructed at the `put` seam, so a re-keyed entry is a different object and simply
  misses the cache. Entries are dropped from the cache by the garbage collector when the store
  drops them; there is no eviction path to maintain and no ceiling to state.

The cache rests on one invariant, which is **already load-bearing today**: an entry's `id` and
`coord` are never mutated in place while it sits in the tree. `digitree` derives keys from entries
on demand rather than storing them, so in-place mutation already scrambles tree order at HEAD —
the cache is exactly as safe as the status quo, no safer and no less. Say so in a `NOTE:` at the
cache, and pin it with a test (below) so the two do not drift.

## Arm B — collect into a set, exit early on a repeat

Collect walk results directly into a `Set<string>` and **return on the first id that is already
present**. Sets are insertion-ordered, so `Array.from(set)` yields byte-for-byte the ordering
`Array.from(new Set(out))` produces today — this arm changes cost, not results.

A repeat id proves the walk has lapped the ring, because the store guarantees **exactly one tree
entry per peer id** (landed by `store-index-tree-invariant`; see the *Routing store (Digitree) &
indices (A2)* section of `docs/fret.md` and `test/digitree.invariants.spec.ts`). Before that
invariant a duplicated id could appear mid-walk with no wrap having occurred, and this early exit
would silently truncate the walk. **Record that dependency in a one-line `NOTE:` at the walk
site** so the two cannot drift apart.

Second soundness condition, worth naming because it is not obvious: with a filter supplied, a
skipped entry is never added to the set, so the early exit only fires on a matching entry — but if
the walk laps, the *first matching* entry it saw is re-encountered and re-matches, so the exit
still fires within one lap. This assumes the filter is **pure** (same entry, same answer). Every
caller today passes `isLiveMember` or a plain field comparison. State the assumption in the
`NOTE:`.

The existing `maxScan` bounded-scan guard stays. It is the guard for the *filtered zero-match*
case, where nothing is ever added to the set and the early exit therefore never fires; the early
exit is the guard for the unfiltered lap. Neither subsumes the other — deleting either one
reopens a spin.

## Interaction with plan ticket `cleanup-store-ring` (sequence 20)

That ticket extracts the four-to-five near-identical wrap walks into one shared directional
walker. It runs *after* this one. The set-collect-and-early-exit logic added here belongs in that
shared walker when it lands, not copied into each call site — leave the code in a shape that
extracts cleanly (one loop body, guard conditions adjacent), and say so in a comment so the later
extraction absorbs this rather than reinventing it.

## Edge cases & interactions

Arm A:

- **Re-key.** `update(id, { coord })` replaces the entry object; the new object must miss the
  cache and compute a fresh key. Assert the tree walk order reflects the new coordinate after a
  re-key, not the old one.
- **Same id re-inserted with an identical coordinate.** `upsert` still builds a new object, so
  this is a cache miss and one recompute. Correct, and worth a test that the id index and tree
  agree afterwards.
- **`importEntries` on a store that already holds those ids.** Replacement by id, including
  coordinate moves, over entries whose predecessors are cached.
- **Entry object handed out by `getById` / `upsert` and mutated by a caller.** This is the
  invariant above. Grep the service and simulation harness for in-place writes to a returned
  entry's `coord` or `id` and confirm there are none; if one exists it is a **bug at HEAD**, not
  a new one, and belongs in its own ticket rather than being absorbed here.
- **Two entries with the same coordinate, different ids** — legal, keys differ only in the id
  suffix. Cache must not collide (it cannot, being keyed on object identity, but assert it).
- **Empty store, single-entry store** — `find` on an empty tree performs zero extractor calls.

Arm B:

- **`count` exactly equal to `size()`**, unfiltered: must return every id once and must not fire
  the early exit spuriously before the last entry is collected.
- **`count` greater than `size()`**: must return exactly `size()` ids, and must visit each entry
  at most twice (once collecting, once triggering the exit). This is the headline case — assert
  the returned length, and ideally assert visit count via a counting filter.
- **`count` of 0 or negative**: returns empty, no walk.
- **Empty store**: returns empty without spinning.
- **Single-entry ring**: `neighborsRight(coord, 5)` returns that one id, once.
- **Filtered walk where nothing matches**: must still terminate on the `maxScan` guard, in
  exactly one lap. This is the case the early exit *cannot* catch — regression-test it explicitly,
  since it is the one a careless refactor of this loop deletes.
- **Filtered walk where matches are sparse** (e.g. mostly-`foreign` ring): unchanged skip-scan
  behavior, still bounded by `maxScan`. Measured worst case at HEAD is ~39 µs per walk on a
  2048-entry ring with zero matches; this ticket does not improve it and must not regress it.
  That is the existing `NOTE:` about a member-only secondary index — leave it in place.
- **Ordering.** Every existing assertion on walk *order* must pass unchanged
  (`test/digitree.neighbors.spec.ts`, `test/ring-membership.spec.ts:217-236`,
  `test/cohort.properties.spec.ts`). Ordering equivalence is the whole safety argument for this
  arm.
- **`protectedIdsAround`** consumes both walks into a set already; confirm the protection-set size
  arithmetic in `docs/fret.md` (`2·max(2, m) − 1`) is unaffected.

## TODO

- Add a module-level `WeakMap<PeerEntry, string>` key cache consulted and populated inside
  `makeKey`. Add the `NOTE:` recording the never-mutate-in-place invariant it shares with the
  tree itself.
- Grep `src/` and `test/` for in-place mutation of a live entry's `coord` or `id`; confirm none.
  If one exists, do not fix it here — report it in the review handoff.
- Rewrite `neighborsRight` / `neighborsLeft` to collect into a `Set<string>` and return on the
  first repeat. Keep the `maxScan` guard. Add the `NOTE:` recording the one-entry-per-id
  dependency and the filter-purity assumption.
- Leave the loop shaped for the `cleanup-store-ring` extraction, with a comment saying so.
- Tests — new, in `test/digitree.neighbors.spec.ts` or a sibling:
  - `neighborsRight(coord, count)` with `count` ≫ `size()` returns exactly `size()` ids and
    visits each entry at most twice (count visits with a counting filter).
  - `count` exactly `size()` returns every id, in the same order as at HEAD.
  - Single-entry ring, empty store, `count` 0.
  - Filtered walk matching nothing terminates in one lap (guard the `maxScan` path explicitly).
  - Re-key via `update(id, { coord })` moves the entry in ring order and leaves the id index
    consistent — the cache-staleness regression test.
  - Two entries sharing a coordinate with different ids are both reachable and distinctly keyed.
- Extend the model-based property test in `test/digitree.invariants.spec.ts` so arbitrary write
  sequences still hold the tree/id-index/count invariants with the cache in play. The existing
  property already recounts after every op; it should need only the re-key case exercised harder.
- Run `npx tsc --noEmit` and `yarn test` from `packages/fret/`.
- Optional but cheap, and it is what makes the review honest: re-run the two measurements above
  after the change and put the resulting numbers in the review handoff.
