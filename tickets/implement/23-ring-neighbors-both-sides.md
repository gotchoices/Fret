---
description: A shared helper that finds a peer's ring neighbors on both sides has been written but has no tests yet. Write the test suite that pins its behavior, including the miscount it was built to fix.
files: packages/fret/src/service/ring-walk.ts (written, typechecks, untested), packages/fret/test/ring-walk.spec.ts (new — the remaining work), packages/fret/src/store/digitree-store.ts
difficulty: medium
repro: verified
---
Continuation of the same slug, kept at the same slug on purpose: `implement/23.05-ring-walk-migrate-call-sites`
names `23-ring-neighbors-both-sides` as its `prereq:`, so renaming would break that link. Scope is now
**tests only** — a budget warning stopped the previous run right after the helper was written.

## What already landed

`packages/fret/src/service/ring-walk.ts` exists, exports `ringNeighborsBothSides` and `RingWalkOptions`
exactly as the previous ticket specified, and passes `cd packages/fret && npx tsc --noEmit` (verified).
It is **unused** by any call site — that is deliberate; `23.05` migrates onto it.

Shape as written:

```ts
export function ringNeighborsBothSides(
	store: DigitreeStore, coord: Uint8Array, count: number, selfId: string, opts?: RingWalkOptions
): string[]
```

- `count <= 0` → `[]` before anything else.
- `reach = count + 1 + (exclude?.size ?? 0)`; each side walked with `opts.filter` passed *into* the
  store walk, then self + `exclude` dropped from the returned ids, then `.slice(0, count)`.
- Sides woven `s1, p1, s2, p2, …` with a `Set` dedup.
- Two private helpers: `trimSide` (drop-then-trim one side) and `interleave`.

## What is left

Only `packages/fret/test/ring-walk.spec.ts`. **No source changes are expected** — if a test forces one,
that is a real finding, not a licence to loosen the test.

## Facts derived last run — do not re-derive

Read from `src/store/digitree-store.ts` (`ceilPath` ~358, `floorPath` ~366, `collectRing` ~472).

- **Both walks return the entry sitting exactly on the anchor.** `ceilPath` seeks `hex(coord)|\x00`
  and takes the first key ≥ it; `floorPath` seeks `hex(coord)|￿` and steps back. An entry keyed
  `hex(coord)|id` matches either way. This is the whole off-by-one.
- **Each side always yields exactly `min(count, r)` ids**, where `r` = ids in the store passing
  `filter`, minus self, minus `exclude`. Proof, both branches:
  - Matching population ≥ `reach`: the walk returns `reach` ids; the drop removes at most
    `1 + |exclude|`; so ≥ `count` survive and the slice makes it exactly `count`. Also `r ≥ count`
    here, so `min(count, r) = count`.
  - Matching population < `reach`: the walk laps and returns *every* matching id, so after the drop
    exactly `r` survive and the slice gives `min(count, r)`.
- **Therefore the two sides are always equal in length.** Both walks see the same lapped set. The
  unequal-length branch of `interleave` is consequently unreachable through the public function
  today; there is a `NOTE:` at that site saying so and why it is kept. Pin the equal-length
  invariant rather than trying to construct an unequal case — it cannot be constructed, and the
  previous run tried several shapes (one-sided filters, one-sided `exclude` sets) before proving it.
- **Exact union size**, useful as the property's oracle:
  `expected = r === 0 ? 0 : min(anchorInR ? 2·perSide − 1 : 2·perSide, r)` where
  `perSide = min(count, r)` and `anchorInR` is "a *reachable* entry sits at exactly the anchor
  coordinate" (present in the store, passes `filter`, is not self, is not excluded). The `− 1` is
  because that entry heads **both** sides.

## TODO

Ring fixtures: ascending coordinates, e.g. `coordAt(i)` writing `i * 7` into byte 0 (distinct and
ascending for `i < 24`), and `betweenCoord(i)` writing `i * 7 + 3` for an anchor that sits strictly
between two stored peers. Entries via `store.upsert(\`p${i}\`, coordAt(i))`.

- **Direct regression — the measurement this helper exists to fix.** 20-peer ring (`p0`…`p19`),
  `k: 15` so `m` = 8, self `p0` in the store, anchor `coordAt(0)`, `count` 8. Assert the raw store
  walk `store.neighborsRight(coordAt(0), 8)` yields only **7** peers besides `p0` — that is the
  defect — and that the helper returns 8 successors and 8 predecessors. Expected exact output:
  `p1,p19,p2,p18,p3,p17,p4,p16,p5,p15,p6,p14,p7,p13,p8,p12`.
- **Anchor coordinate not in the store.** Anchor `betweenCoord(9)` on the same 20-peer ring, self
  absent (`selfId` naming no stored peer), `count` 8 → successors `p10`…`p17`, predecessors
  `p9`…`p2`, 16 distinct. Assert exactly `count` per side in *both* the anchor-present and
  anchor-absent cases; the over-fetch is what has to be exact in both.
- **Ring smaller than `count`.** Ring sizes 1, 2 and 3 with `count` 8 and self absent: result is the
  whole ring, no duplicates, no padding, no spin.
- **Ring of exactly one peer, which is self.** Both walks return `[self]`; result is empty. (That
  *callers* handle empty is `23.05`'s assertion, not this one's.)
- **Wrap-around.** Five peers at first-byte coordinates `0x00, 0x10, 0x20, 0xE0, 0xF0`; anchor at
  `0xF8`, which sits between the last peer and the first across the seam. With `count` 2 the window
  must be the one contiguous run `0xE0, 0xF0 | anchor | 0x00, 0x10` — assert the far peer `0x20` is
  absent. Then `count` 4 on the same ring: the two sides overlap across the wrap and must dedup to
  the whole 5-peer ring, not double-count.
- **`exclude` blanketing one side.** 20-peer ring, self `p0`, anchor `coordAt(0)`, `count` 3,
  `exclude` = `{p1, p2, p3}` (all successors). Successors must still be 3 peers from further out —
  `p4, p5, p6` — and predecessors `p19, p18, p17`; result `p4,p19,p5,p18,p6,p17`. No excluded id
  present. This is what the `+ exclude.size` over-fetch buys.
- **Filtered walk with zero matches.** `filter: () => false` over a populated ring must return `[]`
  and terminate (the store's one-lap `maxScan` is what makes this true).
- **`count <= 0`.** Both `0` and a negative return `[]` against a populated ring — not one peer.
- **Interleaving asserted explicitly** (`s1, p1, s2, p2, …`), since that ordering is what makes a
  downstream truncation lose the outermost peers on both sides rather than one whole side. With
  equal-length sides, `result[0], result[2], …` is the successor side and `result[1], result[3], …`
  the predecessor side — assert on those slices.
- **Equal-length sides pinned** as its own case, with the reason in a comment (both walks lap, so
  both see the same reachable set).
- **`fast-check` property** over (ring population, `count`, `exclude` set, self index, anchor-on-a-peer
  vs anchor-between-peers, filter on/off). Assert: result length equals the exact oracle above; no
  duplicates; self never present; no excluded id present; every returned id is in the store and
  passes the filter. Tally and assert on the generated distribution so the interesting regions —
  anchor-on-a-peer, and ring-smaller-than-`count` — are provably reached rather than assumed.
  Use a membership-based filter (`store.setMembership(id, …)` plus `isLiveMember` from
  `src/service/live-member.ts`) for at least one case so the predicate under test is the real one;
  note `upsert` defaults membership to `'unknown'`, so every peer needs marking `'member'` first.
- **Gate:** `cd packages/fret && npx tsc --noEmit`, then `yarn test` from `packages/fret` in the
  foreground with no redirection.
