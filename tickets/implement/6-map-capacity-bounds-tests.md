description: The size limits for the main service's two internal bookkeeping tables are now in the code, but the tests that would catch someone quietly re-tuning them are still missing. Add those tests and run the full suite.
files: packages/fret/src/service/fret-service.ts (changed, done), packages/fret/src/utils/expiring-map.ts (unchanged), packages/fret/test/expiring-map.spec.ts (new, done), packages/fret/test/ring-membership.spec.ts, packages/fret/test/profile.behavior.spec.ts, packages/fret/test/peer-discovery.spec.ts, docs/fret.md (updated, done)
difficulty: easy
---

Continuation of `map-capacity-bounds-service`, cut short by a budget warning after the source
change, `expiring-map.spec.ts`, and the doc updates all landed. **The production change is
complete and green** — what is left is three test additions and the full-suite gate.

## What already landed (do not redo)

- **`fret-service.ts`**
  - `backoffMap` is now `ExpiringMap<{ until: number; factor: number }>`, TTL
    `BACKOFF_RETAIN_MS = 300_000`, capacity Core `cfg.capacity` (2048 default) / Edge
    `Math.min(cfg.capacity, 512)`, built in the constructor next to `dedupCache`.
  - `departureDebounce` is now `ExpiringMap<number>`, TTL `DEPARTURE_DEBOUNCE_MS` (2000),
    capacity Core 512 / Edge 128. `announceOnDeparture` is now
    `if (this.departureDebounce.has(regionKey)) return;` + `set`; the inline prune loop is gone.
  - `BACKOFF_BASE_MS` (1000) and `BACKOFF_MAX_FACTOR` (32) promoted from inline literals to
    `private static readonly`, so a test can assert on the real constants.
    `recordBackoff` / `getBackoffPenalty` use them; `getBackoffPenalty` still returns 0 for an
    expired-but-retained entry, so the escalation behavior is unchanged.
  - New `sweepBoundedMaps()` — `backoffMap.sweep()`, `departureDebounce.sweep()`,
    `pruneBackoffMap()` — called at the **top of `stabilizeOnce`**. The `pruneBackoffMap()` call
    was removed from `reprobeExcludedPeers`.
  - `stop()` clears both maps, after the leave fan-out.
- **`docs/fret.md`** — both sentences added (libp2p integration bullet; *Security and abuse
  considerations → Current state*).
- **`packages/fret/test/expiring-map.spec.ts`** — written, 24 specs, all passing. Covers refresh
  not becoming the victim, nearest-expiry victim, expired-before-live eviction, degenerate
  capacities/TTLs, the `expiresAt < now` boundary (incl. `keys()`/`sweep()` agreeing at it),
  sweep with nothing/everything/mixed/empty, burst-then-sweep shrink, `keys()` snapshot safety,
  `clear`, `delete`, plus two `fast-check` properties (capacity never exceeded over arbitrary
  interleavings; last-written value readable while capacity never binds).
- `npx tsc --noEmit` clean. Verified green together (104 passing):
  `expiring-map.spec.ts`, `dedup-cache.spec.ts`, `peer-discovery.spec.ts`,
  `ring-membership.spec.ts`, `proactive-announce.spec.ts`, `churn.leave.spec.ts`.

### One behavior change worth knowing when writing the tests

Today an entry lived in `backoffMap` as long as its peer was in the store. Now it is forgotten
5 minutes after the last `recordBackoff`, so the next failure starts at factor 1. That is the
intended change; the second test below is what pins it.

### One deliberate boundary shift in the departure debounce

The old test was `now - lastAnnounce < 2000` — at *exactly* 2000 ms elapsed it announced again.
The new test is map presence, and `ExpiringMap` treats an entry as live *at* its expiry instant,
so at exactly 2000 ms it is still debounced. A one-instant difference at a boundary no test
lands on (`proactive-announce.spec.ts` / `churn.leave.spec.ts` both pass unchanged), recorded
here so it is not rediscovered as a defect.

## Remaining work

### `test/ring-membership.spec.ts` — `Foreign re-probe backoff growth` describe

The two existing specs there reach into `(svc as any).backoffMap` via `get`/`set`/`has` and
already pass against `ExpiringMap`. Add three:

- **Backoff escalation survives an expired window.** `recordBackoff`, step `until` into the past
  (as the existing specs do: `bo.set(id, { ...bo.get(id)!, until: Date.now() - 1 })`) but stay
  well inside `BACKOFF_RETAIN_MS`, `recordBackoff` again → factor is 2, not 1.
- **Escalation resets after retention.** Past `BACKOFF_RETAIN_MS` with no further failure the
  entry is gone and the next `recordBackoff` starts at factor 1. `backoffMap` is constructed with
  the wall clock, so 5 minutes cannot be waited out: swap in a fake-clock map after `start()` —
  `(svc as any).backoffMap = new ExpiringMap({ capacity: 8, ttlMs: (FretService as any).BACKOFF_RETAIN_MS, now: clock.now })`
  — then advance the fake clock. (`until` is still stamped from `Date.now()`; that is fine,
  because this test is about *retention*, not about the window.) Note in the test why the swap
  exists, so a reader does not take it for a fake-clock service.
- **The inequality, standalone**: `BACKOFF_RETAIN_MS > BACKOFF_BASE_MS × BACKOFF_MAX_FACTOR`,
  read off `FretService` (they are `private static readonly`, so `(FretService as any).X`) rather
  than off copies, so retuning either side fails loudly.

`pruneBackoffMap` must still drop entries for peers no longer in the store *including unexpired
ones* — already covered by the existing "backoff caps at factor 32 and prunes evicted peers";
confirm it stays green.

### `test/profile.behavior.spec.ts`

Add the three new per-profile caps alongside the existing bucket / fanout assertions (do not
start a fourth profile spec file):

- `(svc as any).backoffMap.capacity` — Core 2048 (i.e. `cfg.capacity`), Edge 512. Note the
  existing `createService` helper passes no `capacity`, so the default applies.
- `(svc as any).departureDebounce.capacity` — Core 512, Edge 128.
- discovery `maxTracked` — Core 4096 / Edge 1024. This one lives on `Libp2pFretService`, not
  `FretService`: build a `Libp2pFretService` per profile and read
  `(svc[peerDiscoverySymbol] as any).emitted.capacity`. If that reach is too deep for this file,
  put it in `peer-discovery.spec.ts`'s `Libp2pFretService discovery wiring` describe instead and
  say so — but do not skip it, the merge that lets an explicit `discoveryCfg.maxTracked` win is
  otherwise untested.

### `test/peer-discovery.spec.ts` — cap / re-emission

Emit more than `maxTracked` distinct members and confirm the debounce map stays at the cap
**and** that an evicted peer is emitted again on a later tick. A peer silently dropped forever
would be the real bug. Use a small `maxTracked` (e.g. 3) with a long `debounceMs` and a small
`batchSize` so the cap binds before the window; the store fixture helper `makeStore` is already
there. Peer ids must be real (`createMemNode`), since `scan` calls `peerIdFromString`.

## TODO

- Add the three backoff tests to `test/ring-membership.spec.ts`.
- Add the per-profile capacity assertions (`profile.behavior.spec.ts`, plus the discovery
  `maxTracked` one wherever it fits best).
- Add the discovery cap / re-emission test to `test/peer-discovery.spec.ts`.
- `cd packages/fret && npx tsc --noEmit`, then `yarn test` from `packages/fret` — **the full
  suite has still not been run since `ExpiringMap` landed**, so treat the first full run as the
  real gate, not a formality (foreground, no redirection). Persistence is unaffected — none of
  these maps is serialized, so `exportTable` / `importTable` must not grow a field; if
  `service.table-persistence.spec.ts` or `digitree.persistence.spec.ts` moves, something is wrong.
