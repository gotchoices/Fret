----
description: Routing, the payload-inclusion decision, and the relevance model all measure peer closeness with a bit-XOR metric while cohort and membership logic use true ring order, so the two disagree about which peers are near a key and the node can make wrong routing and payload choices near the wrap-around point.
files: packages/fret/src/ring/distance.ts, packages/fret/src/selector/next-hop.ts, packages/fret/src/store/relevance.ts, docs/fret.md
difficulty: hard
----
The design specifies ring distance as the minimum of the clockwise and counter-clockwise arc between two coordinates. Cohort assembly and neighbor selection honor this via the ordered B-tree ring walk. But next-hop routing cost, the payload-inclusion heuristic, and the relevance model's normalized log-distance all measure distance with bit-XOR through `minDistance`, whose comment falsely claims it computes "absolute ring distance via XOR" — it is neither absolute ring distance nor a ring metric.

XOR is a fundamentally different metric. Two coordinates that are ring-adjacent across a high-bit boundary (for example `0x00ff…` and `0x0100…`) are XOR-maximally far. Consequences today: near/far classification compares an XOR distance against a near-radius derived from ring arc length — incommensurable units; a hop that is ring-adjacent to the key can be classed "far" and have its payload withheld; the cohort walk and the routing cost disagree about which peers are near the key exactly at the wrap seam; and the sparsity model's distance balancing is skewed there too.

The design decision is already made: consolidate on TRUE RING DISTANCE `min(cw, ccw)`. Do NOT keep XOR.

Expected behavior: a single ring-distance function computes `min(clockwiseDistance(a,b), clockwiseDistance(b,a))` and is used consistently for next-hop cost, the payload-inclusion decision, and the relevance normalized log-distance, so all distance-based decisions agree with the cohort/membership ring order.

Requirements:
- Implement ring distance from the existing `clockwiseDistance` (currently unused/dead) and replace the XOR body of `minDistance`.
- Route `chooseNextHop`, `shouldIncludePayload`, and the relevance KDE normalized log-distance through ring distance.
- Fix the misleading comment in `distance.ts` and remove any now-dead exports (`xorDistance` if unused after the change).
- Update `docs/fret.md` to reflect that ring distance is used everywhere.

References: review Design assessment "The distance-metric split is the one design decision you must make", and RPC-section "XOR is not ring distance" (distance.ts:44-47, next-hop.ts:156/205, relevance.ts:30). Recommended fix: implement `min(clockwiseDistance(a,b), clockwiseDistance(b,a))` and add a wrap-boundary regression test proving XOR previously selected the ring-worse hop.
