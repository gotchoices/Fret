----
description: The frequently-running background maintenance loop repeats expensive work every tick that it could skip or cache, wasting CPU on every cycle — as often as several times per second in active mode.
files: packages/fret/src/service/fret-service.ts
difficulty: medium
----
Several hot paths that run every stabilization tick (as fast as ~300 ms in active mode) do avoidable work.

(a) `seedFromPeerStore` recomputes a SHA-256 ring coordinate for every peerStore id every tick, even when that id's coord is already stored. It should look up `store.getById(id)?.coord` first and only hash on a genuine miss.

(b) Five sites re-await `hashPeerId(self)` despite the `selfCoord()` cache already holding it. They should read `selfCoord()`.

(c) `enforceCapacity` performs a full list-and-sort of the routing table up to four or five times per tick. Capacity should be enforced at most once per tick.

(d) The steady-state classification and foreign re-probe passes each materialize a full O(capacity) array every tick only to filter it down to empty when no unknown/foreign peers exist. Maintaining running unknown/foreign counts allows an early return so these passes are true no-ops in single-network steady state.

Expected outcome: no per-tick SHA-256 for already-known coords; the cached self-coord is used everywhere; capacity enforced once per tick; classification/re-probe passes early-return when their target sets are empty. No behavior change, just less per-tick work.

The plan agent should confirm the running-count bookkeeping stays correct across upsert/evict/membership transitions and settle where the counts are maintained.

References: fret-service.ts `seedFromPeerStore` (~794-806), five `hashPeerId(self)` sites (across ~514-1061), `enforceCapacity` (~216-224), classification/re-probe passes (~939, 971). Review "Core service" minor finding (per-tick hot-path waste).

Arm added during the `dead-state-exclusion-recovery` review: point (d) is now **three** full-store
walks per tick, not two. The re-probe pass gained a second arm (`dead`, alongside `foreign`), and
each arm plus `classifyUnknownPeers` materializes its own `store.list()` array. A `NOTE:` at
`classifyUnknownPeers` in `fret-service.ts` records the same thing at the code site. Whatever
running-count bookkeeping this ticket lands should cover all three target sets — or, equivalently,
do one walk per tick and partition it into the three candidate lists.
