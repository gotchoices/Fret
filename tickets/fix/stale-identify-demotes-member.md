----
description: A peer that was just confirmed to belong to this network can be wrongly reclassified as an outsider by a stale, out-of-date notification, forcing it onto a slow recovery path.
files: packages/fret/src/service/fret-service.ts
----
The identify event handlers reclassify a peer's membership from its advertised protocol list unconditionally, so a queued or out-of-date event can undo a stronger, more recent classification.

Today the `peer:identify` and `peer:update` handlers both call `classifyByProtocols` with whatever protocol list the event carries. `classifyByProtocols` marks the peer `foreign` whenever the list is non-empty but contains none of this network's protocols. That list can predate this service registering its handlers — a peer that legitimately serves this network may have been identified before our protocols were live. If the classification probe pass has already RPC-confirmed that peer as `member` (the strongest possible proof — a completed namespaced call), a late-arriving identify event demotes it back to `foreign`. It is then stranded on the slow foreign re-probe path (exponential backoff, at most ~once per window) instead of participating in the ring. This is inconsistent with `seedFromPeerStore`, which classifies only entries still labelled `unknown` and never touches an already-resolved peer.

Expected behavior: an existing `member` is never demoted by an identify-derived protocol list — RPC proof outranks identify. Promotion in the other direction (`foreign → member`, or `unknown → member/foreign`) still applies, so a peer that starts serving this network is re-admitted.

References: review "Discovery & libp2p glue" major finding (stale identify event demotes RPC-confirmed member). fret-service.ts `peer:identify`/`peer:update` handlers (~340-361) and `classifyByProtocols` (~287-292). Fix hint: guard the identify path so it does not overwrite an existing `member`, or add a member-preserving mode to `classifyByProtocols`.
