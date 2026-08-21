description: A batch of mechanical cleanups in the store and ring code to remove duplication, dead code, and misleading constructs.
files: packages/fret/src/store/digitree-store.ts, packages/fret/src/store/relevance.ts
difficulty: easy
----
Plan research complete (see prior plan-stage history for full trail). Every item below is fully
specified — no design decisions remain. Work top to bottom; items are independent except the
walker extraction, which touches the most surface.

## 1. Inline `withCounters` (relevance.ts:101-103)

```ts
function withCounters(entry: PeerEntry, patch: Partial<PeerEntry>): PeerEntry {
	return { ...entry, ...patch };
}
```
Bare spread, 3 call sites (`touch`, `recordSuccess`, `recordFailure`). Delete the function, inline
`{ ...entry, ...patch }` at each of the 3 call sites.

## 2. Fix `touch`'s access-count basis (relevance.ts, `touch()` ~105-115)

`touch` computes `base = baseRelevance(entry, now)` off the **pre-increment** entry, then
increments `accessCount` only in the returned patch. `recordSuccess` (~157-169) and
`recordFailure` (~171-182) both build a locally-modified entry with the counter **already
incremented** before calling `baseRelevance`. Change:
```ts
const base = baseRelevance(entry, now);
```
to:
```ts
const base = baseRelevance({ ...entry, accessCount: entry.accessCount + 1 }, now);
```
matching the other two paths' pattern.

## 3. Remove dead `Math.max(1, ...)` clamp (relevance.ts:65-66)

```ts
const halfLifeMs = 60_000; // 1 minute half-life
const lambda = Math.log(2) / Math.max(1, halfLifeMs);
```
`halfLifeMs` is a hardcoded local constant, never a parameter, never computed — always `60_000`.
The clamp can never bind. Simplify to:
```ts
const halfLifeMs = 60_000; // 1 minute half-life
const lambda = Math.log(2) / halfLifeMs;
```

## 4. Extract shared directional ring walker (digitree-store.ts:385-548)

`digitree-store.ts:425-460` carries a NOTE block already describing this extraction — read it in
full before starting; it names the two soundness conditions (one-entry-per-id makes a repeat mean
"lapped"; a supplied filter must be pure) that the new walker must preserve. Five methods today
all seek via `ceilPath`/`floorPath` then walk `next`/`prior` with a `maxScan` bounded-scan guard
when a filter is given:

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

## 5. Verify-then-noop items (already fixed in codebase per grep — confirm still true, don't redo work)

- **coord-to-hex duplication**: `digitree-store.ts` already uses the shared `coordToHex` from
  `../ring/hash.js` throughout. Grep confirmed no second implementation anywhere in `src/`. If a
  grep at implementation time still shows only these two files, this item is a no-op — do not add
  a new helper or touch call sites.
- **lexicographic-less padding mismatch**: `ring/distance.ts:10-19` (`lexLess`) is already
  right-aligned, matching `clockwiseDistance`'s own right-aligned loop, and its docblock says so.
  Grep confirmed no other `lexLess`/padding comparator exists. No-op unless a second comparator
  turns up.
- **metadata `Record<string, any>`**: grep confirmed zero live `Record<string, any>` / bare `: any`
  matches in `src/`. `PeerEntry.metadata` / `SerializedPeerEntry.metadata` are already
  `Record<string, unknown>`. No-op.
- **mirrored-index xor loop**: grepped all of `src/` and `test/` for descending/mirrored-index
  loops and for `xor`/`^` styled indexing — nothing matches "mirrored-index xor" at all. The only
  descending-index loop is `lexLess` itself (see above — legitimate, right-aligned magnitude
  compare, and out of scope per this ticket's own "don't touch ring-distance internals beyond the
  padding check" framing). Treat this ticket item as stale; drop it from scope, do not search
  further or block on it.

Out of scope: the dead ring-distance exports (`clockwiseDistance` and `minDistance` unused-export
cleanup) are handled by the separate `consolidate-ring-distance` ticket; do not touch them here.

## Edge cases & interactions

- **Walker extraction — empty store**: `successorOfCoord`/`predecessorOfCoord` must still return
  `undefined`, `neighborsRight`/`neighborsLeft` must still return `[]`, `walkFrom` must still
  return `{ entries: [], next: cursor }`. All three are exercised today by existing tests; rerun
  them after the extraction, don't just add new ones.
- **Walker extraction — single-entry ring**: `neighborsRight`/`neighborsLeft` with `count > 1` must
  still terminate via the repeat-id exit rather than looping. `walkFrom` on a one-peer ring must
  still re-yield that peer on every page (its own docblock states this explicitly — "strictly
  after X, wrapping, is X itself").
  - **A single-entry ring is exactly the case that broke this before** (see the "measured on a
    4-entry ring" note in the existing NOTE block at digitree-store.ts:425-460): confirm the
    extracted walker still exits in O(count) rather than O(large number) here — this is the
    regression the original early-exit fix was for.
- **Walker extraction — filtered walk with zero matches**: all five methods must still terminate
  via the `maxScan`/bounded-scan guard rather than spinning forever on the wrap-around. This is
  the ticket's own stated reason the extraction matters (a future walk written outside the shared
  walker could omit the guard) — write or confirm a test that a filter matching nothing on a
  non-empty store returns empty/undefined promptly, not just correctly.
- **Walker extraction — impure filter**: not a case to *handle*, but don't accidentally make the
  early-exit-on-repeat logic depend on filter purity in a new way the current code doesn't. Every
  existing caller passes `isLiveMember` or a plain field comparison (both pure); no new impurity
  should be introduced by the refactor.
- **`walkFrom` cursor pointing at a since-evicted entry**: existing behavior (per its docblock) is
  that `next` of the cursor's path resumes at the right ring position even if that entry is gone.
  Confirm this still holds through the extracted walker — it depends on `byKey.next(byKey.find(cursor.key))`
  landing correctly on a path in the "crack" where a deleted key used to be.
- **Relevance fix — `touch` triggered from an inbound snapshot merge**: `touch` is the path an
  *inbound* snapshot naming a peer runs (per relevance.ts's own docs on `recordSuccess`). After
  the access-count-basis fix, confirm a snapshot-driven `touch` still produces a relevance value in
  the same ballpark as before (i.e., the fix should tighten consistency with `recordSuccess`/
  `recordFailure`, not produce a wildly different scale) — sanity-check against
  `test/relevance.properties.spec.ts` if it exists, or the eviction spec.
- **Cross-check with `test/relevance.eviction.spec.ts`**: this spec is explicitly pinned in
  `docs/fret.md` against eviction/protection-set behavior driven by relevance scores. Re-run it
  after the `touch` fix — it's the most likely place a scale change in `touch`'s output would
  surface as a changed eviction order.
- **`test/digitree.invariants.spec.ts` and `test/digitree.neighbors.spec.ts`**: both are
  model-based/property tests over the exact methods being refactored in item 4. These are the
  primary regression backstop for the walker extraction — run them, don't just eyeball the diff.

## TODO

- Inline `withCounters`, delete the function (item 1)
- Fix `touch`'s base-relevance access-count basis (item 2)
- Remove the dead `Math.max(1, halfLifeMs)` clamp (item 3)
- Extract the shared directional ring walker and rewrite the 5 consumers to use it (item 4)
- Grep-confirm the 4 "already fixed" items are still true; no-op if so, flag in handoff if not
  (item 5)
- Run `cd packages/fret && npx tsc --noEmit`
- Run `cd packages/fret && yarn test` — pay particular attention to
  `test/digitree.invariants.spec.ts`, `test/digitree.neighbors.spec.ts`,
  `test/relevance.eviction.spec.ts`
- Delete the extraction NOTE block at digitree-store.ts:456-460 once the walker lands

Expected behavior: identical behavior with less duplication and no dead or misleading code; the
relevance touch path uses the same access-count basis as the other record paths.

References: review store section, cleanup finding "Mechanical cleanups" (digitree-store.ts:208-294)
and minor finding on relevance (relevance.ts:103-113).
