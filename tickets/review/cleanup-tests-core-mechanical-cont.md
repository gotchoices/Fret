description: Finish the review pass on a batch of test-suite cleanup edits — the first pass ran out of budget after auditing the changes but before applying the small fixes it found or running the test suite.
files: packages/fret/test/helpers/ring.ts, packages/fret/test/helpers/ring.spec.ts, packages/fret/test/size-estimator.spec.ts, packages/fret/test/simulation/fret-sim.ts
difficulty: easy
----
Continuation of ticket `cleanup-tests-core-mechanical` (review stage). The prior review session
read the whole implement diff (`f3111bd`) and finished the *audit*; it hit the token budget
before applying fixes or running lint/tests. Everything below is already investigated — this
ticket is the apply-and-verify half, not a re-review.

## Audit already completed (do not redo)

Verified correct, nothing to change:

- `test/helpers/libp2p.ts` `stopAll` copy-before-reverse: correct, no caller depended on the
  in-place mutation.
- Deletion of `test/cohort.assembly.spec.ts`: confirmed vacuous. It upserted 20 peers and never
  called `setMembership`, so every peer stayed `unknown`, the member-only ring views returned an
  empty cohort, and the only assertion (`new Set(cohort).size === cohort.length`) held on the
  empty array. The behavior it claimed to cover — two-sided alternation, no duplicates,
  exclusions, small-ring overlap — is covered properly by
  `test/cohort.properties.spec.ts` (`assembleCohort invariants`, 9 cases). Deletion loses nothing.
- Deletion of `test/selector.connected-first.spec.ts`: confirmed byte-for-byte duplicate of the
  `falls back to legacy mode without nearRadius` case in `test/nexthop-cost.spec.ts:143`
  (same two coords, same tolerance of 1, same expected winner).
- `test/simulation/fret-sim.ts` semantic-equivalence claim for the deleted local
  `bigintToCoord`: holds. All four call sites pass a value already in `[0, 2^256)` —
  `randomCoord` (`rng.nextBigInt(256)`), the gaussian-spread helper (explicit `% ringSize` plus
  negative fixup), the skewed-placement helper (`val % ringSize`), and `nearRadiusFor` (clamped
  at `1n << 255n`). The shared `toCoord`'s extra modulo reduction is a superset, never a change.
- No dangling references anywhere in the repo (source, docs, package.json, AGENTS.md) to the
  three deleted files. Checked by grep across all `.md`/`.ts`/`.json`; the only hits are inside
  `tickets/`.
- No now-unused imports or consts left behind in the touched specs: `RING`/`addMod`/`toBigInt`
  in `ring.properties.spec.ts`, `RING_SIZE` in `size-estimator.spec.ts`, and `COORD_BYTES` in
  `seed-new-peers.spec.ts` all still have live uses. (`tsconfig.json` sets no `noUnusedLocals`,
  so the green type-check the prior session ran does not prove this — it was checked by hand.)

## Findings to apply (all minor; all in-scope for this pass)

### 1. `ringOffset`'s doc comment now describes an implementation that no longer exists

`test/helpers/ring.ts`. The body was rewritten to `toCoord(toBigInt(base) + BigInt(delta))`, but
the comment above it still explains a hand-rolled byte loop: "the delta is added at the
*least-significant* byte (index `length - 1`) with carry/borrow propagated leftward across every
byte", plus a paragraph of history about the legacy helper it replaced. Neither describes the
current code. The comment also asserts offsets are "meant to be *near* a target on the ring — a
handful of units", which the same commit falsified: `pick-anchors.spec.ts:128` now passes
`1n << 200n`.

Rewrite it to state what the function does now — exact 256-bit arithmetic mod 2^256, any
magnitude, negative deltas fine, input not mutated — and keep only the part of the history that
still warns a future reader off re-hand-rolling this (the legacy most-significant-byte version
made "near" seeds actually land 1/128th of the ring apart, which is what made the calling specs
flaky). Aim for shorter than what is there.

Note one behavior change the comment should not claim away: the old body returned
`new Uint8Array(base.length)`, the new one always returns `COORD_BYTES`. Every caller passes a
32-byte coordinate, so this is inert today — worth a word in the comment, not a ticket.

### 2. The widened `number | bigint` signature has no test

`test/helpers/ring.spec.ts` is the helper's own spec and every single case passes a `number`
delta. The bigint arm — the one behavioral change in the whole commit — is exercised only
incidentally by `pick-anchors.spec.ts`, whose assertions are about anchor ordering, not about
the offset.

Add coverage in `test/helpers/ring.spec.ts`: extend the existing "matches BigInt arithmetic mod
2^256" property with a bigint-delta arm (`fc.bigInt` over a range that clears 2^53, so it covers
magnitudes a `number` cannot represent), and add a case pinning that a `number` delta and the
equivalent `bigint` delta produce identical bytes.

### 3. `refMinDistance` is now an untested shared oracle

`refMinDistance` moved out of `ring.properties.spec.ts` into `test/helpers/ring.ts`, where it is
the independent reference that `ring.properties.spec.ts:89` checks the shipped `minDistance`
against. Nothing tests the oracle itself, so a bug in it would silently make that property pass
against a wrong answer.

Add a few hand-computed vectors in `test/helpers/ring.spec.ts` — `refMinDistance(ZERO, ZERO)`
is 0, `(ZERO, one)` is 1, `(ZERO, ALL_FF)` is 1 (the short way round, not 2^256−1),
`(ZERO, oppositeCoord(ZERO))` is 2^255 — plus symmetry as a property. Do **not** cross-check it
against `src/ring/distance.ts`: independence from that module is the entire reason it exists.

### 4. One function, two alias spellings

`toCoord` is imported as `bigIntToCoord` in `test/size-estimator.spec.ts` (17 call sites) and as
`bigintToCoord` in `test/simulation/fret-sim.ts` (4 call sites). The aliases were kept to avoid
touching call sites, but two spellings of one helper is the naming confusion this ticket set out
to retire — someone grepping `toCoord` finds neither file. Rename both to plain `toCoord`;
purely mechanical, and neither file has a competing local `toCoord`.

## Verification required before handing off

The prior session's green run (`npx tsc --noEmit` clean; `yarn test` 1131 passing, 0 failing)
predates every change above, so it does not carry over. From `packages/fret/`:

- `npx tsc --noEmit`
- `yarn test` (full suite, foreground, no redirection)

There is no lint step in this repo — `yarn check` (typecheck + build + test) is the gate, and
`yarn format` must not be run (no prettier config; it rewrites every file against the house tab
style). See AGENTS.md.

## Output

A `complete/` ticket with a `## Review findings` section. It must carry forward both halves: the
audit results above (what was checked and found clean, with reasons — not "looks good") and the
disposition of findings 1–4. No major findings were found, so no new `fix/`/`backlog/` tickets
are expected; say so explicitly and say why rather than leaving the category silent. No
tripwires were identified either.
