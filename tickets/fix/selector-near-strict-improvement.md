----
description: When a routing node is already close to a key, it can still forward the request to a peer that is farther from the key than itself, so requests can move backwards and rely entirely on hop limits to avoid looping.
prereq: consolidate-ring-distance
files: packages/fret/src/selector/next-hop.ts
difficulty: medium
----
In near mode the next-hop selector sorts candidates by distance to the key but never compares them against the node's own distance to the key, so it can choose a hop farther from the key than the node itself. The design requires strict distance improvement (epsilon approximately zero) in near mode; without it, forward progress is not guaranteed and loop safety rests entirely on breadcrumbs and TTL.

Separately, the near-mode cost weights are computed per candidate but are effectively dead: in near mode cost is only a tertiary tie-break, so the weight computation is wasted work.

Expected behavior: in near mode, only candidates strictly closer to the key than the node itself are eligible; when near a key the node always makes forward progress rather than depending on TTL to terminate.

Requirements:
- Filter candidates to those with distance less than the node's own distance to the key in near mode.
- Hoist or remove the dead near-mode weight computation.

References: review RPC-section "Selector: near mode never enforces strict improvement vs self" (next-hop.ts:172-181, 55-74). Recommended fix: compare candidate distance against self distance and drop non-improving candidates; eliminate the unused near-mode cost weights.
