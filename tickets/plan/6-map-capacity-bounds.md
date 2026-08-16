----
description: Several internal bookkeeping maps have no hard size limit and are trimmed only during specific events, so an attacker generating many distinct peers or departures can grow them unbounded and pressure memory.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/service/peer-discovery.ts
difficulty: medium
----
Several internal maps rely on lazy, event-triggered pruning with no hard capacity, so an attacker can grow them without bound:

- The discovery-debounce map (`FretPeerDiscovery.emitted`, in `peer-discovery.ts`) prunes only expired entries and only once it passes 4096 entries. With a 10-minute debounce TTL, entries live long enough that the map can grow unbounded between prunes. **Retargeted:** this bullet used to name `FretService.announcedIds`; the `consolidate-discovery-emission` ticket deleted that map along with `emitDiscovered`, and the surviving map in `FretPeerDiscovery` has the identical shape (same 4096 threshold, same expired-only prune, same never-shrinks-below-threshold behavior). Originally review finding m-core-12, partial.
- The failure backoff map grows with every peer that fails and is only pruned lazily — cleared on success or checked for expiry on read.
- The departure-debounce map prunes at 256 entries but only on departure events.

### Expected behavior
- Every one of these maps has an explicit hard capacity, profile-tuned (Edge lower than Core).
- A periodic sweep aligned with the stabilization cadence prunes expired entries from all of them, rather than relying solely on event-triggered lazy pruning.
- When a map is at capacity, eviction prefers the entry expiring soonest (oldest-expiry) rather than dropping a live entry arbitrarily.

The plan agent should settle the per-profile caps and the sweep placement (one shared sweep vs per-map), and confirm eviction ordering interacts correctly with each map's semantics (a just-refreshed backoff/debounce entry must not be the eviction victim).

References: fret-service.ts announce-debounce map / `announcedIds` prune (~1184-1186), plus the backoff map and departure-debounce map. Review "Core service" misc finding (unbounded announce debounce map); threat-analysis.md §4.3.
