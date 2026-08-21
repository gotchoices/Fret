description: Added a test proving the periodic cleanup timer for two small internal tracking tables is actually wired up — before this, nothing would have noticed if that wiring broke.
files: packages/fret/test/profile.behavior.spec.ts (new test at line 386, inside `Bounded internal map capacities`), packages/fret/src/service/fret-service.ts (code under test: `stabilizeOnce` line 2246, `sweepBoundedMaps` line 3084, `pruneBackoffMap` line 3068 — unmodified by this ticket)
----

## What changed

One new test in `packages/fret/test/profile.behavior.spec.ts`, `'stabilizeOnce sweeps expired
entries from backoffMap and departureDebounce'`, inside the existing `Bounded internal map
capacities` describe block. Plus one import: `ExpiringMap` from `../src/utils/expiring-map.js`.

No production code (`src/`) was touched — this is a pure test addition closing a coverage gap.

## What the test proves

`stabilizeOnce` opens every maintenance tick with `this.sweepBoundedMaps()`, which sweeps two
`ExpiringMap`s (`backoffMap`, TTL 5 min; `departureDebounce`, TTL 2 s) and separately prunes
`backoffMap` entries for peers no longer in the routing store. The map-capacity defaults were
already covered, and `ExpiringMap`'s own expiry logic is covered in isolation — but nothing
proved `stabilizeOnce` actually *calls* the sweep. A silent disconnect (e.g. someone refactors
`stabilizeOnce` and drops the `sweepBoundedMaps()` call) would have gone unnoticed indefinitely.

The test starts a real `CoreFretService` (`createService('core')`), swaps `backoffMap` and
`departureDebounce` for fresh `ExpiringMap`s built with an injected fake clock (same idiom as
`ring-membership.spec.ts:455-482`), seeds one expired entry and one surviving entry in each map,
calls `await (svc as any).stabilizeOnce()` directly, and asserts the expired entries are gone
while the survivors remain. The surviving entries are what rule out a false-positive "sweep
clears everything unconditionally" implementation — asserting only that expired entries vanish
would not catch that.

One wrinkle handled: `pruneBackoffMap` drops any `backoffMap` entry whose peer id isn't in the
routing store, regardless of TTL — so the backoffMap survivor uses the service's own
`selfIdStr` (always present in the store) rather than an arbitrary id, or `pruneBackoffMap` would
remove it for the wrong reason.

## Validation performed

- `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js
  "test/profile.behavior.spec.ts" --timeout 30000` — new test passes; 32 passing / 2 failing
  overall, both pre-existing failures on lines this ticket never touched (see below).
- `cd packages/fret && npx tsc --noEmit` — no new errors from this ticket's import/test; existing
  errors are the same pre-existing issue (see below).

## Known gap — pre-existing failures, NOT from this ticket

Both `tsc --noEmit` and the runtime mocha run surface unrelated failures in code this ticket did
not touch, all the same shape: a `getDiagnostics().rejected.*`-derived value used in arithmetic
or a numeric assertion is now non-numeric (tsc: "must be of type any/number/bigint/enum"; runtime:
`expected [object Object] to be a number` / `expected NaN to equal 3`). Confirmed spanning
multiple spec files this ticket never opened (`announce-rate-limit.spec.ts`,
`inflight-concurrency.spec.ts`, `rpc.codec-properties.spec.ts`, `rpc.handler-fuzz.spec.ts`) plus
two untouched lines in `profile.behavior.spec.ts` itself (251, 341 — both above the new test at
386). Filed to `tickets/.pre-existing-error.md` for the automatic triage pass per
`tickets/AGENTS.md` protocol — not investigated further here since it is out of this ticket's
scope and predates its change.

## Suggested reviewer focus

- Confirm the fake-clock swap doesn't leak a live `ExpiringMap` reference anywhere `stop()`
  expects the original (it doesn't — the test doesn't call `stop()`, relies on `createService`'s
  own cleanup).
- Confirm the `selfIdStr` choice for the backoffMap survivor is the right call given
  `pruneBackoffMap`'s store-membership rule (reasoning above).
- No new production code — review is effectively test-only.
