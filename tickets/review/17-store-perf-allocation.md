description: A routing-table speed-up already shipped and has been reviewed; the code fixes it needed are applied. What remains is running the build and test suite over it, and making two judgement calls the reviewer deliberately left open.
files: packages/fret/src/store/digitree-store.ts, packages/fret/test/digitree.neighbors.spec.ts, packages/fret/test/digitree.invariants.spec.ts, docs/fret.md
difficulty: easy
----

Continuation of the review pass over implement commit `94cd6e7` (two prior review runs plus this
one were each cut short by the token budget). **The review analysis is finished and its code
findings are applied — this ticket exists only to run the gate and settle two open decisions.**

## What landed in the implementation

**Arm A — tree keys cached per entry object.** A module-level `WeakMap<PeerEntry, string>` in
`src/store/digitree-store.ts`, consulted and populated inside `makeKey` itself. Keyed on object
identity, not peer id: every write path spreads the old entry into a new object, so a re-key is a
cache miss by construction and a stale key is unrepresentable.

**Arm B — walks exit on a lap.** `neighborsRight` / `neighborsLeft` collect into a `Set<string>`
and `break` on the first id already present. The `maxScan` bounded-scan guard is unchanged.

**Docs.** Two bullets in the *Routing store (Digitree) & indices (A2)* section of `docs/fret.md`.

## Review conclusions so far — settled, carry these into the complete ticket verbatim

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
- **`successorOfCoord` / `predecessorOfCoord` confirmed unaffected**: each returns on the first
  match and cannot lap, so Arm B does not apply. Both do benefit from Arm A.

**`docs/fret.md` verified against the code.** Both new bullets read correctly against the shipped
`makeKey` / walk bodies; the one number that disagreed is fixed below.

## Findings applied in this pass — already in the working tree, do not redo

Three minor, comment/text-only edits (`git diff` against `94cd6e7` shows exactly these):

- **The filter-purity note was vacuous as the code stands.** With a filter, `maxScan = size()` and
  `scanned` increments on every entry visited, match or miss, so a walk is cut off at exactly one
  lap and `out.has(e.id)` can never be true — the exit is reachable **only** on the unfiltered
  path. The `NOTE:` above `neighborsRight` now says that plainly, keeps the purity condition (it
  goes live the moment `maxScan` is weakened), and names `maxScan` as what makes the exit
  unreachable today.
- **Stale measurement in the `keyCache` doc comment.** It said "39.0 ms rebuilding vs 6.4 ms
  cached"; 6.4 ms was the *predicted* figure from the plan ticket. Corrected to the measured
  4.4 ms, which `docs/fret.md` and the implement handoff both already carry.
- **A test was filed under the wrong guard.** `test/digitree.neighbors.spec.ts`, "visits each entry
  at most once when a pass-all filter is supplied", sits inside the *ring walks exit on a lap*
  describe block but by the point above the exit never fires on a filtered walk — `maxScan` is
  what bounds it, and the test passes unchanged at the pre-Arm-B HEAD. Retitled and given a
  comment saying so. It is a genuine regression test for the filtered walk's bound; kept.

## Remaining work

**Run the gate.** From `packages/fret/`: `npx tsc --noEmit`, `yarn build`, `yarn test`. No review
run has managed this yet, so the gate is unmet — it is the one hard blocker on completing. The
applied edits are comment-only plus one test title string, so a failure would be pre-existing;
handle any such failure per the pre-existing-test-failure rules rather than chasing it here. Note
there is no lint step — per `AGENTS.md`, `yarn check` is the gate and `yarn format` must **not**
be run.

**Decide the wall-clock-test question.** The implementer flagged it himself: the lap test
`does work proportional to the ring, not to count` asserts `neighborsRight(ZERO, 1_000_000)` on a
4-entry ring finishes under 500 ms. It is the only probe available for the *unfiltered* path (a
counting filter changes which guard is under test, per the applied finding above), and it
discriminates roughly five orders of magnitude, so flakiness is unlikely — but it is still a
timing assertion on shared CI. Decide one way or the other: keep as-is with that reasoning
recorded at the test, or replace it with an injectable visit counter on the store. Either is
defensible; the call has simply not been made.

**Confirm nothing can reintroduce a duplicate tree id** (Arm B soundness condition 1). The write
seam (`DigitreeStore.put`) and its property test were read and look right, but the claim was not
probed independently — the seam deletes the entry under the old key before upserting at the new
one, and the model-based property test in `test/digitree.invariants.spec.ts` recounts after every
op. A short independent read of those two is enough; no new test is expected.

**Decide whether the `plan/cleanup-store-ring` interaction needs more than a comment.** A `NOTE:`
at the walk site asks that later ticket to absorb the set/exit logic into the shared directional
walker rather than copy it per call site. Nothing enforces that. Judge whether it is worth more
than the comment already there; "the comment is enough" is a fine answer to record.

## Output when done

A `complete/` ticket with a `## Review findings` section: what was checked, what was found, what
was done. Carry the *Review conclusions so far* and *Findings applied* sections above forward —
they are checked work, not speculation — and state empty categories explicitly with a reason
(there were no major findings and no tripwires beyond the `NOTE:`s already at the walk site).
