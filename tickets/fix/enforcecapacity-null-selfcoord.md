----
description: The routing table's size limit is silently skipped during the exact moments the table is bulk-loaded at startup, so it can balloon past its cap right when enforcement matters most.
files: packages/fret/src/service/fret-service.ts
difficulty: easy
----
`enforceCapacity` returns early and does nothing while `cachedSelfCoord` is still null. That null state is precisely what holds during `start()`'s first peerStore seed and during any pre-start `importTable()` — the two paths most likely to insert a large batch of peers at once. Capacity therefore goes unenforced exactly when a bulk insert could overflow the table.

Expected behavior: capacity enforcement functions during startup seeding and table import.

Requirements:
- Ensure the self-coordinate is available before capacity enforcement runs — either seed the self-coord cache at the entry of `start()` (and before import), or have `enforceCapacity` await `selfCoord()` rather than reading the cache and bailing when it is null.

References: fret-service.ts `enforceCapacity` early return on null `cachedSelfCoord` (~207-212). Review "Core service" minor finding (capacity unenforced exactly when it matters).
