description: The duplicate-request cache no longer throws away a live, still-valid entry when it shouldn't. Reviewed, and the two regression tests that shipped with the fix were rewritten because they passed against the old broken code.
files: packages/fret/src/service/dedup-cache.ts, packages/fret/test/dedup-cache.spec.ts, docs/fret.md, docs/threat-analysis.md
difficulty: easy
----
## Outcome

The fix itself (landed in commit `9d3390d`) is correct and stands as written. Review rewrote one
of its two regression tests, added three more, added a clock-assumption note at the eviction
site, and updated two design/security documents that still described the removed code path.

## What the fix does

`DedupCache.set` handles an already-present key first — `delete` then `set` — so a refresh
(a) never counts as growth and therefore never triggers eviction, and (b) lands at the newest
`Map`-iteration-order slot with a fresh expiry, so it is not mistaken for the oldest entry.
`evictOldest`, reached only on a genuine insert at capacity, deletes the map's first key with no
expiry scan: under the cache's single constant `ttlMs`, insertion order and expiry order are the
same order, so the oldest-inserted entry is also the one nearest to expiry. The old `evictExpired`
O(n) sweep was removed.

## Review findings

**Checked**: the full implement-stage diff read before the handoff summary; the invariant the
O(1) `evictOldest` rests on (constant TTL, refresh re-insertion, clock monotonicity); capacity
boundary and off-by-one behaviour; the reachability of the refresh path in production
(`handleMaybeAct` returns a cached answer early, so a refresh only happens when two requests
sharing a correlation id are in flight concurrently — the bug was live, not theoretical); the
security framing in `docs/fret.md` and `docs/threat-analysis.md`; every remaining reference to
`evictExpired` across `src/`, `test/` and `docs/`; `DedupCache`'s single call site in
`fret-service.ts`; source hygiene (the file is ~55 lines, three short methods).

**Major findings** — none. The eviction logic is correct and the argument behind the O(1)
`evictOldest` holds.

**Minor findings, all fixed in this pass:**

- *Both new regression tests passed against the pre-fix code* — they pinned nothing. Both
  refreshed key `'a'`, which was the **oldest** key, and refreshing the oldest key is the one case
  the buggy `set` got right by accident: it evicted that key as "oldest" and immediately
  re-inserted it, so no unrelated entry was lost. Verified by replaying both specs against the
  old implementation verbatim — both green. The bug only shows when the refreshed key is *not*
  the oldest, where the blind `evictOldest` destroys an unrelated live entry. The first spec is
  rewritten to refresh a middle key (it now fails against the old code, as a regression guard
  must). The second spec is kept as written: it does not fail against the historical bug, but it
  does fail if the `delete` is ever dropped in favour of a plain `Map.set` — the realistic future
  regression — and a comment at each spec now records which shape it guards, so neither is
  weakened back into vacuity by a later edit.
- *Removing `evictExpired` left its replacement invariant untested.* Added a spec that at
  capacity the victim is an expired entry and live entries survive — this is the property that
  makes dropping the expiry scan safe, and nothing exercised it.
- *Two behaviours introduced by the fix had no coverage.* Added specs for repeated refreshes of
  one key never evicting the others, and for a refresh restarting the entry's TTL.
- *Documentation was stale in two places.* `docs/threat-analysis.md` §3.6 (Dedup Cache Poisoning)
  described the eviction path as "`evictExpired` runs first, then `evictOldest`" — naming a method
  that no longer exists. Its status block now records the current single-step eviction and that a
  refresh cannot evict. `docs/fret.md`'s dedup-cache bullet reasons explicitly about entries
  "evicted before their TTL" being a replay hole but never said which entry is chosen; it now
  states the victim rule and the refresh exemption.

**Tripwire (recorded, not ticketed):** the insertion-order-equals-expiry-order invariant assumes
`Date.now()` is non-decreasing. A backwards wall-clock step can leave a live entry ahead of an
expired one, so a single eviction picks the wrong victim; it self-corrects on the next insert.
Parked as a `NOTE:` at `evictOldest` in `packages/fret/src/service/dedup-cache.ts`, pointing at a
monotonic clock source rather than a reintroduced scan as the fix if it ever matters.

**Considered and not filed:** `has()` is implemented as `get(key) !== undefined`, so it cannot
distinguish a stored `undefined` and it mutates (expiry-deletes) on a read. Both predate this
change, are outside the diff, and are unreachable at the one call site (`DedupCache<NearAnchorV1 |
{ commitCertificate: string }>` never stores `undefined`). A `maxSize` of 0 yields a cache holding
one entry rather than none — also pre-existing, and unreachable since capacity is always 2048 or
512. No ticket for either.

## Verification

- `npx tsc --noEmit` from `packages/fret/`: clean.
- `yarn build`: clean.
- `packages/fret/test/dedup-cache.spec.ts`: **10 passing** (7 before this pass, 3 added).
- Full suite (`yarn test` from `packages/fret/`): **414 passing**, 0 failing, ~7 minutes. No
  pre-existing failures surfaced.
