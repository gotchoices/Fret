---
description: Three internal bookkeeping tables have no hard size limit and are only tidied when certain events happen, so their memory ceiling depends on unrelated settings elsewhere instead of being stated outright. Give each one an explicit limit and a regular tidy-up.
files: packages/fret/src/utils/expiring-map.ts (new), packages/fret/src/service/dedup-cache.ts, packages/fret/src/service/peer-discovery.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/service/libp2p-fret-service.ts, packages/fret/test/expiring-map.spec.ts (new), packages/fret/test/dedup-cache.spec.ts, packages/fret/test/peer-discovery.spec.ts, docs/fret.md
difficulty: medium
---

## What is actually wrong

Three maps hold short-lived bookkeeping keyed by peer id (or ring coordinate). None of them
declares a capacity, and each prunes on a different ad-hoc trigger:

| map | file | key | value lifetime | current prune |
|---|---|---|---|---|
| `FretPeerDiscovery.emitted` | `service/peer-discovery.ts:59` | peer id | `debounceMs` (600 s) | expired-only, and only once `size > 4096` |
| `FretService.backoffMap` | `service/fret-service.ts:176` | peer id | until cleared | `pruneBackoffMap()` once per stabilization tick — drops entries whose peer left the store |
| `FretService.departureDebounce` | `service/fret-service.ts:182` | ring coord (base64url) | 2 s | expired-only, and only on a departure event once `size > 256` |

**Honest scoping — measured against the code, not assumed.** Each of these already has an
*emergent* ceiling, so this is hardening, not a live memory exhaustion bug:

- `emitted` only grows for peers that reach `membership === 'member'`, which needs a real
  transport-authenticated peer serving this network's protocol, and emission is capped at
  `batchSize`/tick (20 per 5 s). Steady-state live entries ≈ 4 /s × 600 s = 2400. But
  `pruneExpired` returns early at `size <= 4096`, so after any burst the map **holds up to 4096
  mostly-expired entries forever** and never shrinks. That is the one genuinely wrong behavior
  here, and it is a leak of stale keys rather than unbounded growth.
- `backoffMap` is re-bounded to the store's population once per tick, so its ceiling is
  "store capacity (2048) + whatever accrues between two ticks". The ticket's original wording
  ("only pruned lazily") predates `pruneBackoffMap`; it is stated correctly above.
- `departureDebounce` prunes on every departure past 256 entries with a 4 s expiry cut-off, so
  its ceiling is 256 + (departure rate × 4 s), and departures require authenticated connections.

So the defect to fix is **that every one of those ceilings is a side effect of some other
subsystem's setting** — store capacity, tick cadence, emission batch rate. Change any of those
and these maps silently re-size, with nothing at the site saying so. The fix is rung 1 of the
architecture ladder: one small type that makes "a bookkeeping map with no capacity" unwritable
at these sites, so the bound is a stated property rather than an emergent one.

## Design

### One utility: `ExpiringMap<V>`

New `packages/fret/src/utils/expiring-map.ts`. A `Map<string, { value: V; expiresAt: number }>`
with a **single, constant TTL** and a hard capacity.

```ts
export type Clock = () => number;

export interface ExpiringMapOptions {
	/** Hard maximum live entries. Clamped to ≥ 1. */
	capacity: number;
	/** Entry lifetime in ms, measured from the last write of that key. */
	ttlMs: number;
	/** Injectable for deterministic tests; defaults to Date.now. */
	now?: Clock;
}

export class ExpiringMap<V> {
	constructor(opts: ExpiringMapOptions);
	get size(): number;
	/** Undefined once expired; deletes the expired entry as a side effect. */
	get(key: string): V | undefined;
	has(key: string): boolean;
	/** Refresh-or-insert. Refresh never evicts; insert at capacity evicts one entry. */
	set(key: string, value: V): void;
	delete(key: string): boolean;
	/** Snapshot of live keys — safe to mutate the map while iterating the result. */
	keys(): string[];
	clear(): void;
	/** Drop every expired entry. Returns how many were dropped. */
	sweep(): number;
}
```

Two rules make it correct and cheap:

- **`set` on an existing key deletes before re-inserting.** JavaScript `Map` keeps a re-`set`
  key at its *original* iteration position, so without the delete a just-refreshed entry still
  looks like the oldest one and would be chosen as the eviction victim — exactly the failure
  the ticket names. `DedupCache.set` already does this; the rule moves here.
- **Constant TTL ⇒ insertion order *is* expiry order**, so the entry nearest to expiry is the
  first key in `Map` iteration order and eviction is O(1) with no scan. On insert at capacity:
  `sweep()` first (free the genuinely dead), and if that frees nothing, drop the first key.

`DedupCache` is **re-expressed on top of `ExpiringMap`**, keeping its name, its `DEDUP_TTL_MS`
export, its `Clock` type and its `get`/`has`/`set` surface. Its existing spec is the regression
net: it must pass unchanged. Its O(1) eviction property is preserved exactly (same rule, moved),
which matters because the dedup cache is the one map on this list churned at *attacker* rate —
an O(n) eviction there would be a CPU denial-of-service.

**Tripwire to record in `expiring-map.ts` as a `NOTE:`** — the O(1) eviction depends on every
entry sharing one TTL. A future caller wanting per-entry TTLs breaks the insertion-order ⇒
expiry-order equivalence and needs a real nearest-expiry search, not a first-key delete.

### Map 1 — `FretPeerDiscovery.emitted`

- Becomes `ExpiringMap<number>` (value = emission timestamp, kept for diagnostics only;
  **presence alone means "debounced"**), TTL `debounceMs`.
- New `FretPeerDiscoveryConfig.maxTracked`, default 4096. `Libp2pFretService` supplies it from
  the FRET profile: **Core 4096, Edge 1024**, merged under any caller-supplied `discoveryCfg`
  so an explicit value still wins.
- `scan`'s debounce check becomes `if (this.emitted.has(entry.id)) continue;`.
- `pruneExpired` is deleted; `scan` ends with an unconditional `this.emitted.sweep()`. Dropping
  the `size <= 4096` early return is what fixes the never-shrinks behavior.
- **Edge's cap binds before its TTL does and that is intended.** At default rates the live
  population is ~2400 entries, so an Edge node evicts before the 600 s debounce lapses,
  effectively shortening the debounce to ≈ `maxTracked / (batchSize / emissionIntervalMs)` ≈
  256 s. The cost of a wrong eviction is one extra emission of that peer, which is idempotent in
  libp2p's peerStore and already rate-capped by `batchSize`. Say this in a comment at the cap.

### Map 2 — `FretService.backoffMap`

**Read this before touching it — the obvious wiring is wrong.** `getBackoffPenalty`
(`fret-service.ts:2116`) deliberately *keeps* an entry whose `until` has passed, so the next
`recordBackoff` doubles `factor` instead of restarting at 1. That escalation is load-bearing:
the foreign/dead re-probe passes rely on it to taper a genuinely-foreign peer toward ~once/32 s.

So the map's retention lifetime is **not** the backoff window:

- `until` stays inside the *value* and keeps its current meaning; `getBackoffPenalty` is
  unchanged and still returns 0 for an expired-but-retained entry.
- The `ExpiringMap` TTL is a separate `BACKOFF_RETAIN_MS = 300_000` (5 min), measured from the
  last `recordBackoff`. Meaning: *forget a peer's escalation once it has gone five minutes
  without failing again.*
- The constraint that picks that number: it must comfortably exceed the maximum backoff window
  (`baseMs 1000 × maxFactor 32` = 32 s), or a peer being re-probed at the slowest cadence would
  have its entry forgotten between probes and its factor reset to 1 — silently undoing the
  taper. 5 min is ~9× that, leaving room for a peer that waits several ticks for a slot in the
  saturated foreign re-probe budget. **Pin the inequality in a test**, not just a comment.

Capacity: **Core `cfg.capacity` (2048 by default), Edge `Math.min(cfg.capacity, 512)`.** An
entry for a peer no longer in the store is dropped by `pruneBackoffMap` on the next tick anyway,
so the store's own capacity is the only ceiling that can ever be useful; Edge trades that
worst case for memory. A wrong eviction costs one earlier probe of the stalest-failing peer.

`pruneBackoffMap`'s store-membership prune is orthogonal to expiry and **must survive** — it
drops entries whose peer left the store, which no TTL can see. It iterates `backoffMap.keys()`,
which is now the array snapshot above.

### Map 3 — `FretService.departureDebounce`

- Becomes `ExpiringMap<number>` with TTL `DEPARTURE_DEBOUNCE_MS` (2000). Presence means
  "recently announced for this coordinate region", so `announceOnDeparture` simplifies to
  `if (this.departureDebounce.has(regionKey)) return;` followed by the `set`. The inline prune
  loop at `fret-service.ts:1360-1362` is deleted.
- Capacity: **Core 512, Edge 128.** Live size is bounded by departures per 2 s window; Core's
  512 leaves 256 departures/s of headroom.
- A wrong eviction costs one extra announce burst, which `bucketAnnounce` already caps
  globally — so this is the cheapest of the three to get wrong. Note that at the constant.

### Sweep placement: per-map, at each map's own existing tick — deliberately not one shared sweep

- `FretService` gains one private `sweepBoundedMaps()` called at the **top of `stabilizeOnce`**:
  `backoffMap.sweep()`, `departureDebounce.sweep()`, then the existing store-membership prune of
  `backoffMap`. Remove the `pruneBackoffMap()` call from `reprobeExcludedPeers`
  (`fret-service.ts:1687`) — sweeping is not a probe pass's job, and it stays once per tick
  either way since `stabilizeOnce` is the only caller of `reprobeExcludedPeers`.
- `FretPeerDiscovery` sweeps its own map at the end of `scan`, on its own 5 s interval.

A single shared sweep was considered and rejected: `FretPeerDiscovery` is constructed **before**
the libp2p node and therefore before `FretService` exists — that is the entire reason
`DiscoverySnapshotSource` is a lazily-resolved thunk. Plumbing its map into `FretService`'s tick
would re-introduce the eager reference that indirection exists to avoid, to save one timer that
is already running.

### Lifecycle

`FretService.stop()` must `clear()` both of its maps, mirroring `FretPeerDiscovery.stop()`'s
existing `emitted.clear()`. A start→stop→start cycle is a fresh run — carrying a peer's backoff
escalation across it is the same category of mistake as carrying `negotiateFailures` across a
restart, which the store already forbids (`docs/fret.md`, *Ring membership*).

## Edge cases & interactions

Each of these is a test the reviewer will look for.

- **Refresh must not become the eviction victim.** Re-`set` an existing key while the map is at
  capacity: nothing is evicted, and the refreshed key is now last in eviction order. This is the
  `Map` re-`set` positioning trap; assert it directly.
- **Backoff escalation survives an expired window.** `recordBackoff`, wait past `until` but well
  inside `BACKOFF_RETAIN_MS`, `recordBackoff` again → `factor` is 2, not 1. Assert
  `BACKOFF_RETAIN_MS > baseMs * 32` as its own check so a future tuning of either constant
  fails loudly.
- **Backoff escalation resets after retention.** Past `BACKOFF_RETAIN_MS` with no further
  failure, the entry is gone and the next `recordBackoff` starts at factor 1. This is the
  intended behavior change vs today (where an entry lived as long as its peer was in the store).
- **`pruneBackoffMap` still drops entries for peers evicted from the store**, including
  unexpired ones. Regression risk: it is easy to delete along with the inline prune loops.
- **Capacity is never exceeded**, over an arbitrary interleaving of `set` / `get` / `delete` /
  `sweep` / clock advances. Property test with `fast-check` (already a dev dependency; see
  `test/nexthop-cost.spec.ts` and `test/cohort.properties.spec.ts` for the house style).
- **Eviction victim is the nearest-expiry entry**, i.e. the first-inserted under a constant TTL —
  not an arbitrary one and not the newest.
- **Degenerate capacities.** `capacity` of 0 or negative is clamped to 1 rather than producing a
  map that evicts what it just inserted (or one that throws from a constructor a caller can't
  usefully catch). `capacity` of 1 must still behave: insert, insert, size 1, second key wins.
- **Sweep with nothing expired, everything expired, and an empty map** — all no-ops that return
  the right count and leave the map usable.
- **Deletion during iteration.** `sweep` deletes while walking the backing `Map`; that is legal,
  but `keys()` returns an array snapshot so callers like `pruneBackoffMap` (which deletes as it
  iterates) are safe by construction.
- **Non-monotonic wall clock.** A backwards step can leave a live entry ahead of an expired one,
  so a single eviction picks the wrong victim; it self-corrects on the next insert. Carry
  `DedupCache`'s existing `NOTE:` about this over to `ExpiringMap` rather than dropping it — the
  remedy is a monotonic `Clock`, never a re-introduced scan.
- **`DedupCache`'s spec passes unchanged.** No signature change, no TTL change, no eviction-order
  change. If a `dedup-cache.spec.ts` assertion needs editing, the refactor is wrong.
- **Discovery: a peer evicted from `emitted` re-emits rather than disappearing.** Emit more than
  `maxTracked` distinct members and confirm the map stays at the cap while the evicted peer is
  emitted again on a later tick — a silently-dropped-forever peer would be the real bug here.
- **Self and non-member filtering are untouched** by the debounce change — the `isLiveMember` and
  `selfId` guards run before the debounce check and must keep doing so.
- **Departure debounce still debounces.** Two departures for the same coordinate inside 2 s
  produce one announce; outside 2 s, two. `test/proactive-announce.spec.ts` and
  `test/churn.leave.spec.ts` cover the surrounding behavior — both must stay green.
- **Persistence is unaffected.** None of these three maps is serialized; `exportTable` /
  `importTable` must not grow a field.
- **Profiles.** `test/profile.behavior.spec.ts` is where Edge-vs-Core constants are asserted;
  add the three new caps there rather than starting a fourth profile spec.

## TODO

### Phase 1 — the utility

- Write `packages/fret/src/utils/expiring-map.ts` per the interface above, with the two `NOTE:`
  comments (constant-TTL assumption behind O(1) eviction; non-monotonic clock).
- Write `packages/fret/test/expiring-map.spec.ts` covering the eviction-order, refresh,
  degenerate-capacity, sweep and capacity-property cases listed above.
- Re-express `DedupCache` on `ExpiringMap`, keeping `DEDUP_TTL_MS`, `Clock` and its public
  surface. Run `test/dedup-cache.spec.ts` unchanged.

### Phase 2 — the three call sites

- `peer-discovery.ts`: swap `emitted` to `ExpiringMap<number>`, add `maxTracked` to
  `FretPeerDiscoveryConfig`, delete `pruneExpired`, sweep unconditionally in `scan`.
- `libp2p-fret-service.ts`: default `maxTracked` from the profile (Core 4096 / Edge 1024),
  letting an explicit `discoveryCfg` value win.
- `fret-service.ts`: swap `backoffMap` to `ExpiringMap<{ until: number; factor: number }>` with
  `BACKOFF_RETAIN_MS`, swap `departureDebounce` to `ExpiringMap<number>`, size both from the
  profile in the constructor next to the other profile-tuned constants, add
  `sweepBoundedMaps()` at the top of `stabilizeOnce`, drop the `pruneBackoffMap()` call from
  `reprobeExcludedPeers`, delete the inline prune loop in `announceOnDeparture`, and clear both
  maps in `stop()`.

### Phase 3 — verify and document

- Extend `test/profile.behavior.spec.ts` with the three new per-profile caps.
- Add the backoff-escalation-survives-its-window test and the
  `BACKOFF_RETAIN_MS > 32 × baseMs` assertion.
- Add the discovery cap/re-emission test to `test/peer-discovery.spec.ts`.
- `cd packages/fret && npx tsc --noEmit`, then `yarn test` from `packages/fret` (foreground, no
  redirection — see the idle-timeout note in the workflow rules).
- Update `docs/fret.md`: one line under *libp2p integration* noting the discovery debounce map is
  capacity-bounded and profile-tuned, and one under *Security and abuse considerations →
  Current state* noting that the backoff and departure-debounce maps carry explicit
  profile-tuned capacities with periodic sweeps. Do not add a new section — these are sentences
  in existing ones.
