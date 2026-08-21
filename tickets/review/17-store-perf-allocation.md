description: The peer routing table used to rebuild a 64-character text key every time it looked a peer up, and its ring walks kept circling a small ring long after seeing every peer. Both are fixed; this is the review pass over that work.
files: packages/fret/src/store/digitree-store.ts, packages/fret/test/digitree.neighbors.spec.ts, packages/fret/test/digitree.invariants.spec.ts, docs/fret.md
difficulty: medium
----

Two independent allocation problems in `DigitreeStore`, landed together. Both change **cost, not
results** — that claim is the thing to attack hardest in review.

## What landed

**Arm A — tree keys cached per entry object.** A module-level `WeakMap<PeerEntry, string>` in
`src/store/digitree-store.ts`, consulted and populated *inside* `makeKey` itself, so `put`'s own
`makeKey(entry)` call primes it before the entry reaches the tree and there is no separate priming
step to forget. Keyed on object identity, not peer id — that is the load-bearing decision (see the
doc comment at the cache for why a field on `PeerEntry` would be silently stale across the spread
every write path performs).

**Arm B — walks exit on a lap.** `neighborsRight` / `neighborsLeft` collect into a `Set<string>`
and `break` on the first id already present. The `maxScan` bounded-scan guard is unchanged and
still present. Loop bodies deliberately left in one shape with guards adjacent, with a `NOTE:`
saying the logic belongs in `plan/cleanup-store-ring`'s shared directional walker rather than being
copied per call site when that lands.

**Docs.** Two bullets added to the *Routing store (Digitree) & indices (A2)* section of
`docs/fret.md`, covering both arms and both soundness conditions.

## Measured after the change

Same rig as the source ticket: 2048 entries, random 32-byte coordinates, Node 22 on Windows,
`process.hrtime`, warm-up run discarded. Bench file was temporary and is deleted.

| | at HEAD (from the source ticket) | now |
|---|---|---|
| 20 000 `getById` (one `find` each) | 39.0 ms | **4.4 ms** |
| 2000 × `neighborsRight(coord, 4)` on a 4-entry ring | 3.5 ms | 1.8 ms |
| 2000 × `neighborsRight(coord, 20)` on same | 3.9 ms | 1.7 ms |
| 2000 × `neighborsRight(coord, 200)` on same | 19.9 ms | 2.1 ms |
| 2000 × `neighborsRight(coord, 2000)` on same | 98.9 ms | 1.6 ms |

Arm A came in at 4.4 ms against the source ticket's predicted 6.4 ms — ~8.9× rather than the
predicted 6.1×. Treat the difference as machine variance between two separate runs, not as a
finding; both are the same order and the shape (the rebuild was most of a `find`) is what matters.
Arm B is now **flat across a 500× spread of `count`**, which is the claim: cost is O(ring size),
no longer O(`count`).

## Validation performed

- `npx tsc --noEmit` from `packages/fret/` — clean.
- `yarn build` — clean.
- `yarn test` — **1116 passing, 0 failing** (was 1114 before; 2 new spec blocks added).
  Log at `tickets/.logs/17-store-perf-allocation.test.log`.
- No pre-existing failures encountered.

## Use cases to exercise / attack in review

**The equivalence claim for Arm B.** Sets are insertion-ordered, so `Array.from(set)` should be
byte-for-byte what `Array.from(new Set(out))` produced. Every existing order assertion passes
unchanged (`test/ring-membership.spec.ts`, `test/cohort.properties.spec.ts`,
`test/cohort.assembly.spec.ts`, `test/digitree.persistence.spec.ts`'s "neighbor ordering is
preserved after import"). If you can construct a case where the two differ, that is the finding.

**The two soundness conditions for the early exit**, both recorded in a `NOTE:` at the walk site:

- *One tree entry per peer id* is what makes a repeat mean "lapped". Before that invariant landed
  (`store-index-tree-invariant`), a duplicated id mid-walk with no wrap would make this exit
  silently truncate. Worth checking nothing can reintroduce a duplicate id.
- *Filter purity* — with a filter, a skipped entry is never added, so the exit fires only on a
  matching entry; the argument that it still fires within one lap depends on the first matching
  entry re-matching. Every caller today passes `isLiveMember` or a plain field comparison. A
  future stateful/time-dependent filter breaks this.

**The `maxScan` guard is not redundant and must not be "cleaned up".** It is the guard for the
*filtered zero-match* walk, where nothing is ever collected so no repeat is ever seen. The early
exit is the guard for the unfiltered lap. `test/digitree.neighbors.spec.ts` pins the zero-match
case with an exact call count (8 filter calls on an 8-entry ring at `count: 1_000_000`).

**The cache-staleness invariant for Arm A.** The cache rests on: an entry's `id`/`coord` are never
mutated in place while it sits in the tree. This was **already load-bearing at HEAD** — `digitree`
re-derives keys on demand, so in-place mutation already scrambled tree order without the cache. I
grepped `src/` and `test/` for in-place writes to a live entry's `coord` or `id` and found **none**
(every write path replaces the entry object). Re-run that grep as part of review; if a future write
path starts mutating, `test/digitree.invariants.spec.ts` now fails on it (see below).

## New tests

`test/digitree.neighbors.spec.ts` — two new describe blocks:

- *ring walks exit on a lap*: `count` ≫ `size()` returns exactly `size()` ids in ring order for
  both directions; a pass-all counting filter visits each entry at most once; `count` exactly
  `size()`; single-entry ring; empty store at `count: 1_000_000`; `count` 0 and negative;
  zero-match filter terminating in exactly one lap (exact call count); sparse skip-scan unchanged.
- *tree-key cache*: re-key via `update(id, { coord })` moves the entry in ring order and leaves the
  id index consistent (plus the orphan tell — `remove` must actually remove it); same-id re-insert
  at an identical coordinate; two entries sharing a coordinate with different ids both reachable
  and distinctly keyed; `importEntries` relocating an already-held id.

`test/digitree.invariants.spec.ts` — the model-based property test now also asserts **tree order
agrees with the coordinates the entries carry** (`hex(coord)|id` ascending across `list()`). That
is the assertion a stale cached key fails, and no structural check above it catches that: a stale
key leaves the entry at its old ring position while `getById` still resolves it. This is the piece
that retires the bug class rather than the one instance.

## Known gaps — flagged honestly

- **The Arm B timing test is a wall-clock bound**, not a deterministic visit count:
  `neighborsRight(ZERO, 1_000_000)` on a 4-entry ring must return 4 ids in under 500 ms
  (10 s mocha timeout). It is the only probe available for the *unfiltered* path — supplying a
  counting filter changes which guard is under test, since a filter sets `maxScan` to `size()` and
  bounds the lap on its own. The gap it discriminates is ~5 orders of magnitude, so it should not
  be flaky, but it is a timing assertion on shared CI and a reviewer may reasonably want it
  replaced with an injectable visit counter or dropped. I did not add a test seam to the store just
  for this.
- **Arm A's speedup was measured against the source ticket's HEAD numbers, not re-measured at HEAD
  in this run.** The cache is module-level and unconditional, so measuring both sides would have
  meant reverting. The "now" column is freshly measured; the "at HEAD" column is carried over from
  the source ticket's run on the same machine.
- **`successorOfCoord` / `predecessorOfCoord` were not touched.** They return the first match, so
  they never lapped and Arm B does not apply. They do benefit from Arm A.
- **The filtered sparse-match worst case is unchanged and was not re-measured** (~39 µs per walk on
  a 2048-entry ring with zero matches, per the source ticket). The existing `NOTE:` about a
  member-only secondary index is left in place; this ticket neither improves nor regresses it.
- **The `cleanup-store-ring` interaction is a comment, not an enforcement.** Nothing stops that
  later ticket from copying the set/exit logic per call site instead of absorbing it into the
  shared walker.
