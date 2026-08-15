----
description: There are three separate code paths that announce newly discovered peers to the rest of the stack, one of which can leak peers that belong to another network, and they should be collapsed into the single correct path.
files: packages/fret/src/service/discovery.ts, packages/fret/src/service/libp2p-fret-service.ts, packages/fret/src/service/fret-service.ts
difficulty: medium
----
Peer discovery is emitted from three independent places when it should come from one. `emitDiscovered`, the periodic `FretPeerDiscovery.scan`, and the standalone `seedDiscovery` all dispatch discovery events, carrying two independent debounce maps and copy-pasted pruning logic between them. Only `scan` is the durable, correctly member-gated path — it re-scans the whole store each tick and emits a peer as soon as it is classified as belonging to this network.

`seedDiscovery` actively violates the member-only emission guarantee that the other two paths uphold: it dispatches a discovery event for every store entry with no membership or dead-state filter. It runs against a populated store exactly when a table was just restored from persistence — a table that legitimately contains peers labelled as belonging to another network — so it is precisely the path that leaks foreign peers into the discovery pipeline, where they get re-seeded upstream. In an empty-store deployment it is a no-op; its only live effect is the leak.

Expected outcome: a single discovery-emission path (consolidate on `scan`), one debounce map, and no code path that emits a non-member or dead peer. `seedDiscovery` and `emitDiscovered` are removed, with `scan`'s first tick covering the seed need; if `seedDiscovery` must be kept for timing reasons, it is at minimum filtered to member-and-non-dead entries.

Also decide the empty-multiaddr question: all three paths emit discovery events with empty multiaddrs, so a downstream consumer can only act on a peer already present in the peerStore. Either enrich the emission with known addresses or document that discovery is peerStore-relative by design.

This is a design/refactor pass — the plan agent should confirm `scan`'s coverage fully subsumes the seed and `emitDiscovered` cases (timing on `start()` and after `importTable`), settle the debounce ownership, and decide the multiaddr question before handing to implement.

References: review "Discovery & libp2p glue" major finding (`seedDiscovery` violates member-only emission) and the "three paths where one belongs" design note. discovery.ts `seedDiscovery` (~8-16), called from libp2p-fret-service.ts (~55); fret-service.ts `emitDiscovered` (~1157) and the `FretPeerDiscovery.scan` path.
