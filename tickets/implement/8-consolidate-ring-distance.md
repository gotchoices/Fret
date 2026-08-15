---
description: Some parts of the node measure how close two peers are with a bit-trick metric instead of true distance around the ring, so peers that sit next to each other across the ring's wrap-around point are treated as maximally far apart — leading to wrong routing hops and payloads withheld from peers that were right next to the target.
files: packages/fret/src/ring/distance.ts, packages/fret/src/selector/next-hop.ts, packages/fret/src/store/relevance.ts, packages/fret/src/service/payload-heuristic.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/index.ts, packages/fret/test/ring.properties.spec.ts, docs/fret.md
difficulty: medium
repro: verified
---

## Summary

`docs/fret.md` defines ring distance as `d(a,b) = min(clockwise(a,b), clockwise(b,a))`. Cohort assembly
and neighbor selection honor that, because they walk the ordered B-tree in ring order. Three other
decision points do not: they call `xorDistance`, a bit-XOR metric that is unrelated to arc length on
the ring. `minDistance` in `ring/distance.ts:44-47` carries a comment claiming it computes "absolute
ring distance via XOR"; it computes neither. `clockwiseDistance` — the piece needed to do this
correctly — already exists and is otherwise unused.

Decision is already made upstream: **consolidate on true ring distance. Do not keep XOR.**

## Reproduction (verified)

Ran against `HEAD` from `packages/fret` with a throwaway script (deleted; vectors below are the whole
of it). Coordinates are 32 bytes, written most-significant byte first.

Case — top-bit seam. Key `0x80` followed by 31 zero bytes. Candidate `SELF` = `0x7f` followed by 31
`0xff` bytes, i.e. the coordinate immediately counter-clockwise of the key. Candidate `RIVAL` =
`0x8010` followed by zeros.

```
ring dist SELF →key  = 1
ring dist RIVAL→key  = 2^244  (2.83e73)
xor  dist SELF →key  = 2^256-1 (1.16e77)   ← maximally far
xor  dist RIVAL→key  = 2^244

chooseNextHop, legacy path (used by pickAnchors)          => RIVAL
chooseNextHop, cost path   (used by routeAct/iterative)   => RIVAL
shouldIncludePayload(xor(SELF,key),  n=1000, conf=0.9, k=15) => false
shouldIncludePayload(ring(SELF,key), n=1000, conf=0.9, k=15) => true
normalizedLogDistance(SELF, key) = 1.0    ← "maximally far" for a ring-adjacent pair
```

So all three symptoms named in the fix ticket are real and simultaneous at the same seam:

- **Next-hop picks the ring-worse candidate.** Both the cost path and the legacy path prefer `RIVAL`,
  which is 2^244 arc-units from the key, over `SELF`, which is 1 arc-unit away.
- **Payload is withheld from a ring-adjacent node.** `nearZone` here is ≈ 3.47e75 (`β·k·2^256/n_est`,
  β=2, k=15, n=1000). XOR distance 1.16e77 blows past it; true ring distance 1 sits well inside it.
  This is the incommensurable-units problem stated concretely: a XOR magnitude compared against a
  threshold derived from arc length.
- **The sparsity model is skewed.** A peer one step around the ring is fed into the KDE as x = 1.0
  (the far end of the distance histogram). With ring distance it is x ≈ 0.0039.

A second case at the `0x00ff…`/`0x0100…` seam reproduces the next-hop symptom identically (ring
distances 1 vs 2^247, XOR picks the 2^247 peer) but not the payload symptom, because that seam's XOR
magnitude happens to land inside `nearZone`. Use the top-bit vectors for the regression test — they
exercise all three sites.

## Cause and fix

`xorDistance` treats the identifier space as a bit-tree, not a circle: two coordinates straddling a
high-bit boundary share no high-bit prefix, so XOR maximizes exactly where arc length minimizes. The
correction is mechanical — `min(clockwiseDistance(a,b), clockwiseDistance(b,a))` — and the arms are
independent, so the risk lives in the fallout, not the arithmetic.

### `ring/distance.ts`

Give `minDistance` a true body. The name stays: it *is* the min of the two arcs, and it is already
the name every caller should be reaching for.

```ts
/** True ring distance: the shorter of the two arcs between a and b, on a ring of 2^(8·len). */
export function minDistance(a: Uint8Array, b: Uint8Array): Uint8Array {
	const cw = clockwiseDistance(a, b);
	const ccw = clockwiseDistance(b, a);
	return lexLess(ccw, cw) ? ccw : cw;
}
```

`lexLess` is a plain big-endian byte compare and both arcs come back at `max(a.length, b.length)`
bytes, so the comparison is a correct magnitude compare here.

`xorDistance` becomes dead once the three call sites move. Delete it — including the `index.ts`
re-export and its property-test block. Keeping a metric nobody should use is how this bug comes back.

### The three call sites

- `selector/next-hop.ts:156` (cost path) and `:205` (legacy path) — swap `xorDistance` → `minDistance`,
  fix the import on line 2.
- `store/relevance.ts:30` — same swap; fix the import on line 2.
- `service/fret-service.ts:2016` — same swap for `distToKey`; fix the import on line 32.

`fret-service.ts:1687/1689` (`pickAnchors`) reaches the legacy path and is fixed transitively.

### Consequences to check while editing, not to redesign

- **Ring distance maxes at 2^255, not 2^256-1.** `normalizeDistance` (`next-hop.ts:76-89`) therefore
  tops out at `1 - 1/256 ≈ 0.996` rather than 1.0, and `normalizedLogDistance` (`relevance.ts:29-42`)
  likewise. Both are used as relative scores, and the KDE centers span 0.042–0.958, so nothing needs
  rescaling. Their "1 = maximally far" comments are now off by one step — reword.
- **Distinct peers can now tie.** XOR distance was unique per distinct coordinate; ring distance is
  not (one peer clockwise, one counter-clockwise, same arc). `betterByDist` already breaks ties on
  peer id, which is what `docs/fret.md` prescribes ("when equidistant, prefer lexicographic order of
  peer IDs"). No change needed — just don't "fix" it.
- **Comments naming XOR.** `payload-heuristic.ts:22` ("XOR distance from self…") and `:57`
  ("suitable for comparison with XOR distances") describe the parameter's provenance and are now
  wrong. `next-hop.ts:113` and the near/far comment block are fine.

### Tests

- `test/ring.properties.spec.ts:41-61` — the `xorDistance` describe block dies with the function.
  Replace with a `minDistance` block asserting the same three properties (symmetry, self-distance
  zero, identity of indiscernibles — all hold for ring distance) plus the two properties XOR never
  had: `minDistance(a,b) ≤ 2^255`, and `minDistance(a,b)` equals whichever of `clockwiseDistance(a,b)`
  / `clockwiseDistance(b,a)` is smaller.
- **New wrap-boundary regression test** using the top-bit vectors above. It must fail on the current
  `xorDistance` implementation and pass after — assert all three: `chooseNextHop` returns `SELF` on
  both the legacy and cost paths, and `shouldIncludePayload` is true for the ring-adjacent node.
- `test/relevance.properties.spec.ts:79-91` and `test/seed-new-peers.spec.ts:105-134` were checked
  against the new metric and still hold: the former's assertions are range/self-distance only, and
  the latter measures from an all-zero self coordinate, where no arc wraps and ring distance equals
  XOR distance for every coordinate it constructs. No edits expected — if either fails, that is a
  signal worth reading, not a fixture to adjust.

### `docs/fret.md`

The routing rule already says "minimizes absolute ring distance"; the code just did not. Make it
unambiguous that one metric now serves everything:

- Under *Identifier space and hashing*, note that `min(cw, ccw)` is the single distance function and
  that routing, payload inclusion, and the relevance sparsity model all use it — the wrap-around
  point behaves like every other point on the ring.
- Under the *Relevance score calculation* block, state that `normalized_log_distance` is derived from
  ring distance (so its maximum is 2^255, not the full ring).

## TODO

- Implement true ring distance in `minDistance` (`ring/distance.ts`) from `clockwiseDistance` +
  `lexLess`; replace the false "absolute ring distance via XOR" comment with an accurate one.
- Delete `xorDistance` and its `index.ts:130` re-export.
- Route `next-hop.ts:156` and `:205` through `minDistance`.
- Route `relevance.ts:30` (`normalizedLogDistance`) through `minDistance`.
- Route `fret-service.ts:2016` (`distToKey`, feeding `shouldIncludePayload`) through `minDistance`.
- Reword the "1 = maximally far" comments in `next-hop.ts:76-78` and the XOR-naming comments in
  `payload-heuristic.ts:22` and `:57`.
- Replace the `xorDistance` property block in `test/ring.properties.spec.ts` with a `minDistance`
  block, including the ≤ 2^255 bound and the min-of-two-arcs identity.
- Add the wrap-boundary regression test with the top-bit vectors from *Reproduction* above, covering
  the legacy next-hop path, the cost next-hop path, and `shouldIncludePayload`.
- Update `docs/fret.md` per above.
- Run `cd packages/fret && npx tsc --noEmit` and `yarn test`; the simulation harness under
  `test/simulation/` uses the store directly and should be unaffected, but confirm rather than assume.
