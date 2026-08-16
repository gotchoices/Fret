----
description: The core service file has grown into a single ~1600-line class that mixes many concerns; two self-contained pieces of logic can be lifted out to shrink it and make the extracted logic testable on its own.
files: packages/fret/src/service/fret-service.ts
difficulty: hard
----
`fret-service.ts` is a god class of roughly 1600 lines. Two extractions are cheap and high-value.

(a) Two-sided ring walk helper. The idiom that builds the union of the right- and left-side ring neighbors of a coordinate and drops self appears nine times with small variations — roughly `Array.from(new Set([...neighborsRight(c, m), ...neighborsLeft(c, m)])).filter(id => id !== selfStr)`. Replace these with a single helper, e.g. `ringNeighborsBothSides(coord, count, opts)`, that centralizes the dedup, the self-exclusion, and the member-only filter. This removes duplication and gives one place to fix the wrap-around dedup/early-exit behavior noted elsewhere.

(b) Size observer. About 135 lines handle network-size observation, blending, decay, churn detection, and partition detection. This block has zero coupling to the Digitree store or to libp2p and is currently impossible to unit-test in isolation. Extract it into a `SizeObserver` class with a narrow interface (feed observations in, read blended estimate/confidence out) so the decay and blend math becomes directly testable.

Expected outcome: the nine walk sites call one helper; the size logic lives in its own unit-testable class; `fret-service.ts` is meaningfully smaller with no behavior change.

This is a design/refactor pass — the plan agent should settle the helper signature and the `SizeObserver` interface, enumerate the call sites, and confirm behavior parity (especially member-only filtering and the wrap-around dedup) before handing to implement.

References: fret-service.ts nine two-sided walk sites (~520-719) and the size observation/blend/decay/churn/partition block (~1331-1465). Review "Core service" major finding (nine copies of the two-sided walk idiom; god-class scope).

Size re-measured during the `membership-classification-strength` review: `wc -l packages/fret/src/service/fret-service.ts` now reports **1878** lines, up from the ~1600 this ticket was written against (membership classification and the probe/re-probe passes landed in between). A third extraction candidate has appeared alongside the two above: membership classification — the evidence-strength guard, the inbound-RPC promotion, the identify-list classifier, and the two bounded probe passes — is a self-contained policy with a narrow dependency on the store, and is currently only reachable in tests through real libp2p nodes or private-member casts.

Size re-measured during the `dead-state-exclusion-recovery` review: `wc -l
packages/fret/src/service/fret-service.ts` now reports **2466** lines, up from the 1878 recorded at
the `membership-classification-strength` review and the ~1600 this ticket was written against (the
dead-state liveness seam, ring exclusion, and the two-armed re-probe pass landed in between). The
one extraction that same review performed — `isLiveMember` into `src/service/live-member.ts`, so
`FretPeerDiscovery` shares the predicate rather than copying it — is 20 lines of the god class, not
a dent; the three candidates above still stand.
