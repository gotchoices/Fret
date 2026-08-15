----
description: The network-size estimator both systematically undercounts peers and reports a confidence that is nearly constant and capped low, and a related averaging bug in the service under-reports confidence further, so downstream decisions that depend on network size and confidence are consistently off.
files: packages/fret/src/estimate/size-estimator.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: medium
----
Size estimation deviates from the design in two ways and carries a dead confidence factor, plus a companion averaging bug in the service.

First, the confidence formula's variance factor is `minGap/maxGap`, which approaches zero for any real (uniform-random) network, so confidence collapses to roughly `0.5 * sizeFactor` with a ceiling near 0.55 regardless of how good the sample is — statistically dead weight.

Second, the estimator takes the median gap over the whole membership-filtered store, but the design specifies the average gap between *consecutive successor/predecessor members*. Gaps between non-adjacent known peers are wider than true adjacent gaps, so the whole-store median systematically underestimates n.

Third, `getNetworkSizeEstimate` in the service divides a recency-weighted confidence numerator by an unweighted observation count, a systematic under-report, and carries a dead zero-observations branch that can never run.

Since near-radius, payload inclusion, and cluster-span all key off the size estimate and confidence, these errors propagate widely.

Expected behavior: n is estimated from consecutive S/P-adjacent gaps as the design specifies; confidence reflects real sample dispersion rather than a near-constant floor; and the service's confidence average divides by the sum of recency weights.

Requirements:
- Use gaps between consecutive S/P members, not the whole-store median.
- Replace the dead variance factor with an IQR- or median/mean-dispersion-based confidence.
- In `getNetworkSizeEstimate`, divide the recency-weighted numerator by the sum of recency weights and delete the unreachable zero-observations branch.
- Update `docs/fret.md` if the described method changes.

References: review Design assessment "Size estimation: two quiet deviations from the doc"; RPC-section "Size estimator: dead confidence factor, wrong gap population" (size-estimator.ts:51); Core-section misc finding (fret-service.ts:1370-1394, broken confidence average).
