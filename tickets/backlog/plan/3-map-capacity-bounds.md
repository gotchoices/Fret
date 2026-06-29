description: Add explicit capacity limits and periodic sweeps to all internal maps
dependencies: none
files: src/service/fret-service.ts
----

### Problem

Several internal maps have no hard capacity limits and rely on lazy pruning that only triggers during specific events:

- `backoffMap: Map<string, {until, factor}>` — grows with every peer that fails. Only pruned lazily by `clearBackoff` on success or `getBackoffPenalty` on expiry check.
- `announcedIds: Map<string, number>` — pruned at 4096 entries, but only when emitting new discoveries. Can grow unbounded between prunes.
- `departureDebounce: Map<string, number>` — pruned at 256, but only on departure events.

An attacker sending messages from many peer IDs or triggering many distinct departures can grow these maps to cause GC pressure.

### Expected behavior

All internal maps have explicit hard capacity limits. A periodic sweep (aligned with stabilization cadence) prunes expired entries from all maps, rather than relying solely on event-triggered lazy pruning. Capacity limits are profile-tuned (Edge lower than Core).

### Threat references

- threat-analysis.md §4.3 (Medium): Unbounded map growth
