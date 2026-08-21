---
description: The code that finds a peer's ring neighbors on both sides is copy-pasted in several places, and every copy quietly returns one fewer neighbor per side than asked for. Build one shared helper that gets the count right, with tests, before anything is migrated onto it.
files: packages/fret/src/service/ring-walk.ts (new), packages/fret/test/ring-walk.spec.ts (new), packages/fret/src/store/digitree-store.ts, packages/fret/src/service/live-member.ts
difficulty: medium
repro: verified
---
Phase 1 of the former single ticket of this slug. Phases 2-4 (migrating the call sites, pinning the
behavior changes, docs) are now `implement/23.05-ring-walk-migrate-call-sites`, which names this
ticket as its prereq. Item (a) of the former `plan/23-fret-service-decomposition`; items (b) and (c)
live in `implement/23.1-size-observer-extraction` and `plan/23.2-membership-classification-extraction`.

Split because a budget warning stopped the run before any code was written. **Nothing has been
implemented yet** — the whole original TODO list is still outstanding, distributed across these two
tickets. The findings below were verified by reading the source in that run and are recorded so the
next agent does not re-derive them.

## Why the helper exists

Three symptoms, one code site: the two-sided ring walk idiom, copy-pasted. Fixing them separately
means writing the same walk three more times.

1. **Duplication.** `Array.from(new Set([...neighborsRight(c, m), ...neighborsLeft(c, m)])).filter(id => id !== selfStr)`
   appears six times in `fret-service.ts` with small variations.
2. **Off-by-one against the configured `m`.** Verified by reading `DigitreeStore.ceilPath` /
   `floorPath` (`src/store/digitree-store.ts` ~358 / ~366): `ceilPath` seeks `hex(coord)` followed
   by `|` and a NUL, and `floorPath` seeks `hex(coord)` followed by `|` and U+FFFF then steps back
   — so a walk anchored **exactly on a stored coordinate** returns that entry as its own first
   result on *both* sides. Self-anchored `neighborsRight(selfCoord, m)` therefore yields self plus
   only `m - 1` other peers, and the ubiquitous trailing `.filter(id => id !== selfStr)` is the
   tell: the count was already spent on self. `windowGaps` in `src/estimate/size-estimator.ts` ~82
   is the one site that compensates (asks each side for `m + 1`, with a comment explaining why),
   which is the evidence this is a class rather than an instance.
3. **Slice-after-concatenation.** Three sites bound the *concatenation* of the two walks rather
   than each side, so the second walk is what gets eaten. `sendLeaveToNeighbors` is the worst
   (`.slice(0, 8)`, a bare literal that does not scale with `k`); `announceTargetsAround`
   (`.slice(0, fanout)`) and the public `getNeighbors` (`.slice(0, wants)`) have the same shape.

The measurement the source ticket recorded, on a hand-seeded 20-peer ring at the shipped default
`k: 15` (so `m` = 8) with self in the store:

```
unsliced S/P walk offsets: [1,2,3,4,5,6,7, 20,19,18,17,16,15,14]
sliced targets (slice 0,8): [1,2,3,4,5,6,7, 20]
```

Seven per side instead of eight (the off-by-one), and after the slice only one predecessor
survives (the concatenation bug).

## The helper

New module `packages/fret/src/service/ring-walk.ts` — beside `live-member.ts`, for the same reason
that one is not inside `FretService`: `windowGaps` (in `src/estimate/`) and the capacity-protection
walk are callers too.

```ts
export interface RingWalkOptions {
	/** Predicate passed *into* the store walk, never applied to its result. */
	filter?: (e: PeerEntry) => boolean;
	/** Additional ids to drop. Self is excluded separately and always. */
	exclude?: ReadonlySet<string>;
}

/**
 * Union of the `count` ring neighbors on each side of `coord`, self-excluded and deduped,
 * returned **side-interleaved** (s1, p1, s2, p2, ...).
 *
 * `count` means *peers besides self*. A walk anchored on a stored coordinate returns that
 * entry as its own first result on both sides, so each side is asked for
 * `count + 1 + exclude.size` and trimmed back to `count` after exclusion.
 */
export function ringNeighborsBothSides(
	store: DigitreeStore,
	coord: Uint8Array,
	count: number,
	selfId: string,
	opts?: RingWalkOptions
): string[];
```

Algorithm — three rules, stated once:

- **Over-fetch, then trim per side.** `neighborsRight(coord, count + 1 + exclude.size, filter)`,
  drop self and `exclude`, then `.slice(0, count)`. Mirror for the left. Over-fetching by
  `1 + exclude.size` is exact whether or not an entry sits on `coord`: when one does, the extra
  slot pays for it; when none does, the trim removes the surplus. Excluded ids consume walk slots
  too, which is why `exclude.size` is in the over-fetch.
- **No `limit` parameter.** A cap applied to the concatenation is the third defect above. Callers
  that need a budget slice their own result — and they must decide, explicitly, whether they are
  bounding *who we contact* or *what our window is*. The helper only ever answers the second.
- **Interleave the sides.** A caller that truncates for any reason then loses the outermost peers
  on both sides rather than one whole side. This is the change that retires the leave defect's
  first consequence regardless of any downstream slice.

## What the store already guarantees (verified — do not re-derive)

Read from `src/store/digitree-store.ts`; the helper must not duplicate any of it.

- `neighborsRight(coord, count, filter)` = `collectRing(ceilPath(hex(coord)), 'next', count, filter)`;
  `neighborsLeft` is the `floorPath` / `'prior'` mirror. Both return `string[]` of **distinct** ids.
- `collectRing` returns `[]` immediately when `count <= 0`. So a `count <= 0` ask needs no guard in
  the store — but the helper still must not over-fetch `0 + 1 + exclude.size` and return a peer for
  a degenerate `m = 0` config (`warmupTargetIds` passes `min(radius, m)`). Guard `count <= 0` in
  the helper and return `[]`.
- A walk that laps the ring exits on the first repeated id, so a ring smaller than `count` returns
  the whole ring — never duplicates, never pads, never spins.
- A **filtered** walk is capped at `maxScan = size()` (one full lap), so a filter matching nothing
  terminates and returns `[]`. Unfiltered walks use `maxScan = Infinity` and rely on the
  lapped-id exit.
- Soundness condition recorded at `collectRing`: a supplied `filter` must be **pure**. The helper
  must therefore not wrap the caller's filter in anything stateful (no memo of ids seen);
  exclusion happens *after* the walk, on the returned id list.

## Edge cases & interactions (all are properties of the helper itself)

- **Anchor coordinate not in the store.** No entry sits on the anchor, so the over-fetch returns
  one surplus id per side that the trim must remove. Assert exactly `count` per side in both the
  anchor-present and anchor-absent cases.
- **Ring smaller than `count`.** Both sides return the whole ring and the union is every peer.
  Must not duplicate, must not pad, must not spin. Test at ring sizes 1, 2, 3 with `count` = 8.
- **Ring of exactly one peer (self).** Both walks return `[self]`; after self-exclusion the result
  is empty. That callers handle empty is asserted in the migration ticket, not here.
- **Wrap-around.** A window straddling coordinate 0 must stay one contiguous run. Two sides
  overlapping across the wrap must dedup, not double-count. Reuse the seam vectors in
  `test/ring-wrap-distance.spec.ts` as coordinate fixtures.
- **`exclude` blanketing one side.** If every excluded id sits on one side, that side must still
  yield `count` peers from further out rather than starving. This is what the `+ exclude.size`
  over-fetch buys.
- **Filtered walk with zero matches.** Must terminate and return empty, not spin.
- **`count <= 0`.** Must return empty rather than over-fetching 1 and returning a peer.
- **Interleaving with unequal sides.** Right side exhausted before left (or vice versa) — the
  remainder of the longer side appends in order; no gaps, no `undefined`.

## TODO

- Add `packages/fret/src/service/ring-walk.ts` with `ringNeighborsBothSides` and
  `RingWalkOptions`, exactly as specified above. Import `PeerEntry` and `DigitreeStore` with
  `import type` where they are only types (`verbatimModuleSyntax` is on — a plain type import
  throws at runtime under the loader hook; see AGENTS.md).
- Add `packages/fret/test/ring-walk.spec.ts` covering every case in *Edge cases & interactions*.
  Include a `fast-check` property over (ring population, `count`, `exclude` set, anchor-on-a-peer
  vs anchor-between-peers) asserting: result length is `min(count per side after exclusion,
  reachable ring size)`, no duplicates, self never present, no excluded id present, and every
  returned id is in the store.
- Add a direct regression case: a hand-seeded 20-peer ring at `k: 15` (so `m` = 8) with self in
  the store, asserting the helper returns 8 successors and 8 predecessors — the measurement above
  recorded 7 per side.
- Assert the interleaving explicitly (s1, p1, s2, p2, ...), since it is what makes a downstream
  truncation lose the outermost peers on both sides rather than one whole side.
- Gate: `cd packages/fret && npx tsc --noEmit`, then `yarn test` from `packages/fret` in the
  foreground with no redirection.

No existing call site changes in this ticket — the helper lands unused, and
`23.05-ring-walk-migrate-call-sites` migrates onto it. That is deliberate: the helper's own
contract is what the six copies disagree about, so it is worth pinning before anything depends
on it.
