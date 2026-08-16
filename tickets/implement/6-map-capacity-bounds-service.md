---
description: Two internal bookkeeping tables inside the main FRET service still have no stated size limit. Give them explicit limits and a regular tidy-up, matching the shared utility that already landed for the other two.
files: packages/fret/src/utils/expiring-map.ts (landed), packages/fret/src/service/fret-service.ts, packages/fret/test/expiring-map.spec.ts (new), packages/fret/test/ring-membership.spec.ts, packages/fret/test/profile.behavior.spec.ts, packages/fret/test/peer-discovery.spec.ts, docs/fret.md
difficulty: medium
---

Continuation of `map-capacity-bounds`, which was cut short by a budget warning after Phase 1
and the discovery call site landed. **Read the original ticket's reasoning in git history
(`tickets/implement/6-map-capacity-bounds.md`, deleted in the same commit) if any of the
constants below need re-justifying** — the design rationale is reproduced where it matters.

## What already landed (do not redo)

- **`packages/fret/src/utils/expiring-map.ts`** — new `ExpiringMap<V>`: a `Map<string, {value,
  expiresAt}>` with one constant TTL and a hard capacity. Surface: `size`, `get`, `has`, `set`,
  `delete`, `keys(): string[]` (live-key array snapshot), `clear()`, `sweep(): number`.
  Constructor takes `{ capacity, ttlMs, now? }`; capacity and TTL are both clamped rather than
  thrown on (capacity → ≥ 1, non-finite → 1; TTL → ≥ 0).
- **`DedupCache` re-expressed on it**, keeping `DEDUP_TTL_MS`, its `Clock` type and its
  `get`/`has`/`set` surface. `test/dedup-cache.spec.ts` passes **unchanged** — verified.
- **`FretPeerDiscovery.emitted`** is now `ExpiringMap<number>` with TTL `debounceMs` and capacity
  from a new `FretPeerDiscoveryConfig.maxTracked` (default 4096). `pruneExpired` is deleted and
  `scan` ends with an unconditional `this.emitted.sweep()`, which is what fixes the
  never-shrinks behavior of the old `size <= 4096` early return.
- **`Libp2pFretService`** supplies `maxTracked` from the profile (Core 4096 / Edge 1024), merged
  so an explicit `discoveryCfg` value still wins.
- `npx tsc --noEmit` is clean; `test/dedup-cache.spec.ts` + `test/peer-discovery.spec.ts` pass
  (27 passing). **No other spec has been run since the change** — the full suite is unverified.

### One deviation from the original design, already committed to code

The original ticket specified that an insert at capacity should `sweep()` first and only drop
the first key if the sweep freed nothing. That is O(n) per insert whenever the map is full of
live entries — which is exactly the `DedupCache` case the same ticket says must stay O(1),
since that map is churned at attacker rate. Under a single constant TTL the first key **is**
the nearest-expiry entry (and is expired whenever anything is), so `set` just drops the first
key: O(1), same victim, no scan. `sweep()` stays a full scan and is called from the periodic
ticks instead. Both properties the ticket asked to pin still hold — capacity never exceeded,
victim is always the nearest-expiry entry, a live entry is never sacrificed while a dead one
remains — and `dedup-cache.spec.ts`'s "evicts an expired entry rather than a live one" passes
unchanged. Reasoning is in the `NOTE:` at `evictNearestExpiry`.

## Remaining work

### `FretService.backoffMap` — read this before touching it

`getBackoffPenalty` (`fret-service.ts:2116`) deliberately **keeps** an entry whose `until` has
passed, so the next `recordBackoff` doubles `factor` instead of restarting at 1. That escalation
is load-bearing: the foreign/dead re-probe passes rely on it to taper a genuinely-foreign peer
toward ~once/32 s. So the map's *retention* lifetime is not the backoff window:

- `until` stays inside the value and keeps its meaning; `getBackoffPenalty` is unchanged and
  still returns 0 for an expired-but-retained entry.
- The `ExpiringMap` TTL is a separate `BACKOFF_RETAIN_MS = 300_000` (5 min), measured from the
  last `recordBackoff`. Meaning: *forget a peer's escalation once it has gone five minutes
  without failing again.*
- The constraint that picks that number: it must comfortably exceed the maximum backoff window
  (`baseMs` 1000 × max factor 32 = 32 s), or a peer re-probed at the slowest cadence would have
  its entry forgotten between probes and its factor silently reset to 1. 5 min is ~9× that.
  **Pin the inequality in a test.** `baseMs` and the 32 cap are currently inline literals in
  `recordBackoff` / `getBackoffPenalty`; promoting them to `private static readonly`
  (`BACKOFF_BASE_MS`, `BACKOFF_MAX_FACTOR`) is what makes that test assert on the real constants
  rather than on copies.
- Capacity: **Core `cfg.capacity` (2048 default), Edge `Math.min(cfg.capacity, 512)`.** An entry
  for a peer no longer in the store is dropped by `pruneBackoffMap` next tick anyway, so the
  store's capacity is the only ceiling that can ever be useful; Edge trades that worst case for
  memory. A wrong eviction costs one earlier probe of the stalest-failing peer.
- `pruneBackoffMap`'s store-membership prune is **orthogonal to expiry and must survive** — it
  drops entries whose peer left the store, which no TTL can see. It iterates
  `backoffMap.keys()`, which is now an array snapshot (safe to delete while walking).

### `FretService.departureDebounce`

- Becomes `ExpiringMap<number>` with TTL `DEPARTURE_DEBOUNCE_MS` (2000). Presence means
  "recently announced for this coordinate region", so `announceOnDeparture`
  (`fret-service.ts:1352`) simplifies to `if (this.departureDebounce.has(regionKey)) return;`
  followed by the `set`. The inline prune loop at `fret-service.ts:1360-1362` is deleted.
- Capacity: **Core 512, Edge 128.** Live size is bounded by departures per 2 s window; Core's
  512 leaves 256 departures/s of headroom. A wrong eviction costs one extra announce burst,
  which `bucketAnnounce` already caps globally — the cheapest of the three to get wrong. Note
  that at the constant.

### Sweep placement

`FretService` gains one private `sweepBoundedMaps()` called at the **top of `stabilizeOnce`**
(`fret-service.ts:1583`): `backoffMap.sweep()`, `departureDebounce.sweep()`, then the existing
store-membership `pruneBackoffMap()`. Remove the `pruneBackoffMap()` call from
`reprobeExcludedPeers` (`fret-service.ts:1687`) — sweeping is not a probe pass's job, and it
stays once per tick either way since `stabilizeOnce` is its only caller.

`FretPeerDiscovery` already sweeps its own map on its own 5 s interval. A single shared sweep
was considered and rejected: `FretPeerDiscovery` is constructed **before** the libp2p node and
therefore before `FretService` exists, which is why `DiscoverySnapshotSource` is a lazy thunk.

### Lifecycle

`FretService.stop()` must `clear()` both maps, mirroring `FretPeerDiscovery.stop()`'s existing
`emitted.clear()`. A start→stop→start cycle is a fresh run; carrying a peer's backoff escalation
across it is the same mistake as carrying `negotiateFailures` across a restart, which the store
already forbids.

## Tests still owed

`packages/fret/test/expiring-map.spec.ts` **does not exist yet** — it is the largest single
remaining item. House style for property tests is `fast-check` (already a dev dependency; see
`test/nexthop-cost.spec.ts`, `test/cohort.properties.spec.ts`). Cover:

- **Refresh must not become the eviction victim.** Re-`set` an existing key at capacity: nothing
  is evicted, and the refreshed key is now last in eviction order.
- **Eviction victim is the nearest-expiry entry** — the first-inserted under a constant TTL, not
  an arbitrary one and not the newest.
- **Capacity is never exceeded** over an arbitrary interleaving of `set` / `get` / `delete` /
  `sweep` / clock advances (`fast-check` property).
- **Degenerate capacities.** 0 and negative clamp to 1; capacity 1 still behaves (insert,
  insert, size 1, second key wins).
- **Sweep with nothing expired, everything expired, and an empty map** — right count, map still
  usable after each.
- **`keys()` is a snapshot**: deleting from the map while walking the returned array is safe.
- **Expiry boundary is `expiresAt < now`** — an entry is still live *at* its expiry instant
  (`dedup-cache.spec.ts` pins this for the wrapper; pin it directly here too).

Elsewhere:

- `test/ring-membership.spec.ts`, in the existing `Foreign re-probe backoff growth` describe
  (its two specs already reach into `(svc as any).backoffMap` via `get`/`set`/`has` and still
  pass against `ExpiringMap`): add **backoff escalation survives an expired window** —
  `recordBackoff`, step past `until` but well inside `BACKOFF_RETAIN_MS`, `recordBackoff` again
  → factor is 2, not 1; **escalation resets after retention** — past `BACKOFF_RETAIN_MS` with no
  further failure the entry is gone and the next `recordBackoff` starts at factor 1 (this is the
  intended behavior *change* vs today, where an entry lived as long as its peer was in the
  store); and the standalone **`BACKOFF_RETAIN_MS > BACKOFF_BASE_MS × BACKOFF_MAX_FACTOR`**
  assertion so a future tuning of either constant fails loudly. Note that `backoffMap` is
  constructed with the wall clock, so these tests need to manipulate `until` directly (as the
  existing specs do) rather than step a fake clock — or the map needs an injectable clock.
- `test/profile.behavior.spec.ts` — add the three new per-profile caps (discovery `maxTracked`
  4096/1024, `backoffMap` capacity 2048/512, `departureDebounce` capacity 512/128) alongside the
  existing bucket/fanout assertions rather than starting a fourth profile spec.
- `test/peer-discovery.spec.ts` — add the **cap / re-emission** test: emit more than `maxTracked`
  distinct members, confirm the map stays at the cap **and** that an evicted peer is emitted
  again on a later tick. A silently-dropped-forever peer would be the real bug here.
- `pruneBackoffMap` still drops entries for peers evicted from the store, **including unexpired
  ones** — already covered by `ring-membership.spec.ts`'s "backoff caps at factor 32 and prunes
  evicted peers"; make sure it stays green, it is easy to break along with the inline prune loops.
- Departure debounce still debounces: two departures for the same coordinate inside 2 s produce
  one announce, outside 2 s produce two. `test/proactive-announce.spec.ts` and
  `test/churn.leave.spec.ts` cover the surrounding behavior — both must stay green.
- Persistence is unaffected: none of these maps is serialized; `exportTable` / `importTable` must
  not grow a field.

## TODO

- `fret-service.ts`: swap `backoffMap` to `ExpiringMap<{ until: number; factor: number }>` with
  `BACKOFF_RETAIN_MS`; swap `departureDebounce` to `ExpiringMap<number>`; size both from the
  profile in the constructor next to the other profile-tuned constants; add `sweepBoundedMaps()`
  at the top of `stabilizeOnce`; drop the `pruneBackoffMap()` call from `reprobeExcludedPeers`;
  delete the inline prune loop in `announceOnDeparture`; clear both maps in `stop()`.
- Write `packages/fret/test/expiring-map.spec.ts` per the list above.
- Add the backoff-retention and per-profile-cap tests; add the discovery cap/re-emission test.
- `cd packages/fret && npx tsc --noEmit`, then `yarn test` from `packages/fret` — **the full
  suite has not been run since `ExpiringMap` landed**, so treat the first full run as the real
  gate, not a formality (foreground, no redirection).
- Update `docs/fret.md`: one line under *libp2p integration* noting the discovery debounce map is
  capacity-bounded and profile-tuned, and one under *Security and abuse considerations → Current
  state* noting that the backoff and departure-debounce maps carry explicit profile-tuned
  capacities with periodic sweeps. Do not add a new section — these are sentences in existing
  ones.
