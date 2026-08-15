description: Duplicate-request cache no longer evicts a live, still-valid entry when it shouldn't; fix verified via full build+test — ready for review.
files: packages/fret/src/service/dedup-cache.ts, packages/fret/test/dedup-cache.spec.ts
difficulty: easy
----
## What changed (landed in commit 9d3390d)

`DedupCache.set` (`packages/fret/src/service/dedup-cache.ts`) previously miscounted an
overwrite of an already-present key as growth, and `Map` iteration order kept a just-refreshed
key at its original (old) slot — so a refresh at capacity could evict a genuinely live,
unrelated entry while the refreshed one (now stale-looking by position) was equally at risk of
being picked as "oldest." `set` also paid an O(n) `evictExpired` scan on every capacity-triggered
insert.

Fix: existing-key case now branches first — `delete` then `set`, which (a) never counts toward
the capacity check since size does not grow, and (b) re-inserts the key at the newest
iteration-order slot. `evictOldest` (used only for a genuine insert-at-capacity) no longer scans
for expiry: because every entry shares the same constant `ttlMs`, insertion order and expiry
order are the same order, so the map's first key is always both the oldest inserted *and* the
soonest to expire — a plain O(1) delete, no scan. `evictExpired` was removed entirely (confirmed
unreferenced elsewhere via `git grep`).

```ts
set(key: string, result: T): void {
	if (this.entries.has(key)) this.entries.delete(key);
	else if (this.entries.size >= this.maxSize) this.evictOldest();
	this.entries.set(key, { result, expires: Date.now() + this.ttlMs });
}
```

## Verification performed this stage

- `packages/fret/test/dedup-cache.spec.ts` in isolation: 7/7 passing, including the two specs
  added for this fix (refreshing a key at capacity doesn't evict an unrelated entry; a refreshed
  entry is not picked as the eviction victim over a genuinely older one).
- `npx tsc --noEmit` from `packages/fret/`: clean, no errors.
- Full suite (`yarn test` from `packages/fret/`): **411 passing**, exit 0, ~5 minutes. This
  exercises `dedup-cache.ts` indirectly through `fret-service.ts`'s maybeAct dedup path (e.g. the
  "maybeAct dedup is keyed on phase, not just correlation id" and "Correlation ID dedup" suites)
  — no regressions.
- Confirmed `evictExpired` has zero remaining references anywhere in the package (`git grep
  evictExpired` → no hits).

## Use cases / behaviors to keep in mind for review

- The fix is narrowly scoped to `DedupCache.set` / `evictOldest`; no call-site changes elsewhere
  needed since `DedupCache`'s public interface (`get`/`has`/`set`) is unchanged.
- The correctness argument for the O(1) `evictOldest` (no expiry scan) rests on a documented
  invariant: **all entries share the same constant `ttlMs`** per `DedupCache` instance (see
  constructor — `ttlMs` is fixed at construction, never varies per-`set` call). If that invariant
  were ever broken (e.g. a future per-entry TTL), insertion order and expiry order could diverge
  and this eviction logic would need revisiting — worth a second look during review that no
  such per-call TTL override exists or is planned nearby.
- No new edge cases beyond the two new specs were identified during this implement pass — this is
  a small, self-contained fix; the reviewer's usual adversarial pass (concurrent-mutation
  assumptions, off-by-one on eviction ordering, etc.) is still the floor, not a formality.

## Gaps / known limitations

- None identified. This is a small, mechanical fix with direct test coverage of the two
  previously-buggy behaviors, confirmed against the full suite.
