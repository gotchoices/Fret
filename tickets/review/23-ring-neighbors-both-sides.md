---
description: A shared helper that finds a peer's ring neighbors on both sides now has a test suite pinning its behavior, including the miscount it was built to fix. Review the tests.
files: packages/fret/test/ring-walk.spec.ts (new — the whole diff), packages/fret/src/service/ring-walk.ts (under test, unchanged), packages/fret/src/store/digitree-store.ts (the walks it calls)
difficulty: medium
---
`ringNeighborsBothSides` returns the `count` ring neighbors on each side of a coordinate, self- and
exclude-free, interleaved `s1, p1, s2, p2, …`. It landed in a prior run and typechecked but had no
tests; this ticket added them. **The diff is one new file** — `packages/fret/test/ring-walk.spec.ts`,
293 lines, 16 cases. `src/service/ring-walk.ts` was not touched and needed no change.

## What the helper is for

Both of the store's ring walks return the entry sitting *exactly* on the anchor coordinate:
`ceilPath` seeks the hex coordinate followed by a pipe and a NUL and takes the first key at or after
it, `floorPath` seeks the same prefix followed by U+FFFF and steps back — an entry keyed
`hex(coord)|id` matches either way. So a self-anchored `neighborsRight(selfCoord, m)` spends one of
its `m` slots on self and yields only `m - 1` other peers. The helper over-fetches
`count + 1 + exclude.size` per side, drops self and exclusions from the returned ids, then trims
back to `count`.

## Gate — both run, both green

- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && yarn test` — **1154 passing, 0 failing**, ~3 min. No pre-existing failures
  surfaced, so no `.pre-existing-error.md` was written.
- The new file alone: 16 passing in 43 ms.

## What the suite pins, and how to poke at it

Every case below is a place a regression would land, phrased as what to break if you want to see the
test bite.

- **The direct regression** (`the off-by-one it exists to fix`). Two halves. The first asserts the
  *defect* directly on the raw store — `store.neighborsRight(coordAt(0), 8)` on a 20-peer ring
  returns 8 ids of which only 7 are peers besides `p0`. The second asserts the helper's exact output
  at the same anchor with self `p0` and `count` 8:
  `p1,p19,p2,p18,p3,p17,p4,p16,p5,p15,p6,p14,p7,p13,p8,p12`. Drop the `+ 1` from `reach` and the
  second fails at 7-per-side.
- **Anchor coordinate not in the store.** `betweenCoord(9)` (a coordinate that can never collide
  with a stored peer — `i * 7 + 3` is never `j * 7`), self absent, `count` 8 → successors `p10`…`p17`,
  predecessors `p9`…`p2`. This is the other direction of the same arithmetic: the over-fetch must be
  exact whether or not an entry sits on the anchor, so both cases assert exactly `count` per side.
- **Equal-length sides**, its own case at counts 1/3/8/9. This is *why* the unequal-length branch of
  the private `interleave` is unreachable through the public function — both walks lap the whole
  ring, so both see the same reachable set. There is a `NOTE:` at that site saying so. The previous
  run tried several shapes (one-sided filters, one-sided `exclude` sets) to construct an unequal
  case and proved it cannot be done; the test pins the invariant instead of chasing the branch.
- **Rings smaller than `count`** — sizes 1, 2, 3 at `count` 8: the whole ring, no duplicates, no
  padding, no spin. Plus the one-peer-ring-which-is-self case → `[]`.
- **Wrap-around.** Five peers at first bytes `0x00,0x10,0x20,0xE0,0xF0`, anchor `0xF8` across the
  seam. At `count` 2 the window is the one contiguous run `cE0,cF0 | anchor | c00,c10` and the far
  peer `c20` is asserted *absent*; at `count` 4 the two sides overlap and must dedup to the whole
  5-peer ring rather than double-count.
- **`exclude` blanketing one whole side.** `count` 3, `exclude` = the three nearest successors →
  `p4,p19,p5,p18,p6,p17`. The successor side is still 3 deep, drawn from further out. This is what
  the `+ exclude.size` term of the over-fetch buys; delete it and the successor side starves.
- **Interleaving asserted explicitly** via `successorSide` / `predecessorSide` helpers (even and odd
  indices). Valid *because* the sides are equal-length, which the case above pins. The ordering is
  what makes a downstream truncation lose the outermost peers on both sides rather than one entire
  side.
- **Degenerate asks.** `filter: () => false` over a populated ring → `[]` and terminates (the store's
  one-lap `maxScan` guard is what makes that true). `count` 0 and `count` -1 → `[]`, not one peer.
- **The real membership predicate.** One case marks peers `member` via `store.setMembership` and
  passes the shipped `isLiveMember` from `src/service/live-member.ts`, not a stand-in — note `upsert`
  defaults membership to `'unknown'`, so every peer needs marking first. Non-members are skipped and
  the window fills from further out.
- **`fast-check` property**, 500 runs, over (ring population 1–20, `count` -1…12, self index or
  self-absent, `exclude` set, anchor-on-a-peer vs anchor-between-peers, membership filter on/off).

## The property's oracle — the part most worth a second pair of eyes

```
r        = ids in the store passing `filter`, minus self, minus `exclude`
perSide  = min(max(count, 0), r)
anchorInR = anchor sits exactly on an entry that is present, passes the filter,
            is not self and is not excluded
expected = (count <= 0 || r === 0) ? 0
         : min(anchorInR ? 2*perSide - 1 : 2*perSide, r)
```

Two claims hold it up, both worth checking rather than taking on trust:

1. **Each side yields exactly `min(count, r)`.** If the matching population is at least `reach`, the
   walk returns `reach` ids, the drop removes at most `1 + |exclude|`, so at least `count` survive
   and the trim makes it exactly `count` — and `r >= count` there too. If the matching population is
   below `reach`, the walk laps and returns *every* matching id, so exactly `r` survive the drop and
   the trim gives `min(count, r)`.
2. **The `- 1` and the cap.** An entry sitting on the anchor heads *both* sides, so the union loses
   one. The two sides walk opposite directions from the anchor, so they can only overlap beyond that
   by meeting on the far side — at which point they cover the whole reachable set, which is what
   `min(…, r)` expresses. There is no intermediate case where overlap exceeds 1 but the union is
   below `r`; if you disagree, that is the finding.

The property also asserts no duplicates, self never present, no excluded id present, and every
returned id both present in the store and passing the filter. It **tallies its own generated
distribution** and fails if any of four regions was never reached: anchor-on-a-reachable-peer,
ring-smaller-than-`count`, filtered, unfiltered — following the idiom in `test/nexthop-cost.spec.ts`
and `test/peer-discovery.spec.ts`, so a green run cannot be green vacuously.

## Known gaps — treat these as the starting points, not the finish line

- **The helper is still unused by any call site.** That is deliberate and by design;
  `implement/23.05-ring-walk-migrate-call-sites` migrates the copy-pasted idioms onto it. Nothing
  here proves the helper is *correct for the callers*, only that it does what it says.
- **The oracle is derived, not independently implemented.** It is arithmetic reasoned from the
  store's walk semantics (recorded above), not a second walk written from scratch. If the reasoning
  in claim 2 is wrong, the property is wrong in the same direction as the code and would stay green.
  A brute-force oracle — enumerate the ring in both directions and take prefixes — would be
  independent; it was not written.
- **The property's rings are small (1–20) and coordinates are first-byte only.** Real coordinates are
  32 random bytes. Ordering is all that matters to these walks, so the reduction is sound, but
  nothing here exercises coordinate *decoding* or the 32-byte width guard at the store's write seam.
- **`filter` purity is assumed, never tested.** The store's lapped-walk exit relies on a pure
  predicate and the helper's doc comment says so; every generated case passes either `isLiveMember`
  or nothing. An impure predicate is untested territory.
- **No test drives a `dead` peer through the filter** — the membership case only exercises the
  `membership` half of `isLiveMember`, not the `state !== 'dead'` half. Cheap to add.
- **`interleave`'s unequal-length branch remains uncovered**, unavoidably — see the equal-length
  bullet above. If a reviewer finds a way to reach it through the public function, that is a real
  finding about the equal-length claim, not about the test.
