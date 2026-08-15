description: The network-size estimate used to read as low as 100 for a 2000-node network, and its companion confidence number was stuck at one constant value; both now respond to the actual shape of what a node knows. A related averaging mistake that depressed the blended confidence is fixed too.
files: packages/fret/src/estimate/size-estimator.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/index.ts, packages/fret/test/size-estimator.spec.ts, packages/fret/test/seed-new-peers.spec.ts, packages/fret/test/ring-membership.spec.ts, docs/fret.md, docs/threat-analysis.md
----

## What landed

Three defects in the size-estimate path, plus the docs that describe it.

1. **Gap population is now the successor/predecessor window.** `estimateSizeAndConfidence`
   swapped its trailing positional `filter` for a `SizeEstimateOptions` bag carrying `filter`
   and `selfCoord`. With `selfCoord`, gaps come from the S/P window around self (signed offsets
   re-centred on self, so a window straddling coordinate 0 stays one contiguous run) and the
   arithmetic **mean** drives `n = 2^256 / meanGap`. Without it, the whole-store consecutive-gap
   population and **median** remain as a documented degraded fallback. The wrap-around gap is
   excluded from both populations.
2. **Confidence is the relative standard error of the mean gap.** `minGap / maxGap` (measured
   4.4e-5 on a random ring, so confidence was pinned at 0.5 for every node knowing ≥ 2m peers)
   replaced by `dispersionFactor`: `cv = sd/mean` floored at 1, `rse = cvEff/√G`,
   `dispersion = clamp(1−rse)`; `confidence = clamp(0.5·sizeFactor + 0.5·dispersion, 0.05, 1)`.
3. **Service confidence average divides by the recency-weight sum**, not the observation count.
   Four agreeing observations at 0.5 spread over the window previously reported 0.23.

Call sites updated at `fret-service.ts` 1529, 1697, 1872, 2039; `index.ts:134` exports
`SizeEstimateOptions`.

## Review findings

Read the implement diff (`7bce01d`) before the handoff summary, as required.

### Fixed in this pass (minor)

- **The S/P window was two gaps short of the window it claims to be.** `windowGaps` asked each
  side for `m`, but a walk anchored exactly at `selfCoord` returns self as its own first result
  on *both* sides — `ceilPath` seeks `coord|\x00` and `floorPath` seeks `coord|￿`, so both
  land on self's entry. Measured directly against `DigitreeStore` on a 100-peer uniform ring at
  m=8: `neighborsRight` returned `[p50..p57]` and `neighborsLeft` returned `[p50,p49..p43]` —
  15 distinct points, **14 gaps**, i.e. 7 successors and 7 predecessors, not the 8+8 that
  docs/fret.md and the design's `|S(p)| = |P(p)| = m` both state. Each side now asks for `m + 1`,
  giving 17 points / 16 gaps. `size-estimator.ts` (`windowGaps`) and the docs bullet both say
  why. Consequence was small (2 of 16 samples lost, confidence cap 0.866 instead of 0.875) but
  it made the code disagree with its own documentation.
- **`docs/threat-analysis.md` §2.4 was left describing the estimator the change deleted** — the
  ticket's `files:` never listed it. It claimed `n_est = 2^256 / median_gap` over "known peers"
  and listed "Median gap (not mean) provides some resistance to outliers" as a current
  mitigation. Both are now false on the live path: no in-service call site takes the median
  fallback. Rewritten, including the cost shift (below) and a corrected `reportNetworkSize` line
  reference that had also drifted.
- **`~0.57 at G = 2` was arithmetically wrong** in both the `dispersionFactor` doc comment and
  the docs/fret.md confidence block. `0.5 + 0.5·(1 − 1/√2) = 0.646`, not 0.57 (0.577 is `1/√3`).
  Corrected to ~0.65 in both, and the G = 16 exemplar now says it is a full S/P window at m = 8,
  which the `m + 1` fix above makes true.
- **Stale test comment.** `size-estimator.spec.ts` Phase 3 monotonicity explained itself in terms
  of "both confidence factors (sizeFactor, minGap/maxGap)" and "shrinks the single wrap gap" —
  all three referents deleted by this change. Rewritten to the actual reason it holds.
- **`sources` was reviewed** (the handoff flagged it as unreviewed, three lines from the fixed
  denominator). It is not a defect but the name over-promises: it counts contributing
  observations, and repeated snapshots from one peer each add an entry, so it is not a count of
  distinct observers. Nothing branches on it; only tests read it, as a monotone counter. Left
  as-is with a one-line clarifying comment at the site rather than renaming a public interface
  field for a diagnostic.

### Filed as evidence on an existing ticket (major)

- **The change lowered the cost of manipulating `n_est`, and nothing said so.** The site-claim
  grep found `backlog/plan/3-size-consensus-bounded-gossip` already owns
  `src/estimate/size-estimator.ts` and threat-analysis §2.4, so this is an arm on that ticket,
  not a new one. Two mechanisms: the population shrank from up to 2048 store entries to the
  `2m + 1` coordinates around the node (17 at m = 8), so entries outside the window no longer
  contribute at all; and the mean has a breakdown point of zero where the median needed roughly
  half the population, so each admitted Sybil moves the estimate by ~`1/2m` (~6%) and order-`m`
  of them move it 2x. Same precondition as an eclipse, so not an independent attack — but the
  local statistic now has no outlier resistance to fall back on, which is an argument *for* that
  ticket. Recorded there and in threat-analysis §2.4; that ticket's own `tradeoffs:` line had
  guessed these fixes might make local estimates good enough, which this contradicts.

### Test gaps closed (three of the six the handoff listed)

The handoff was honest that its tests were a floor. Closed:

- **Phase 5 ran one seed per (N, far) pair.** Added a 20-seed sweep at N=2000 / 32 far peers.
  Measured worst relative error across those seeds is **0.545**, recorded in the test, and the
  sweep asserts `< 0.75` — tighter than the 2x per-case bound, loose enough not to pin a draw
  (the mean of 2m exponential gaps has a ~25% coefficient of variation).
- **The eclipse blind spot had a `NOTE:` but no test.** Added
  `KNOWN BLIND SPOT: an eclipsed neighbourhood scores high confidence on a wrong n` — self plus
  2m neighbours evenly spaced across 1/1000th of the ring yields `n ≈ 17000` at confidence
  0.875. It asserts the *wrong* behaviour deliberately, and says in-comment that a future defence
  should make it fail and be rewritten, never loosened.
- **`getNetworkSizeEstimate` before `start()` was reasoned, not exercised.** Added a test that
  constructs the service without starting it, asserts `cachedSelfCoord` is still null, populates
  the store directly and confirms the whole-store fallback returns an exact estimate (64 peers,
  evenly spaced → 64) rather than throwing or reporting zero.

Left open, deliberately: no end-to-end assertion that the corrected `n` improves routing
(`shouldIncludePayload` / near-radius / next-hop against corrected values), and no test for the
stated eclipse defence (corroboration via `reportNetworkSize` / `calibrateSizeFromSnapshot`).
Both are consumer-level work well outside an estimator ticket, and the second is the substance
of `3-size-consensus-bounded-gossip`, which now carries the note.

### Tripwire recorded

- **`estimateSizeAndConfidence` materializes the whole store on every call, and on the primary
  path only uses its length.** `store.list()` walks and allocates every entry; on the `selfCoord`
  path the gap population comes from the S/P window instead, so the list survives only to supply
  `count` for `sizeFactor`. That is an O(store) allocation per call and the estimator runs once
  per inbound `maybeAct`. Fine at capacity 2048 and today's message rates. `NOTE:` at the site
  in `size-estimator.ts` naming the fix if either grows: a `countWhere(filter)` on the store,
  building the list only for the fallback. Conditional, so not a ticket.
- The pre-existing local-dispersion `NOTE:` from the implement stage stays where it is
  (`dispersionFactor` doc comment) and is now backed by the test above.

### Checked and clean — explicitly, not silently

- **Wrap-around and signed-offset arithmetic.** Hand-checked the boundary cases (N=2 antipodal,
  N=3 and N=4 evenly spaced, a neighbour at exactly `2^255`, and a window wider than half the
  ring). `(coord − self) % RING`, negative-correct, then folded to `(−2^255, 2^255]`, is sound;
  the `d > HALF_RING` comparison is the right strictness. The wrap test in Phase 5 pins it.
- **Degenerate inputs.** Empty store, single peer, all-peers-at-one-coordinate, and a window that
  yields zero gaps all reach a defined path. Worth noting a property that makes this safe: on the
  window path offsets go through a `Set`, so distinct offsets guarantee every gap is `> 0` and
  `representativeGap > 0`, meaning the `safeGap` fallback and the `mean <= 0` guard in
  `dispersionFactor` are only ever reachable from the whole-store path.
- **Float range in `dispersionFactor`.** Gaps convert to `Number` up to ~1.16e77; squared
  deviations reach ~1.3e154 and the sum over the capacity-2048 worst case ~2.7e157, well inside
  double range. No overflow.
- **No stale call sites.** Grepped every `estimateSizeAndConfidence` reference across `src`,
  `test`, `docs`, and `tickets`; the positional-filter form is gone everywhere and `tsc --noEmit`
  is clean.
- **`README.md` and `docs/threat-rir-mitigated.md`** were checked as docs the change *might*
  have invalidated. Neither describes the estimator's mechanism — README is a feature list,
  threat-rir §2.4 speaks only to residual severity — so neither needed an edit.
- **Wrap-gap exclusion from the whole-store fallback**, the handoff's flagged deviation from the
  ticket: accepted. The measurement supporting it is in the implement handoff (whole-store `n`
  moves ≤ 0.5% for N ≥ 50) and the alternative it rejected — two populations for one function —
  would have been worse. The re-scoped N=10 assertion is likewise accepted; a 50% bound over 9
  gaps pins the seed, and the 20-seed measurement backing that is recorded in the test.
- **Source hygiene.** `size-estimator.ts` is ~175 lines across seven small single-purpose
  functions; the shared `ascending` comparator is extracted rather than repeated. No `any` added
  to `src`. Tests reach private state via `(svc as any)`, matching the file's existing style.

## Validation

- `npx tsc --noEmit` from `packages/fret/` — clean.
- `yarn build` from `packages/fret/` — clean.
- `yarn test` from `packages/fret/` — **398 passing, 0 failing** (~5m); 395 before, plus the
  three tests added above. No pre-existing failures surfaced, so
  `tickets/.pre-existing-error.md` was not written.
- One comment-only edit to `fret-service.ts` (the `sources` clarification) landed after that run;
  it changes no code.
