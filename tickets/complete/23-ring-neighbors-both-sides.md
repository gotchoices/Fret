---
description: The shared helper that finds a peer's ring neighbors on both sides now has a test suite, reviewed and strengthened so the tests check which peers come back rather than only how many.
files: packages/fret/test/ring-walk.spec.ts, packages/fret/src/service/ring-walk.ts, docs/fret.md
---
`ringNeighborsBothSides` returns the `count` ring neighbors on each side of a coordinate,
self- and exclude-free, interleaved `s1, p1, s2, p2, …`. It landed untested in a prior run; the
implement stage added `packages/fret/test/ring-walk.spec.ts`. This review pass audited that suite,
strengthened its property test, closed two coverage gaps, and corrected the design document.

`src/service/ring-walk.ts` was read closely and needed no change — the helper is correct as
shipped (see *What was checked* below for the argument, which was verified rather than assumed).

## Final state

- `packages/fret/test/ring-walk.spec.ts` — **17 passing**, 50 ms (was 16).
- `cd packages/fret && npx tsc --noEmit` — clean.
- `docs/fret.md` — the protected-set bullet now describes the current reality.

## Review findings

### Fixed in this pass (minor)

- **The property asserted cardinality, not identity.** The generated case computed a single
  expected *size* from the store's walk arithmetic and asserted `out.length` against it, plus
  set-shaped properties (no duplicates, no self, no excluded id, every id present and matching).
  Nothing pinned **which** peers came back or in what order — a helper that walked the two
  directions the wrong way round, or emitted the predecessor side first, returns exactly the same
  count and would have stayed green across all 500 runs. The example-based cases pin ordering, but
  only on five fixed fixtures.

  This is also the ticket's own top stated gap ("the oracle is derived, not independently
  implemented"), and both halves are the same fix. Added `expectedWindow`, a brute-force oracle
  that enumerates the ring **by index** in both directions from the anchor and takes the first
  `perSide` reachable ids per side, then weaves them. It is derived from the fixture's ring layout
  (`coordAt(i) = i * 7` is monotone, so index order *is* ring order), not from the helper's
  over-fetch arithmetic — so it is independent in the sense the ticket asked for. The property now
  `deep.equal`s the whole array against it.

  The arithmetic oracle is **kept and cross-checked** rather than deleted: the two are asserted
  equal in size on every run, so if the arithmetic reasoning (the ticket's "claim 2", the `- 1` for
  an anchor-seated entry and the cap at the reachable population) is wrong, the two disagree
  instead of being wrong in the same direction. They agree across 500 runs, which retires the
  gap rather than merely documenting it. That reasoning was also checked by hand before the code
  was written: for an anchor sitting on a reachable entry the two sides are `{0..perSide-1}` and
  `{0} ∪ {r-perSide+1..r-1}` in clockwise index order, whose union is `2·perSide - 1` exactly while
  `2·perSide - 1 < r`, and the whole reachable set once `2·perSide - 1 ≥ r`; there is no
  intermediate case, which is what the cap expresses.

- **The `state !== 'dead'` half of `isLiveMember` was never driven** — the membership case only
  demoted `membership` to `foreign`, so a filter that dropped the liveness half entirely would have
  stayed green. Added a sibling case marking `p1/p2/p19` `dead` via `store.setState` and asserting
  the same window fills from further out. Flagged as "cheap to add" by the ticket; it was.

- **`docs/fret.md` was stale in two ways at line 42.** It said reconciling the self-anchored
  off-by-one onto one helper "is `plan/23-fret-service-decomposition` item (a)" — a ticket that no
  longer exists (it was split into `23.05` / `23.1` / `23.2`), and a statement that no longer
  matches reality now that `ringNeighborsBothSides` has shipped. Rewritten to say the helper
  exists, state its `count + 1 + |exclude|` over-fetch, and — the load-bearing half — say plainly
  that **no call site uses it yet**, so every behavior the bullet describes is still what the code
  does until `implement/23.05-ring-walk-migrate-call-sites` lands. A reader who took the old text
  at face value would have believed the off-by-one was already retired.

### Tripwires recorded, not filed

- **The `successorSide` / `predecessorSide` even-odd helpers are only valid while the two sides are
  disjoint.** Once the sides overlap, `interleave`'s dedup drops an id mid-list and every later
  index flips parity, so the two helpers silently report nonsense. Every case that uses them today
  anchors on a window narrower than the ring, and the two overlapping cases correctly assert on the
  whole list instead — so this is fine now and only bites if someone adds an overlapping case and
  reaches for the convenient helper. Parked as a `NOTE:` at the helpers' definition in
  `test/ring-walk.spec.ts` saying to assert the full array in that situation.

### Checked, found sound, no change

- **The helper's over-fetch arithmetic.** Verified both directions rather than trusting the doc
  comment: with matching population `M ≥ reach`, the walk returns exactly `reach` ids and the drop
  removes at most `1 + |exclude|`, so at least `count` survive *and* `r ≥ count` holds there too;
  with `M < reach` the walk laps and returns every matching id, so exactly `r` survive and the trim
  yields `min(count, r)`. Each side therefore yields `min(count, r)` in both regimes, which is what
  makes the equal-length invariant (and hence the unreachable `interleave` branch) true.
- **Exclusions consuming walk slots.** Checked the case the `+ exclude.size` term exists for and
  the one it might not cover — excluded ids landing on *both* sides at once. Each side over-fetches
  the full `exclude.size`, so neither starves; the suite's blanket-one-side case is the right
  fixture and no extra one is needed.
- **Filter passed *into* the walk rather than applied to the result.** Already pinned by the
  membership case: the two peers nearest the anchor on the successor side are non-members and the
  window fills from further out, which a post-filter could not produce.
- **The interleave dedup on overlap** (wrap-around at `count` 4) and the wrap-seam window at
  `count` 2 — both correct, and the sorted-array comparisons they use are stable (the `c00 … cF0`
  fixture ids sort the same by code unit as by ring position).
- **Source hygiene.** One new test file, now 320 lines, one `describe` per behavior, no helper
  longer than 25 lines, comments state *why* a case exists rather than restating the assertion.
  `import { DigitreeStore, type PeerEntry }` uses the inline type modifier, which
  `verbatimModuleSyntax` requires. No change warranted.

### Not filed, and why

- **The helper is still unused by every call site.** Real, deliberate, and already owned end-to-end
  by `implement/23.05-ring-walk-migrate-call-sites`. Filing anything here would be a duplicate.
- **`filter` purity is assumed, never tested; the property's rings are small and single-byte;
  `interleave`'s unequal-length branch is unreachable.** All three are stated honestly in the
  implement handoff and all three are properties of the *store's* contract or of the fixture
  reduction, not defects in this diff. Purity is a documented precondition of
  `neighborsRight`/`neighborsLeft` and belongs to the store's own suite; coordinate decoding and
  the 32-byte width guard are exercised at the store's write seam by
  `test/digitree.invariants.spec.ts`; and the unreachable branch is now pinned from the other side
  by the equal-length invariant plus the strengthened property. No ticket.

## Gate

- `cd packages/fret && npx tsc --noEmit` — **clean**.
- `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js
  "test/ring-walk.spec.ts" --timeout 30000` — **17 passing, 0 failing**, 50 ms.
- **The full suite was not re-run in this pass.** A `BUDGET_WARNING` arrived mid-review, and the
  run-workflow rule is to wrap up rather than continue spending. The implement stage ran
  `yarn test` green at **1154 passing, 0 failing** on the commit this pass started from, and this
  pass's diff is one test file plus one prose line in `docs/fret.md` — nothing importable by
  another spec changed, so the blast radius outside `test/ring-walk.spec.ts` is nil. Stated as a
  gap rather than papered over. No `.pre-existing-error.md` was written; nothing failed.
