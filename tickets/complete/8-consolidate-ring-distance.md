----
description: The node now measures how close two peers are using true distance around the ring everywhere, instead of a bit-trick metric that treated peers sitting next to each other across the ring's wrap-around point as maximally far apart.
files: packages/fret/src/ring/distance.ts, packages/fret/src/selector/next-hop.ts, packages/fret/src/store/relevance.ts, packages/fret/src/service/payload-heuristic.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/index.ts, packages/fret/test/ring-wrap-distance.spec.ts, packages/fret/test/ring.properties.spec.ts, packages/fret/test/pick-anchors.spec.ts, packages/fret/test/seed-new-peers.spec.ts, docs/fret.md
----

## What shipped

`minDistance` is the real metric: `min(clockwiseDistance(a,b), clockwiseDistance(b,a))`. `xorDistance`
is deleted, including its `index.ts` re-export, so no second metric remains to reach for.

Three decision points moved off XOR onto it: next-hop selection (both the cost path and the legacy
connected-first path, which `pickAnchors` reaches transitively), `normalizedLogDistance` feeding the
relevance KDE, and `distToKey` feeding `shouldIncludePayload`. Comments and `docs/fret.md` were reworded
to match, with a "one metric, everywhere" bullet under *Identifier space and hashing*.

The review pass then consolidated the two duplicate distance normalizers into one shared helper,
made the byte comparator length-safe, corrected an over-strong claim about the metric's range, and
added an independent oracle plus edge-case coverage to the property suite.

## Review findings

### Checked

Full implement diff read first (`git show 3b26941`), then every source file it touched at head, plus
the callers it did not touch (`fret-service.ts` anchor/route paths, `payload-heuristic.ts`,
`cohort.ts` ring walks) to confirm nothing else still assumed the old metric's properties. A repo-wide
`xor|XOR` grep confirms the only remaining mentions are in `docs/review.html` (a historical review
record, deliberately left as-is) and in test comments explaining what the new vectors pin down.
Angles covered: correctness at the seam and at the antipode, length/type safety of the byte
primitives, DRY across the two normalizers, allocation cost on the hot paths, comment accuracy,
doc currency, and test independence.

### Minor — fixed in this pass

- **`lexLess` was a left-aligned compare, not a magnitude compare** (`ring/distance.ts:10`). It read
  `a[i] ?? 0` from index 0, so a 16-byte operand was read as a 32-byte one scaled by 2^128. Safe as
  `minDistance` called it (both arcs are `max(a.length, b.length)` wide), but it is exported publicly
  and `next-hop.ts` compares a `minDistance` result against `computeNearRadius`'s fixed 32 bytes.
  This was the handoff's own third known gap. Fixed by right-aligning the walk, which matches
  `clockwiseDistance`'s arithmetic and is byte-for-byte identical for equal-length inputs — the case
  every current caller hits. No ticket filed: `fix/11-coord-length-validation` already owns the
  upstream guard that keeps wrong-length coordinates out of the store, and this makes the comparator
  correct regardless.
- **`equalBytes` (`next-hop.ts`) returned `false` for any length mismatch**, the same class one level
  down. Re-expressed as `!lexLess(a,b) && !lexLess(b,a)` so one rule governs both.
- **Two copies of the same normalizer.** `normalizeDistance` in `next-hop.ts` and the body of
  `normalizedLogDistance` in `relevance.ts` computed the identical leading-zero-bit fraction with two
  different implementations (`Math.clz32` vs `Math.log2`) and had picked up two near-identical new
  comments in this diff. Both now call one exported `normalizedLogMagnitude` in `ring/distance.ts`, so
  routing and the relevance model read the ring at the same resolution by construction rather than by
  coincidence. `relevance.normalizedLogDistance` survives as the two-coordinate wrapper its callers use.
- **The stated range ceiling was wrong at the antipode.** The comments and `docs/fret.md` asserted that
  x "tops out at 1 − 1/256 ≈ 0.996". A distance of exactly 2^255 has its top bit set, so it yields zero
  leading zero bits and x = 1.0 exactly. Reworded in all three places to say the maximum is reached
  only by an exactly antipodal pair. Behaviour was already correct; only the claim was overstated.

### Test gaps — closed in this pass

The implementer's `ring.properties.spec.ts` block had a soft spot: "is the smaller of the two arcs"
re-derives the answer from `clockwiseDistance` and `lexLess`, the very functions under test, so a bug
in either would satisfy it. Added:

- `minDistance` against an **independent BigInt oracle** that shares no code with `src/ring/`.
- Triangle inequality — a metric property neither the old nor the new suite asserted.
- **Exact antipode** from both directions: the one value the "never exceeds 2^255" property can only
  approach, never generate.
- `lexLess` right-alignment: a property equating short-operand comparison with explicit left-padding,
  plus the concrete `[0x01]` vs full-width `2` vector that fails under the old implementation.
- `normalizedLogMagnitude`: zero, antipode, bounds, the sub-1 cap for non-antipodal pairs (pinning the
  corrected doc claim), and monotonicity in magnitude.

### Major — none new

The handoff's first known gap ("no end-to-end routing benchmark") is real and was verified, but it is
not a new ticket: `plan/24-sim-router-realism` already owns that site. Nothing under
`packages/fret/test/simulation/` imports `minDistance`, `clockwiseDistance`, or `chooseNextHop` —
the simulator reimplements hop choice against its own global view — so its 90%-success threshold would
have reported the same number had the metric been left broken. Appended as an arm to that ticket
rather than re-filed.

Two corrections to the handoff along the way: the simulator does exercise *a* router (the churn
scenario asserts 20 attempts, not the `routingAttempts: 0` the handoff reported); the problem is that
it is not the shipped one. And the handoff's `lexLess` gap was filed as "worth a look" — it was a real
latent defect and is fixed above, not deferred.

### Tripwires — parked at the code site, not filed

- `ring/distance.ts:50` — `minDistance` allocates both arcs to discard one, on a path walked per
  routing candidate and per relevance update, where XOR allocated one. Not measured as a problem; the
  in-place alternative is noted for whoever sees distance in a profile.
- `payload-heuristic.ts` (`computeNearRadius`) — the radius clamps to 2^256 − 1 while ring distance
  can never exceed 2^255, so below roughly n_est ≈ 2·β·k (≈60 at the defaults) every candidate reads
  as "near" and the cost path collapses to pure strict distance with no connected-first bias. That is
  arguably the right reading for a ring that small, and XOR behaved identically, so it is not a
  regression — recorded with the arithmetic and the fix direction.

### Considered and not acted on

- **Public API break.** `xorDistance` is gone from `src/index.ts` with no deprecation. AGENTS.md states
  backwards compatibility is not yet a concern; leaving a second metric exported would defeat the
  ticket's purpose. Accepted as-is.
- **The `normalizeDistance` ceiling was reasoned about, not measured** (handoff gap 2). With the
  corrected range statement and `test/seed-new-peers.spec.ts`'s sparse-region test still green, the
  remaining question is the *shape* of the sparsity-bonus distribution, which needs a calibration
  harness rather than an assertion. `plan/9-relevance-scoring-tests` is the existing home for that
  work; no new ticket.
- **Eviction ordering across the seam** (handoff gap 5) — a peer's relevance can now differ at the same
  coordinate. The KDE consumes x as a relative position and the bonus is clamped to [0.7, 1.8], so
  this shifts victim ranking rather than breaking it; it belongs with the calibration work above.

## Validation

```
cd packages/fret
npx tsc --noEmit      # clean
yarn build            # exit 0
yarn test             # 361 passing, 0 failing (~4m)  [was 352 before this pass]
```

No lint step exists in this repo (`yarn format` is off-limits per AGENTS.md — no prettier config, it
would rewrite every file against the house tab style). `yarn check` — typecheck + build + test — is the
gate, and all three arms are green. No pre-existing failures surfaced;
`tickets/.pre-existing-error.md` was not written.
