description: Finished the review of a batch of test-suite cleanup edits — applied four small fixes the audit had found, and confirmed the type-check and full test suite pass.
files: packages/fret/test/helpers/ring.ts, packages/fret/test/helpers/ring.spec.ts, packages/fret/test/size-estimator.spec.ts, packages/fret/test/simulation/fret-sim.ts, packages/fret/test/churn-scenarios.spec.ts
----
Second half of the review pass over the `cleanup-tests-core-mechanical` implement diff
(`f3111bd`). The first session finished the audit and ran out of budget before applying fixes;
this session applied all four and re-ran the gate.

## Review findings

### Checked and found clean (audit, carried forward from the first session)

- **`test/helpers/libp2p.ts` `stopAll` copy-before-reverse** — correct. No caller depended on
  the in-place mutation of the array it was handed.
- **Deletion of `test/cohort.assembly.spec.ts`** — confirmed vacuous, so the deletion loses
  nothing. The spec upserted 20 peers and never called `setMembership`, so every peer stayed
  `unknown`, the member-only ring views returned an empty cohort, and its single assertion
  (`new Set(cohort).size === cohort.length`) held trivially on the empty array. The behavior it
  claimed to cover — two-sided alternation, no duplicates, exclusions, small-ring overlap — is
  covered for real by `test/cohort.properties.spec.ts` (`assembleCohort invariants`, 9 cases).
- **Deletion of `test/selector.connected-first.spec.ts`** — confirmed a byte-for-byte duplicate
  of the `falls back to legacy mode without nearRadius` case at `test/nexthop-cost.spec.ts:143`
  (same two coordinates, same tolerance of 1, same expected winner).
- **The semantic-equivalence claim for the local `bigintToCoord` deleted from
  `test/simulation/fret-sim.ts`** — holds. All four call sites pass a value already inside
  `[0, 2^256)`, so the shared `toCoord`'s extra modulo reduction is a superset and never a
  change: `randomCoord` (`rng.nextBigInt(256)`), the gaussian-spread helper (explicit
  `% ringSize` plus a negative fixup), the skewed-placement helper (`val % ringSize`), and
  `nearRadiusFor` (clamped at `1n << 255n`).
- **Dangling references to the three deleted files** — none anywhere in the repo (source, docs,
  `package.json`, `AGENTS.md`), by grep across all `.md`/`.ts`/`.json`. The only hits are inside
  `tickets/`.
- **Now-unused imports or consts left behind in the touched specs** — none. `RING`/`addMod`/
  `toBigInt` in `ring.properties.spec.ts`, `RING_SIZE` in `size-estimator.spec.ts` and
  `COORD_BYTES` in `seed-new-peers.spec.ts` all still have live uses. Checked by hand, because
  `tsconfig.json` sets no `noUnusedLocals` and so a green type-check does not prove it.

### Minor findings — all four fixed in this pass

- **`ringOffset`'s doc comment described an implementation that no longer existed.** The body had
  been rewritten to `toCoord(toBigInt(base) + BigInt(delta))` while the comment still explained a
  hand-rolled byte loop with carry propagation, plus a paragraph of history about the helper it
  replaced. It also asserted offsets are "meant to be *near* a target — a handful of units",
  which the same commit falsified (`pick-anchors.spec.ts:128` passes `1n << 200n`). Rewritten to
  state what the function does now — exact 256-bit sum mod 2^256, any magnitude, negative deltas
  fine, input not mutated — keeping only the part of the history that warns a future reader off
  re-hand-rolling it. It also now records the one behavior change: the old body returned
  `new Uint8Array(base.length)` and the new one always returns `COORD_BYTES`, which is inert
  today because every caller passes a 32-byte coordinate.
- **The widened `number | bigint` signature had no test.** Every case in the helper's own spec
  passed a `number`; the bigint arm — the one behavioral change in the whole commit — was
  exercised only incidentally by `pick-anchors.spec.ts`, whose assertions are about anchor
  ordering rather than about the offset. Added a bigint-delta property to
  `test/helpers/ring.spec.ts` whose magnitude is floored at 2^54, so every run is a value a
  `number` cannot represent exactly and the arm is provably exercised rather than merely
  reachable, plus a case pinning that a `number` delta and the equivalent `bigint` delta produce
  identical bytes.
- **`refMinDistance` had become an untested shared oracle.** It moved out of
  `ring.properties.spec.ts` into `test/helpers/ring.ts`, where it is the independent reference
  that `ring.properties.spec.ts:89` checks the shipped `minDistance` against — so a bug in it
  would silently let that property pass against a wrong answer. Added hand-computed vectors
  (self-distance 0; adjacent 1; `ZERO` to all-`0xff` is 1, the short way across the wrap, not
  2^256−1; antipodal is 2^255) and a symmetry-plus-upper-bound property. Deliberately not
  cross-checked against `src/ring/distance.ts` — independence from that module is the entire
  reason the oracle exists.
- **One function was imported under two alias spellings.** `toCoord` was `bigIntToCoord` in
  `test/size-estimator.spec.ts` (17 call sites) and `bigintToCoord` in
  `test/simulation/fret-sim.ts` (4 call sites), so someone grepping `toCoord` found neither file
  — the naming confusion this ticket set out to retire. Both renamed to plain `toCoord`; neither
  file had a competing local `toCoord`. A stale comment at `test/churn-scenarios.spec.ts:337`
  still named the deleted local `bigintToCoord` and now points at `test/helpers/ring.ts`.

### Major findings

**None.** Stated explicitly rather than left silent: the diff is a test-only cleanup — three
deletions, one helper body rewritten to delegate to an existing tested helper, and a set of
import renames. It touches no `src/` file and changes no shipped behavior, so there is no
production code site for a major finding to attach to. Every deletion was verified to lose no
coverage (above), which is the one way a cleanup of this shape could have done real damage. No
new `fix/` or `backlog/` tickets were filed.

### Tripwires

**None identified.** No concern in this diff was of the "fine now, only matters if X later"
shape — the four findings were all definite and all fixed inline, and the deletions are
unconditional (the coverage either existed elsewhere or it did not; it did).

### Accepted tradeoffs

No `NOTE:` accepted-tradeoff marker sits at any site this diff touches, so nothing was
re-litigated and nothing was declined.

## Verification

From `packages/fret/`, after the changes above:

- `npx tsc --noEmit` — clean.
- `yarn test` — **1138 passing, 0 failing** (4m). Up from the 1131 the pre-change baseline
  reported; the 7 new cases are the 2 bigint-arm and 5 `refMinDistance` tests added here.

There is no lint step in this repo — `yarn check` (typecheck + build + test) is the gate, and
`yarn format` must not be run (no prettier config; it would rewrite every file against the house
tab style). See `AGENTS.md`.

One stale reference to the old `bigIntToCoord` alias survives in
`packages/fret/dist/test/helpers/ring.d.ts`, a checked-out build artifact that predates even the
current `ring.ts` source comment. It is regenerated by `yarn build` and was left alone.
