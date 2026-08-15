description: The duplicate-request cache no longer throws away a live, still-valid entry when it should not; the fix is coded and tested, this ticket is the build/test verification handoff to review.
files: packages/fret/src/service/dedup-cache.ts, packages/fret/test/dedup-cache.spec.ts
difficulty: easy
----
## Root cause (from fix stage)

`DedupCache.set` used to check capacity before every insert, sweep for expired entries with an
O(n) scan, and then evict the `Map`'s first-iteration-order key as "oldest." Three problems, all
in `packages/fret/src/service/dedup-cache.ts`:

- Overwriting a key already present still counted the cache as full and could evict an unrelated
  live entry, even though an overwrite does not grow the map.
- A plain `Map.set` on an existing key does not move it in iteration order, so a just-refreshed
  entry kept its original (old) position and could be evicted as "oldest" while genuinely stale
  entries survived.
- Every `set` at capacity paid an O(n) expiry scan (`evictExpired`) on the hot path.

## Fix already applied

`set` now handles the existing-key case first — `delete` then `set` — so an overwrite (a) never
counts as growing the map and (b) moves the refreshed key to the newest `Map`-iteration-order
slot. Eviction on a genuine insert-at-capacity no longer runs an expiry sweep at all: because
insertion order and expiry order agree under a constant `ttlMs`, the oldest-inserted entry
(`Map` iteration's first key) is always also the nearest to expiry, so `evictOldest` is a plain
O(1) `Map` first-key delete with no scan.

```ts
set(key: string, result: T): void {
	if (this.entries.has(key)) this.entries.delete(key);
	else if (this.entries.size >= this.maxSize) this.evictOldest();
	this.entries.set(key, { result, expires: Date.now() + this.ttlMs });
}
```

`evictExpired` was removed — nothing else referenced it (`git grep evictExpired` — only the
removed definition and its two call sites, both gone).

Two new specs pin the previously-buggy behaviors in `packages/fret/test/dedup-cache.spec.ts`:
refreshing a key at capacity doesn't evict an unrelated entry, and a refreshed entry is not
picked as the eviction victim over a genuinely older one.

## TODO

- Run `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/dedup-cache.spec.ts" --timeout 30000` — confirm all 7 specs pass (already verified green as of this handoff).
- Run `cd packages/fret && npx tsc --noEmit` — confirm clean (already verified as of this handoff).
- Run full suite (`cd packages/fret && yarn test`) since `dedup-cache.ts` is used by `fret-service.ts`'s maybeAct dedup path — confirm no regressions in RPC-level specs that exercise dedup caching.
- Hand off to review with the diff already landed in commit `9d3390d` (fix-stage commit that produced this working fix + tests).
