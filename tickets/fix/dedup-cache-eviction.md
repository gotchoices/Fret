----
description: The duplicate-request cache can throw away a live, still-valid entry when it should not, including when it is merely refreshing an entry that already exists.
files: packages/fret/src/service/dedup-cache.ts
difficulty: easy
----
`DedupCache.set` has several eviction quirks that discard live entries unnecessarily.

Today `set` checks size before inserting and, if at capacity, runs an expiry sweep then evicts the oldest-inserted entry. Three problems:
- Overwriting a key that is already present still counts the cache as full and evicts an unrelated live entry, even though the overwrite would not have grown the map.
- Eviction picks the first key in `Map` insertion order. A key re-`set` to refresh it keeps its original insertion position (a plain `set` on an existing key does not reorder a `Map`), so a just-refreshed entry can be evicted as "oldest" while genuinely stale entries survive.
- At capacity every `set` pays an O(n) expiry scan over the whole map.

Expected behavior: refreshing an existing key never evicts an unrelated entry; a recently refreshed entry is not treated as the oldest; eviction cost is not an O(n) scan on the hot path.

Fix hint: handle the existing-key case first (delete-then-set, or update in place) so an overwrite never triggers eviction; on a genuine insert-at-capacity, evict only after confirming a new key is being added, and prefer a strategy where a refresh moves the entry to the newest position.

Note: the separate TTL-vs-timestamp-window misalignment (30s TTL vs the ±5min freshness window) is owned by the replay-dedup-hardening ticket — do not address it here.

References: review "Discovery & libp2p glue" minor finding (dedup cache eviction quirks). dedup-cache.ts `set`/`evictExpired`/`evictOldest` (~26-43) and the default TTL constructor arg (~7).
