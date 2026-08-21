description: A speed-up to the peer routing table shipped, was reviewed, and passed the full build and test gate. Two small cost measurements in comments were corrected, and one performance test that turned out not to actually test anything was replaced with one that does.
files: packages/fret/src/store/digitree-store.ts, packages/fret/test/digitree.neighbors.spec.ts, packages/fret/test/digitree.invariants.spec.ts, docs/fret.md
----

Review of implement commit `94cd6e7`. The implementation shipped two independent optimizations to
`DigitreeStore`, the ordered index that holds FRET's routing table.

## What landed

**Arm A — tree keys cached per entry object.** A module-level `WeakMap<PeerEntry, string>` in
`src/store/digitree-store.ts`, consulted and populated inside `makeKey` itself. Keyed on object
identity, not peer id: every write path spreads the old entry into a new object, so a re-key is a
cache miss by construction and a stale key is unrepresentable.

**Arm B — walks exit on a lap.** `neighborsRight` / `neighborsLeft` collect into a `Set<string>`
and `break` on the first id already present. The `maxScan` bounded-scan guard is unchanged.

**Docs.** Two bullets in the *Routing store (Digitree) & indices (A2)* section of `docs/fret.md`.

## Review findings

### Gate — passed

From `packages/fret/`: `npx tsc --noEmit` clean, `yarn build` clean, `yarn test` **1116 passing, 0
failing** (~4 min). There is no lint step; per `AGENTS.md`, `yarn check` is the gate and
`yarn format` must not be run. No pre-existing failures surfaced, so nothing was written to
`tickets/.pre-existing-error.md`.

### Arm A (tree-key cache) — checked, no defect

- **Staleness.** No in-place write to a live entry's `coord` or `id` anywhere in `src/` or `test/`.
  `upsert` (`{...prev, coord, lastAccess}`), `update` (`{...cur, ...patch}`) and `importEntries`
  (fresh literal) all construct a new object, so a re-keyed entry misses the cache by identity, as
  designed.
- `put` calls `assertCoordWidth` **before** `makeKey`, so a wrong-width coordinate throws and never
  reaches the cache. Ordering worth preserving if `put` is ever reordered.
- `walkFrom` mints its cursor with `makeKey(e)` per emitted entry — an unremarked extra win.
- The module-level `WeakMap` is shared across `DigitreeStore` instances. Harmless: the key an entry
  object produces does not depend on which store holds it, and no path hands one store's entry
  objects to another (`importEntries` builds new objects from `SerializedPeerEntry`).

### Arm B (lap exit) — checked, equivalence holds

- `count <= size()`: the walk collects `count` distinct ids before it can lap — same as before.
  `count > size()`: old code circled, re-pushing duplicates until `count` pushes, then deduped to
  the same `size()` ids in the same ring order; new code stops at the first repeat with the same
  set, and `Set` insertion order preserves the sequence. Byte-for-byte identical.
- Degenerate `count` (`0`, negative, `NaN`) all fail `out.size < count` on the first test and
  return `[]`, as before.
- **Filter purity holds across every caller today.** All call sites surveyed:
  `src/estimate/size-estimator.ts:82-83`, `src/service/cohort.ts:39-40`, and
  `src/service/fret-service.ts` lines 1421, 1495, 1534, 1561, 1588, 1748, 2524, 2526. Every filtered
  call passes `isLiveMember`; the rest pass no filter. All pure.
- **`successorOfCoord` / `predecessorOfCoord` unaffected**: each returns on the first match and
  cannot lap, so Arm B does not apply. Both do benefit from Arm A.
- **Soundness condition 1 (no duplicate tree id) confirmed independently.** `DigitreeStore.put` is
  the sole writer of `byKey.upsert` and deletes the entry under the prior key before placing the new
  one; `remove` is the only other tree mutator and clears both structures. Distinct ids cannot
  collide on a key, since the key is `hex(coord)|id`. The model-based property test in
  `test/digitree.invariants.spec.ts` asserts no duplicate tree entry after every op *and* that a
  full-ring walk returns exactly `size()` distinct ids — which is precisely the assertion a
  duplicate would break, since a duplicate ends the walk early.

### Docs — checked, one number corrected

Both new `docs/fret.md` bullets read correctly against the shipped `makeKey` / walk bodies. The one
number that disagreed is fixed below.

### Minor findings — all fixed in this pass

- **The filter-purity note was vacuous as the code stands.** With a filter, `maxScan = size()` and
  `scanned` increments on every entry visited, match or miss, so a walk is cut off at exactly one
  lap and `out.has(e.id)` can never be true — the exit is reachable **only** on the unfiltered path.
  The `NOTE:` above `neighborsRight` now says that plainly, keeps the purity condition (it goes live
  the moment `maxScan` is weakened), and names `maxScan` as what makes the exit unreachable today.
- **Stale measurement in the `keyCache` doc comment.** It said "39.0 ms rebuilding vs 6.4 ms cached";
  6.4 ms was the *predicted* figure from the plan ticket. Corrected to the measured 4.4 ms, which
  `docs/fret.md` and the implement handoff both already carry.
- **A test was filed under the wrong guard.** `test/digitree.neighbors.spec.ts`, "visits each entry
  at most once when a pass-all filter is supplied", sits in the *ring walks exit on a lap* describe
  block but by the point above the exit never fires on a filtered walk — `maxScan` is what bounds it,
  and the test passes unchanged at the pre-Arm-B HEAD. Retitled and given a comment saying so. It is
  a genuine regression test for the filtered walk's bound; kept.
- **The headline cost test did not test anything.** `does work proportional to the ring, not to
  count` asserted that `neighborsRight(ZERO, 1_000_000)` on a 4-entry ring finishes under 500 ms.
  The implementer flagged it as a timing assertion on shared CI and left the keep-or-replace call
  open; measuring settled it instead. Reconstructing the pre-Arm-B walk (array + trailing dedup, no
  exit) in a scratch copy of the store and running that exact call: **46.3 ms**, versus 0.0 ms
  shipped. So the test passed at the pre-exit HEAD and guarded nothing — the old loop costs roughly
  25-45 ns per iteration, and no threshold loose enough to be safe on CI is tight enough to catch a
  million-iteration walk that finishes in 46 ms.
  Replaced with a deterministic step count rather than a tighter clock: the walk advances the ordered
  index once per iteration, so the test wraps `next` on the store's own index and counts calls —
  **1,000,001 pre-Arm-B versus 5 shipped**, asserted at most 8. No production surface was added for
  observability; the test reaches past `private` deliberately and says why at the site.

### Major findings — none

No correctness, resource-cleanup, type-safety or error-handling defect was found in either arm. Both
are behavior-preserving cost changes, and the equivalence arguments above are each checked against
the shipped code rather than taken from the handoff. The diff is 14 lines of one source file plus
one test; there is no size-debt, decomposition or DRY concern at that scale.

### Tripwires — one, already at the site

The `NOTE:` above the walks asking `plan/cleanup-store-ring` to absorb the set/exit logic into the
shared directional walker rather than copy it per call site. Judged: the comment is enough. It sits
adjacent to the loop it describes, so the agent doing that extraction meets it while editing that
exact body; a ticket would restate a constraint that is already where the work happens, and nothing
short of the extraction landing could close it.

No other tripwire was recorded — the two soundness conditions on the lap exit are unconditional
invariants documented at the site, not "fine now, matters if X", and the tree-key cache has no
ceiling or eviction path to outgrow.

### Accepted tradeoffs encountered — none

No `NOTE:` at any site touched by this diff records a previously-declined finding.
