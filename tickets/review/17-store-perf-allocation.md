description: The peer routing table used to rebuild a 64-character text key every time it looked a peer up, and its ring walks kept circling a small ring long after seeing every peer. Both are fixed; this is the review pass over that work.
files: packages/fret/src/store/digitree-store.ts, packages/fret/test/digitree.neighbors.spec.ts, packages/fret/test/digitree.invariants.spec.ts, docs/fret.md
difficulty: medium
----

Two independent allocation problems in `DigitreeStore`, landed together (implement commit
`94cd6e7`). Both change **cost, not results** — that claim is the thing to attack hardest.

## What landed

**Arm A — tree keys cached per entry object.** A module-level `WeakMap<PeerEntry, string>` in
`src/store/digitree-store.ts`, consulted and populated *inside* `makeKey` itself, so `put`'s own
`makeKey(entry)` call primes it before the entry reaches the tree. Keyed on object identity, not
peer id: every write path spreads the old entry into a new object, so a re-key is a cache miss by
construction and a stale key is unrepresentable.

**Arm B — walks exit on a lap.** `neighborsRight` / `neighborsLeft` collect into a `Set<string>`
and `break` on the first id already present. The `maxScan` bounded-scan guard is unchanged.

**Docs.** Two bullets in the *Routing store (Digitree) & indices (A2)* section of `docs/fret.md`.

Measured numbers, new tests, and the implementer's own honest gap list are in the implement
commit message and in the two doc bullets — not restated here.

<!-- resume-note -->
## Review progress (two runs, both cut short by budget — resume here)

**No code has been changed by either review run.** The working tree is exactly the implement
commit's. Everything under *Open findings* below is still unfixed.

### Checked and settled

**Arm A (tree-key cache) — sound, no defect.**

- Staleness grep re-run: no in-place write to a live entry's `coord` or `id` anywhere in `src/`
  or `test/`. `upsert` (`{...prev, coord, lastAccess}`), `update` (`{...cur, ...patch}`) and
  `importEntries` (fresh literal) all construct a new object, so a re-keyed entry misses the
  cache by identity, as designed.
- `put` calls `assertCoordWidth` **before** `makeKey`, so a wrong-width coordinate throws and
  never reaches the cache. Ordering worth preserving if `put` is ever reordered.
- `walkFrom` mints its cursor with `makeKey(e)` per emitted entry — an unremarked extra win.
- The module-level `WeakMap` is shared across `DigitreeStore` instances. Harmless: the key an
  entry object produces does not depend on which store holds it, and no path hands one store's
  entry objects to another (`importEntries` builds new objects from `SerializedPeerEntry`).

**Arm B (lap exit) — equivalence holds.**

- `count <= size()`: the walk collects `count` distinct ids before it can lap — same as before.
  `count > size()`: old code circled, re-pushing duplicates until `count` pushes, then deduped to
  the same `size()` ids in the same ring order; new code stops at the first repeat with the same
  set, and `Set` insertion order preserves the sequence. Byte-for-byte identical.
- Degenerate `count` (`0`, negative, `NaN`) all fail `out.size < count` on the first test and
  return `[]`, as before.
- **Filter purity holds across every caller today.** Surveyed all call sites:
  `src/estimate/size-estimator.ts:82-83`, `src/service/cohort.ts:39-40`, and
  `src/service/fret-service.ts` lines 1421, 1495, 1534, 1561, 1588, 1748, 2524, 2526. Every
  filtered call passes `isLiveMember`; the rest pass no filter. All pure.
- **`successorOfCoord` / `predecessorOfCoord` confirmed unaffected** by reading them
  (`digitree-store.ts` ~583-620): each returns on the first match and cannot lap, so Arm B does
  not apply. Both do benefit from Arm A.

**`docs/fret.md` verified against the code.** Both new bullets read correctly against the shipped
`makeKey` / walk bodies. One number disagrees — see finding 2.

### Open findings — all minor, all to be fixed in this pass

1. **Filter-purity note is vacuous as the code stands** (`digitree-store.ts`, the `NOTE:` block
   above `neighborsRight`, condition (2)). With a filter, `maxScan = this.size()` and `scanned`
   increments on *every* entry visited, match or miss. A forward walk visits `size()` distinct
   tree positions before it can revisit one, and the store holds exactly one entry per id, so
   `out.has(e.id)` can never be true on the filtered path — the exit is reachable **only**
   unfiltered. The comment is defensive rather than wrong, but it presents a live condition where
   there is none, and a future reader weakening `maxScan` would be relying on an exit that has
   never actually run. Fix: keep the purity note (it becomes live the moment `maxScan` changes)
   and say plainly that the exit is today reachable only on the unfiltered path, and that
   `maxScan` is what makes it so.

2. **Stale measurement in the source doc comment.** The `keyCache` doc comment says
   "39.0 ms rebuilding vs 6.4 ms cached"; 6.4 ms was the *predicted* figure from the plan ticket.
   The measured value is 4.4 ms, which is what `docs/fret.md` and the implement handoff both
   carry. One-number fix so the two do not disagree.

3. **A test is filed under the wrong guard.** `test/digitree.neighbors.spec.ts`, "visits each
   entry at most once when a pass-all filter is supplied", sits inside the *ring walks exit on a
   lap* describe block, but by finding 1 the exit never fires on a filtered walk — what bounds it
   is `maxScan`. The test passes unchanged at the pre-Arm-B HEAD, so it guards the bounded-scan
   guard, not the lap exit. Fix: one clarifying comment (or a rename) so a reader does not take
   it as coverage of the exit. It is a genuine regression test; do not delete it.

### Still to do

- **Apply findings 1–3** (three small comment/text edits, all in-pass minor).
- **Run the gate**: `npx tsc --noEmit`, `yarn build`, `yarn test` from `packages/fret/`. Neither
  review run has run it, so the gate is unmet. Note there is no lint step — per `AGENTS.md`,
  `yarn check` is the gate and `yarn format` must **not** be run.
- **Decide the wall-clock-test question.** The implementer flagged it himself: the lap test
  asserts `neighborsRight(ZERO, 1_000_000)` on a 4-entry ring finishes under 500 ms. It is the
  only probe available for the *unfiltered* path (a counting filter changes which guard is under
  test, per finding 1), and it discriminates ~5 orders of magnitude, so flakiness is unlikely —
  but it is a timing assertion on shared CI. Decide: keep as-is with the reasoning recorded, or
  replace with an injectable visit counter. A reviewer may reasonably want either; this call has
  not been made.
- **Confirm nothing can reintroduce a duplicate tree id** (soundness condition 1). The write seam
  and its property test were read but the claim was not probed independently.
- **The `plan/cleanup-store-ring` interaction is a comment, not an enforcement.** Nothing stops
  that later ticket from copying the set/exit logic per call site instead of absorbing it into the
  shared walker. Decide whether that is worth more than the `NOTE:` already at the site.

### Output when done

A `complete/` ticket with a `## Review findings` section: what was checked, what was found, what
was done. Carry forward the settled sections above verbatim — they are checked work, not
speculation — and state empty categories explicitly with a reason.
