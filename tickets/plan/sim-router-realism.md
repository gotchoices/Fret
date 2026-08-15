----
description: The large-scale simulation that guards routing quality quietly cheats — it routes using global knowledge no real node has and lets churn affect fewer peers than configured — so its success threshold validates ring-maintenance math rather than the routing code it is meant to protect.
files: packages/fret/test/simulation/fret-sim.ts
difficulty: hard
----
The deterministic sim harness is a genuine asset, but two shortcuts make its routing-success regression threshold oracle-assisted rather than a real test of the routing code:

- The sim router filters candidate next hops by a global liveness flag that no real node can see, and then takes the first candidate without requiring the hop to make distance progress toward the target. So the threshold reflects ring-maintenance math, not the production hop selection.
- Churn leavers are all drawn from the initial population at setup time, so late joiners never churn and duplicate picks are no-ops — effective churn runs below the configured level.

Design direction:
- Restrict routing decisions to each node's local store knowledge, and require distance progress on each hop.
- Schedule churn lazily so any peer alive at churn time (including late joiners) can be selected, and avoid no-op duplicate picks.
- Consider a mid-scale tier that drives real service instances over the in-memory transport, since the production iterative-lookup, next-hop, and payload-inclusion paths are only smoke-tested at three nodes.

The plan agent should decide how far to push the local-knowledge routing model versus standing up a real-instance tier, and set realistic churn/success thresholds for each.

References: review.html:448-452 "Sim routing is oracle-assisted; churn under-delivers"; fret-sim.ts routing filter (~586-594) and churn init (~213-223).
