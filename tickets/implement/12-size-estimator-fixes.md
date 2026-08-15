---
description: The estimate of how many peers are in the network is badly wrong once a node knows a mix of close and far peers — it can read 100 when the network really has 2000 — and the accompanying confidence number is stuck near one constant value regardless of how good or bad the sample is. Fix both, plus a related averaging mistake that further depresses confidence.
files: packages/fret/src/estimate/size-estimator.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/size-estimator.spec.ts, docs/fret.md
difficulty: medium
repro: verified
---

## What is wrong

Three defects, all in the size-estimate path, plus the doc text that describes it.

### 1. Gap population is the whole store, not the successor/predecessor window

`estimateSizeAndConfidence` (`size-estimator.ts:24`) sorts *every* known coordinate and takes
the **median** of the consecutive differences, then `n_est = 2^256 / medianGap`.

The design (`docs/fret.md`, "Network size estimation") specifies the arc-length method over the
**successor/predecessor window**: average gap between consecutive S/P members. The difference is
not cosmetic. A node's knowledge is deliberately non-uniform: it knows *every* peer near itself
(S/P sets) and a sparsity-weighted scattering of far peers (see `selectDiverseSample` and the
relevance sparsity model). So the gap population is a mixture of

- ~2m small gaps near self, which are close to the true inter-peer spacing, and
- a long tail of huge gaps between far peers the node happens to know,

and the **median lands in the huge-gap tail as soon as far peers outnumber near ones**, which is
the normal steady state. `n_est` then collapses.

Measured (deterministic RNG, uniform-random ring of N peers; node knows self + 8 successors +
8 predecessors + `far` randomly-sampled distant peers; m = 8):

| N | far peers known | current `n_est` | error | S/P-window mean-gap `n_est` | error |
|---|---|---|---|---|---|
| 500 | 0 | 1057 | +111% | 780 | +56% |
| 500 | 32 | 135 | **−73%** | 524 | +5% |
| 500 | 128 | 210 | **−58%** | 527 | +5% |
| 2000 | 32 | 97 | **−95%** | 2462 | +23% |
| 2000 | 128 | 188 | **−91%** | 1899 | −5% |
| 10000 | 32 | 127 | **−99%** | 7440 | −26% |
| 10000 | 128 | 233 | **−98%** | 6896 | −31% |

The existing spec suite does not catch this because every partial-knowledge case in
`test/size-estimator.spec.ts` (Phase 2) subsamples a *contiguous window* of a uniform ring — the
one shape where whole-store gaps and S/P-window gaps are identical. The file's own NOTE at
`size-estimator.spec.ts:137` calls this gap out.

Consequence: `n_est` feeds cluster span (`k * 2^256 / n_est`), near-radius (`β * cluster_span`),
the next-hop near/far decision, and `shouldIncludePayload`. A 20× undercount inflates cluster
span 20×, so near-radius swallows the ring and every node believes it is near-cluster.

### 2. The confidence variance factor is dead weight

`size-estimator.ts:51` computes `varianceFactor = minGap / maxGap`. On any real (random) ring the
smallest gap is orders of magnitude below the largest, so this is ~0 and

    confidence = clamp(0.5 * sizeFactor + 0.5 * varianceFactor)

pins at `0.5 * sizeFactor`, i.e. exactly **0.5** for any node knowing ≥ 2m peers. Measured
`minGap/maxGap` on random-uniform rings: 1.9e-3 (n=10), 3.3e-3 (n=100), 4.4e-5 (n=1000),
4.2e-6 (n=5000) — contributing at most 0.002 to confidence. (The fix ticket estimated a ceiling
near 0.55; measured ceiling is ~0.501.)

So confidence carries no information about sample quality at all, while every consumer
(`shouldIncludePayload`, the confidence-weighted next-hop cost, the ≥0.3 operation gate) treats
it as if it does.

### 3. Service confidence average divides by the wrong denominator

`getNetworkSizeEstimate` (`fret-service.ts:1864`) accumulates
`confidenceSum += obs.confidence * recencyWeight` and then divides by
`allObservations.length` — a recency-weighted numerator over an unweighted count. Every
observation older than "now" therefore drags the average toward zero even when all observations
agree perfectly. Measured with four observations all at confidence 0.5, spread over a 300 s
window: reported **0.2318** instead of **0.5000** (−54%).

The correct denominator is the sum of recency weights (`totalWeight` is the wrong one too — it is
`recency * confidence`, which would cancel the confidence out).

Also at `fret-service.ts:1881`: `if (allObservations.length === 0)` is unreachable — the array is
constructed with the local FRET estimate as its first element. The later `totalWeight === 0`
guard **is** reachable (every observation at confidence 0) and must stay.

## Design

### Estimator signature

Swap the trailing positional `filter` for an options bag so the self coordinate can join it:

```ts
export interface SizeEstimateOptions {
	/** Restrict the estimate to a subset of the store (FretService passes the member gate). */
	filter?: (e: PeerEntry) => boolean;
	/** Ring coordinate of the local node. When given, gaps are taken from the S/P window. */
	selfCoord?: Uint8Array;
}

export function estimateSizeAndConfidence(
	store: DigitreeStore,
	m: number,
	options?: SizeEstimateOptions
): SizeEstimate
```

There are four in-repo call sites, all in `fret-service.ts` — 1529 (`snapshot`), 1697
(`routeAct`), 1867 (`getNetworkSizeEstimate`), 2026 (`iterativeLookup`) — plus the re-export in
`index.ts:133`. No compatibility shim is wanted (see AGENTS.md: backwards compatibility is not a
concern yet).

### Gap population

With `selfCoord`: walk `store.neighborsRight(selfCoord, m, filter)` and
`store.neighborsLeft(selfCoord, m, filter)`, collect their coordinates plus `selfCoord`, sort,
and take the consecutive differences **inside** the window only. Do **not** add the wrap gap: it
spans the whole unknown arc and is exactly the outlier that corrupts the current estimate. Use
the arithmetic mean, per the design doc ("average gap between consecutive S/P members").

Without `selfCoord` (the exported standalone, used by the spec suite and available to the design
simulator): keep today's whole-store consecutive-gap population and median. Document it as the
degraded fallback, not the intended path.

Care at the walk: self is normally *in* the store, so a walk anchored exactly at `selfCoord` can
return self. De-duplicate coordinates before differencing (a `Set` of the bigints, as the
prototype did) rather than assuming the walk excluded it.

### Confidence

Replace the dead variance factor with the **relative standard error of the mean gap**, computed
over whichever gap population was used:

```
G     = number of gaps
mean  = Σg / G
cv    = sd(g) / mean                    // coefficient of variation
cvEff = max(cv, 1)                      // exponential-gap prior: a random ring has cv ≈ 1
rse   = cvEff / sqrt(G)
dispersionFactor = clamp(1 - rse, 0, 1)
sizeFactor       = min(1, count / (2m))     // unchanged
confidence       = clamp(0.5*sizeFactor + 0.5*dispersionFactor, 0.05, 1)
```

Why `cvEff = max(cv, 1)` rather than raw `cv`: gaps on a uniform-random ring are exponentially
distributed, so `cv ≈ 1` is the *healthy* value — the prior floors it so a synthetically perfect
(evenly spaced) ring cannot claim zero sampling error from 16 samples. It also caps confidence at
`0.5 + 0.5*(1 − 1/√G)`: 0.875 at G=16, ~0.57 at G=2 — monotone in window size, which is the
behavior the doc's "base confidence from sample count" bullet asks for.

Measured with the prototype (raw `cv`, no prior): healthy random rings land at confidence
0.84–0.91 (rse 0.19–0.32) where the current code reports a flat 0.500; a store with all peers at
one coordinate yields dispersionFactor 0 and confidence 0.31.

Known limitation, worth a `NOTE:` at the site rather than a ticket: dispersion over the S/P
window measures *local* spacing regularity only. A node whose neighbors are all packed into a
tiny, evenly-spaced arc (an eclipse, or a young ring) gets a high dispersion factor and a wildly
wrong `n_est` — the prototype returned n=1,000,000 at confidence 1.0 for that shape. Local
statistics cannot see it; the defense is corroboration from peer-reported estimates, which
`reportNetworkSize` / `calibrateSizeFromSnapshot` already provide. Record the limitation at the
confidence computation; do not file a ticket for it.

### Service average

In `getNetworkSizeEstimate`: accumulate `recencySum += recencyWeight` alongside the existing
sums, return `confidenceSum / recencySum` (guarding `recencySum === 0`), and delete the
unreachable `allObservations.length === 0` branch. Leave `size_estimate`'s
`weightedSum / totalWeight` alone — that one is correctly weighted by recency × confidence.

## Tests

`test/size-estimator.spec.ts` asserts on confidence in five places; several are calibrated
against the ~0.5 plateau and will shift. Expected outcomes to check rather than assume:

- Phase 3 monotonicity (ordered insertion, uniform ring) — should still hold: cv stays 0 → `cvEff`
  is the floor, `rse = 1/√G` falls monotonically as G grows.
- Phase 4 "confidence exceeds 0.5 before all N added" — should trip *earlier*, still passing.
- Edge case "all peers at same coordinate: confidence < 0.5" — should still pass (dispersion 0).
- "two peers: confidence < 1" — should still pass (G=1 → rse=1 → dispersion 0).
- Phase 1/2 accuracy tests use the no-`selfCoord` fallback, so `n` is unchanged there.

The class-level guard this ticket owes (the whole reason the bug survived): a partial-knowledge
test where local and global density **differ**. Build a uniform-random ring of N, give the store
self + m successors + m predecessors + a random scattering of far peers, pass `selfCoord`, and
assert `n_est` within 2× of N across N ∈ {500, 2000, 10000} and far-sample ∈ {0, 32, 128}. The
table at the top of this ticket is the measured baseline: the current code fails this at −73% to
−99%; the S/P-window estimator passes it.

## TODO

- Introduce `SizeEstimateOptions` in `size-estimator.ts` and convert the positional `filter`
  parameter; update `index.ts` export surface if the type should be public.
- Implement S/P-window gap collection (self + `neighborsRight`/`neighborsLeft` under `filter`,
  de-duplicated, in-window consecutive differences, arithmetic mean, no wrap gap).
- Keep the whole-store median path as the documented no-`selfCoord` fallback.
- Replace `varianceFactor` with the relative-standard-error dispersion factor above; add the
  `NOTE:` about local-dispersion blindness to eclipsed / tightly-clustered neighborhoods.
- Update the four `fret-service.ts` call sites to pass `selfCoord`. 1529 and 2026 already have it
  in scope; 1697 (`routeAct`) can `await this.selfCoord()`; 1867 (`getNetworkSizeEstimate`) is
  sync and public — use `this.cachedSelfCoord` and fall through to the no-self path when it is
  not yet populated (the method is callable before `start()` completes).
- Fix the confidence denominator in `getNetworkSizeEstimate` (`confidenceSum / recencySum`) and
  delete the unreachable zero-observations branch; keep the `totalWeight === 0` guard.
- Add the partial-knowledge accuracy test described above; re-calibrate the existing confidence
  assertions to the new curve (adjust thresholds, do not weaken what they assert).
- Update `docs/fret.md` "Network size estimation": state that the estimate uses S/P-adjacent gaps
  when the self coordinate is known and the whole-store median otherwise, and replace the
  confidence bullets with the sample-count + dispersion formula. Fix the "Member-scoped" sentence
  that describes the old positional `filter` argument.
- Run `npx tsc --noEmit` and `yarn test` from `packages/fret/`.
