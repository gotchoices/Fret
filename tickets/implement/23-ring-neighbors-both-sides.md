---
description: The code that finds a peer's ring neighbors on both sides is copy-pasted in six places, and every copy quietly returns one fewer neighbor per side than asked for; one of them also drops most of the neighbors on one side entirely. Replace the copies with a single shared helper that gets the count right.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/service/ring-walk.ts (new), packages/fret/src/store/digitree-store.ts, packages/fret/src/estimate/size-estimator.ts, packages/fret/test/relevance.eviction.spec.ts, packages/fret/test/ring-walk.spec.ts (new), docs/fret.md
difficulty: medium
repro: verified
---
Item (a) of the former `plan/23-fret-service-decomposition`, resolved. Items (b) and (c) live in
`implement/23.1-size-observer-extraction` and `plan/23.2-membership-classification-extraction`.

## Why one ticket

Three symptoms, one code site: the two-sided ring walk idiom, copy-pasted. Fixing them separately
means writing the same walk three more times.

1. **Duplication.** `Array.from(new Set([...neighborsRight(c, m), ...neighborsLeft(c, m)])).filter(id => id !== selfStr)`
   appears six times in `fret-service.ts` with small variations.
2. **Off-by-one against the configured `m`.** Verified by reading
   `DigitreeStore.ceilPath` / `floorPath`: `ceilPath` seeks `hex(coord)` followed by `|` and a NUL,
   and `floorPath` seeks `hex(coord)` followed by `|` and U+FFFF then steps back — so a walk
   anchored **exactly on a stored coordinate** returns that entry as its own first result on *both*
   sides. Self-anchored `neighborsRight(selfCoord, m)` therefore yields self plus only `m - 1`
   other peers, and the ubiquitous trailing `.filter(id => id !== selfStr)` is the tell: the count
   was already spent on self. `windowGaps` in `src/estimate/size-estimator.ts` is the one site that
   compensates (asks each side for `m + 1`, with a comment explaining why), which is the evidence
   this is a class rather than an instance.
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

## Call sites

All in `packages/fret/src/service/fret-service.ts` unless noted. Line numbers are approximate —
grep the named symbol.

| Site | Anchor | Count | Filter | Excludes | Post-processing |
|---|---|---|---|---|---|
| `announceTargetsAround` ~1446 | arbitrary coord | `m` | none | `exclude` set (self, departed id) | non-connected-first re-sort, `.slice(fanout)` |
| `warmupTargetIds` ~1522 | self | `min(radius, m)` | none | self | none (feeds pooled ping) |
| `computeReplacements` ~1587 | self | `m * 2` | `isLiveMember` | self + `spNeighborIds` | full re-sort, `.slice(6)` |
| `sendLeaveToNeighbors` ~1614 | self | `m` | none | self | `.slice(0, 8)` — **the defect** |
| `isNearNeighbor` ~1774 | self | `m` | none | self | membership test only |
| `getNeighbors` ~2553 | key coord | `wants` | `isLiveMember` | none | `.slice(wants)` |
| `DigitreeStore.protectedIdsAround` ~351 | self (only caller: `enforceCapacity` ~519) | `max(2, m)` | `isLiveMember` | none | returns a `Set` |
| `windowGaps` (`src/estimate/size-estimator.ts` ~82) | self | `m + 1` | caller's | self via offset `Set` | already compensates |

## The helper

New module `packages/fret/src/service/ring-walk.ts` — beside `live-member.ts`, for the same reason
that one is not inside `FretService`: `windowGaps` and the capacity-protection walk are callers too.

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

## Behavior changes this lands

Each is a fix, not a refactor artifact. Each needs a `docs/fret.md` edit.

- **Capacity protection covers the full S/P window.** `enforceCapacity` protects
  `2*max(2, m) + 1` ids (self + m per side) instead of today's `2*max(2, m) - 1`; the m-th
  successor and m-th predecessor are no longer evictable at capacity. `docs/fret.md` already
  describes the whole of S(p) union P(p) as retained, so the prose is written for the fixed
  behavior — delete the "off-by-one" bullet under *Relevance scoring and table management* that
  records today's. Keep the separate `capacity < 2m - 1` bullet, adjusting its arithmetic to the
  wider set.
- **`DigitreeStore.protectedIdsAround` is deleted**, not fixed. It is a two-sided walk with one
  caller; leaving it in place means the `+1` rule lives in two modules. `enforceCapacity` calls
  the helper and adds self.
- **Leave notices reach the whole S/P set.** Drop the `.slice(0, 8)` from `sendLeaveToNeighbors`
  entirely. The fan-out is already clock-bounded — `SHUTDOWN_BUDGET_MS` (3 s) overall,
  `LEAVE_NOTICE_TIMEOUT_MS` (1.5 s) per notice, with `if (budget.signal.aborted) break` in the
  loop — so the literal `8` was never the real bound, and interleaving means a budget truncation
  now costs the outermost peers on both sides rather than six of the seven predecessors.
  `docs/fret.md` *Leave* step 1 becomes true as written.
- **`spSet` is the unsliced S/P set.** It defines what "outside our own S/P window" means for
  `computeReplacements`, so it must not be derived from the target list. Bind the helper's result
  to one name, derive `spSet` from it, and pass the same array to the send loop — conflating "who
  we notified" with "what our window is" is the root cause, and one array with two readers is what
  stops them diverging again. Today's bug: because `spSet` came from the sliced list, six genuine
  predecessors passed `computeReplacements`' "outside our window" filter and were advertised as
  replacements. Latent rather than observed (the clockwise pool filled all six slots first in the
  measured run), but a single *connected* predecessor sorts to the front of that ordering and ships.
- **`windowGaps` drops its local `+ 1`** and calls the helper, keeping its own `offsets` seed of
  `0n` for self. The paragraph in `docs/fret.md` explaining the `m + 1` compensation moves to
  describing the helper's rule.
- **`announceTargetsAround` slices per side.** Its `.slice(0, fanout)` now runs over an
  interleaved union, so a Core fanout of 8 against m = 8 stops being successor-only.

## Deliberately out of scope

- **`getNeighbors` is not migrated.** It is on the public `FretService` interface, key-anchored
  rather than self-anchored (so the off-by-one does not apply — no entry normally sits on a key's
  coordinate), does not exclude self (self is a legitimate neighbor of a key), and its `wants` is
  both the per-side count and the total cap. Folding it in would change public behavior for a
  defect it does not have. Leave a `NOTE:` at the site recording that its concatenate-then-slice
  is successor-biased by the design of the `wants` contract, and that the helper deliberately does
  not cover it.
- **Pooling the leave fan-out.** The send loop is serial, so 16 notices at 1.5 s each against a
  3 s budget is clock-bound well before it is target-bound. Record as a tripwire `NOTE:` at
  `sendLeaveToNeighbors` — "notices are sent serially; if departure healing latency matters, pool
  this through `runPooled` like the stabilization tick" — not as a ticket.

## Edge cases & interactions

- **Anchor coordinate not in the store.** `announceTargetsAround` on a departed peer's coordinate,
  after that peer was removed: no entry sits on the anchor, so the over-fetch returns one surplus
  id per side that the trim must remove. Assert the helper returns exactly `count` per side in
  both the anchor-present and anchor-absent cases.
- **Ring smaller than `count`.** The store's `collectRing` exits on the first repeated id, so both
  sides return the whole ring and the union is every peer. Must not duplicate, must not pad, must
  not spin. Test at ring sizes 1, 2, 3 with `count` = 8.
- **Ring of exactly one peer (self).** Both walks return `[self]`; after self-exclusion the result
  is empty. Every caller must handle empty — `sendLeaveToNeighbors` already returns early via the
  loop, and `enforceCapacity` must still protect self.
- **Wrap-around.** A window straddling coordinate 0 must stay one contiguous run. Two sides
  overlapping across the wrap must dedup, not double-count. Reuse the seam vectors in
  `test/ring-wrap-distance.spec.ts` as coordinate fixtures.
- **`exclude` blanketing one side.** `computeReplacements` excludes up to 2m ids; if they all sit
  on one side, that side must still yield `count` peers from further out rather than starving.
  This is what the `+ exclude.size` over-fetch buys.
- **Filtered walk with zero matches.** `isLiveMember` matching nothing must terminate (the store's
  `maxScan` guard) and return empty, not spin.
- **`count <= 0`.** `warmupTargetIds` passes `min(radius, m)`; a degenerate config of `m = 0` must
  return empty rather than over-fetching 1 and returning a peer.
- **Interleaving with unequal sides.** Right side exhausted before left (or vice versa) — the
  remainder of the longer side appends in order; no gaps, no `undefined`.
- **Eviction interaction.** With the protected set widened by 2, a store at capacity has two fewer
  eviction candidates. `test/relevance.eviction.spec.ts` currently *pins today's off-by-one as
  current behavior* — it must be updated to assert the fixed set, not merely re-baselined.
- **Filter purity.** `collectRing`'s lapped-ring early exit relies on a supplied `filter` being
  pure. The helper must not wrap the caller's filter in anything stateful (no memo of ids seen);
  exclusion happens *after* the walk, on the returned id list.

## TODO

### Phase 1 — helper + unit spec

- Add `packages/fret/src/service/ring-walk.ts` with `ringNeighborsBothSides` and
  `RingWalkOptions`, exactly as specified above. Import `PeerEntry` with `import type`
  (`verbatimModuleSyntax` is on — a plain type import throws at runtime under the loader hook).
- Add `packages/fret/test/ring-walk.spec.ts` covering every case in *Edge cases & interactions*
  that is a property of the helper itself. Include a `fast-check` property over (ring population,
  `count`, `exclude` set, anchor-on-a-peer vs anchor-between-peers) asserting: result length is
  `min(count per side after exclusion, reachable ring size)`, no duplicates, self never present,
  no excluded id present, and every returned id is in the store.
- Add a direct regression case: a hand-seeded 20-peer ring at `k: 15` (so `m` = 8) with self in
  the store, asserting the helper returns 8 successors and 8 predecessors — the measurement above
  recorded 7 per side.

### Phase 2 — migrate the call sites

- `enforceCapacity`: call the helper with `max(2, m)`, add self to the returned set. Delete
  `DigitreeStore.protectedIdsAround`.
- `announceTargetsAround`, `warmupTargetIds`, `computeReplacements`, `isNearNeighbor`: replace the
  inline idiom with the helper.
- `sendLeaveToNeighbors`: bind the helper's result once; `spSet` is that set; drop `.slice(0, 8)`;
  add the serial-fan-out tripwire `NOTE:`.
- `windowGaps`: call the helper with `m`, drop the local `+ 1` and its explanatory comment.
- `getNeighbors`: leave as-is, add the `NOTE:` described under *Deliberately out of scope*.

### Phase 3 — pin the behavior changes

- Update `test/relevance.eviction.spec.ts` to assert the widened protected set (self + m per side)
  and that the m-th successor and m-th predecessor survive eviction at capacity.
- Add a sender-side leave spec at `k: 15` (the shipped default, where the old slice bit) asserting
  every S/P member receives a notice, and that `computeReplacements` returns no id inside the S/P
  window. Existing leave specs run at `k: 3` / `k: 7`, where the slice never bit — those stay and
  must keep passing unchanged.
- Add a size-estimator case asserting the gap population is 2m gaps at the default m, unchanged
  after the `windowGaps` migration (a parity check, not a fix).

### Phase 4 — docs + gate

- `docs/fret.md`: the five edits named under *Behavior changes this lands*.
- `cd packages/fret && npx tsc --noEmit`, then `yarn test` from `packages/fret` in the foreground
  with no redirection.
