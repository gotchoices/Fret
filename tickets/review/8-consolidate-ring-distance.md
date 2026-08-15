---
description: The node now measures how close two peers are using true distance around the ring everywhere, instead of a bit-trick metric that treated peers sitting next to each other across the ring's wrap-around point as maximally far apart.
files: packages/fret/src/ring/distance.ts, packages/fret/src/selector/next-hop.ts, packages/fret/src/store/relevance.ts, packages/fret/src/service/payload-heuristic.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/index.ts, packages/fret/test/ring-wrap-distance.spec.ts, packages/fret/test/ring.properties.spec.ts, packages/fret/test/pick-anchors.spec.ts, packages/fret/test/seed-new-peers.spec.ts, docs/fret.md
difficulty: medium
---

## What landed

`minDistance` is now the real thing — `min(clockwiseDistance(a,b), clockwiseDistance(b,a))`, picked with
`lexLess` (both arcs come back `max(a.length, b.length)` bytes wide, so that byte compare is a magnitude
compare). `xorDistance` is deleted outright, including its `index.ts` re-export, so there is no second
metric left to reach for.

Three decision points moved from XOR to ring distance:

- `selector/next-hop.ts:154` (cost path) and `:203` (legacy connected-first path). `pickAnchors`
  in `fret-service.ts:1687/1689` goes through the legacy path and is fixed transitively.
- `store/relevance.ts:36` — `normalizedLogDistance`, which feeds the KDE sparsity model.
- `service/fret-service.ts:2016` — `distToKey`, which feeds `shouldIncludePayload`.

Comments that named XOR or claimed "1 = maximally far" were reworded at `next-hop.ts:76-79`,
`relevance.ts:29-34`, and `payload-heuristic.ts:22/58`. `docs/fret.md` gained a "one metric, everywhere"
bullet under *Identifier space and hashing* and a ring-distance note under the relevance formula.

## Use cases to validate

**The seam.** `test/ring-wrap-distance.spec.ts` is the regression file. Its vectors: key `0x80` + 31 zero
bytes; `SELF` = `0x7f` + 31 `0xff` bytes (one arc-unit counter-clockwise of the key); `RIVAL` = `0x8010` +
zeros (2^244 clockwise). Five assertions — the two arc lengths, the legacy next-hop pick, the cost
next-hop pick, `shouldIncludePayload`, and `normalizedLogDistance`.

I verified this file fails 5/5 against the old XOR implementation and passes 5/5 against the new one, by
temporarily swapping `distance.ts` back to the XOR body and re-running. The source file was restored
immediately; nothing from that check is in the tree.

**Ties are now reachable.** XOR distance to a fixed target was injective; ring distance is not — a peer
`d` clockwise and a peer `d` counter-clockwise of the key sit at the same arc length. `betterByDist`
already breaks that on lexicographic peer id, which is what `docs/fret.md` prescribes. A stale NOTE in
`pick-anchors.spec.ts` asserted the tie-break was *unreachable*; that note is replaced by an actual
equidistant test (`breaks an equidistant tie by peer id`).

**Properties.** `test/ring.properties.spec.ts` swapped its `xorDistance` block for a `minDistance` one:
symmetry, self-distance zero, identity of indiscernibles, plus the two XOR never had — `d ≤ 2^255` and
`d = min(cw, ccw)`.

## Validation run

```
cd packages/fret
npx tsc --noEmit      # clean
yarn build            # exit 0
yarn test             # 352 passing, 0 failing (~4m)
```

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Known gaps — read these before signing off

- **No end-to-end routing benchmark.** Every next-hop decision in the system changed metric, and the
  evidence that this is an improvement is five hand-built seam vectors plus a green suite — not a
  measured routing-success or hop-count comparison. The simulation harness does not close this: the
  N=100 churn scenario reports `routingAttempts: 0`, so `test/simulation/` exercises the store and
  topology but never the router. If you want confidence beyond "the arithmetic is right", a
  routing-success sweep over a seeded ring is the thing to build, and it does not exist today.

- **The `normalizeDistance` / `normalizedLogDistance` ceiling was reasoned about, not measured.** Both
  now top out at 1 − 1/256 ≈ 0.996 instead of 1.0. The upstream ticket's argument — KDE centers span
  0.042–0.958, values are used as relative positions — is what I acted on; I documented it in comments
  and in `docs/fret.md` but did not empirically check that the sparsity bonus distribution is unchanged
  in shape. `test/seed-new-peers.spec.ts`'s sparse-region test still passes, which is weak evidence.

- **`lexLess` is a left-aligned compare, not a length-aware magnitude compare.** It reads
  `a[i] ?? 0` from index 0, so comparing a 32-byte value against, say, a 16-byte value would be
  wrong. `minDistance` is safe because both arcs are `max(a.length, b.length)` wide, and every
  in-repo caller passes 32-byte coordinates — but nothing enforces that at the type level. Worth a
  look at whether that deserves a guard or is fine as-is.

- **Public API break.** `xorDistance` is gone from `src/index.ts`. Per AGENTS.md backwards
  compatibility is not a concern yet, so I did not deprecate-then-remove.

- **Untested paths that changed behavior silently.** `store/relevance.ts` feeds eviction victim
  selection; a peer's relevance can now differ from before at the same coordinate. No test asserts
  eviction ordering across the seam. Similarly `computeNearRadius` output is now compared against a
  metric with half the range, which widens the effective near-zone in ring terms — intended (the
  near-zone was always meant to be an arc), but not directly asserted anywhere except the payload
  test in the new spec file.
