description: The service keeps two small bookkeeping tables tidy by cleaning them out on a timer; add a test proving that cleanup is actually hooked up to that timer, since nothing today would notice if it got disconnected.
files: packages/fret/src/service/fret-service.ts (`sweepBoundedMaps` ~3084, `pruneBackoffMap` ~3068, called from `stabilizeOnce` ~2246), packages/fret/test/profile.behavior.spec.ts (`Bounded internal map capacities` block, line 344-385 — add the new test inside it), packages/fret/test/ring-membership.spec.ts (lines 449-482, the fake-clock swap idiom to copy), packages/fret/src/utils/expiring-map.ts (`ExpiringMap`, injectable `now` clock)
difficulty: easy
----

## What is untested

`stabilizeOnce` (`fret-service.ts:2246`) opens every tick with `this.sweepBoundedMaps()`, which
sweeps two `ExpiringMap`s — `backoffMap` (peer probe backoff, TTL `BACKOFF_RETAIN_MS` = 5 min) and
`departureDebounce` (departure-announce debounce, TTL `DEPARTURE_DEBOUNCE_MS` = 2 s) — plus
`pruneBackoffMap()`, which separately drops any `backoffMap` entry whose peer id is no longer in
the routing store. The cap-size defaults for both maps are already covered
(`Bounded internal map capacities` in `profile.behavior.spec.ts`), and `ExpiringMap`'s own
expiry/eviction logic is covered in isolation (`test/expiring-map.spec.ts`). What no test covers is
that `stabilizeOnce` actually calls `sweepBoundedMaps()` — i.e. that a real maintenance tick drives
the cleanup at all.

## What the test must do

Follow the fake-clock swap already used in `test/ring-membership.spec.ts:455-482` ("escalation
resets to factor 1 after BACKOFF_RETAIN_MS..."): start a real `CoreFretService` on a real node, then
replace `(svc as any).backoffMap` and `(svc as any).departureDebounce` with fresh `ExpiringMap`s
constructed with the same `capacity`/`ttlMs` as the originals but an injected `now: clock.now`
(a mutable `{ now, advance }` closure over a local `clockNow` variable — copy the exact idiom).
This is a fake *clock*, not a fake service: everything else stays real.

Steps:
1. Start the service, build the fake clock, swap both maps in.
2. Seed one entry in each map that will be **expired** (`.set(id, value)`, then advance the clock
   past that map's own `ttlMs`) and one that will **survive** (`.set(id, value)` again *after*
   advancing the clock, so its `expiresAt` is freshly in the future relative to the advanced clock).
   Asserting only that the expired ones disappear is not enough — a tick that cleared both maps
   unconditionally would also pass that assertion; the surviving entry is what rules that out.
3. Call `await (svc as any).stabilizeOnce()` directly (matches how other specs drive a single tick)
   and assert: both expired entries gone, both surviving entries present.

## Edge cases & interactions

- **`pruneBackoffMap` is not TTL-based and runs inside the same `sweepBoundedMaps()` call.** It
  drops any `backoffMap` entry whose peer id has no matching entry in `store.getById(id)`,
  regardless of expiry. If the backoffMap "surviving" entry's id is not itself present in the
  routing store, `pruneBackoffMap` removes it anyway and the test would pass for the wrong reason
  (or fail confusingly). Use the service's own self id (`(svc as any).selfIdStr`, always present in
  the store after `start()`) — or `store.upsert(...)` a synthetic peer first — as the backoffMap
  survivor id. `departureDebounce` has no equivalent store-membership prune, so any arbitrary string
  id is fine there.
- **`stabilizeOnce` does real work beyond the sweep** (near-peer probing, phase 2 targets, capacity
  enforcement) on an isolated single-node service with no peers — this should all no-op cleanly
  (empty candidate lists), but if it throws, note that as a separate finding rather than routing
  around it (e.g. don't catch-and-ignore the call).
- **Timer hygiene**: `stabilizeOnce` internally arms and cancels `deadline()` AbortControllers:
  `await`ing the call fully (not fire-and-forget) is required or the mocha exit watchdog
  (`test/mocha-exit-watchdog.ts`) may flag a leaked handle.
- Don't advance the clock by exactly `ttlMs` — `ExpiringMap`'s expiry check is `expiresAt <
  clock()`, so use `ttlMs + 1` (matches the existing idiom at `ring-membership.spec.ts:477`) to
  avoid an off-by-one false pass/fail.

## TODO

- Add the new test to the `Bounded internal map capacities` describe block in
  `test/profile.behavior.spec.ts`, e.g. "stabilizeOnce sweeps expired entries from backoffMap and
  departureDebounce".
- Run `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/profile.behavior.spec.ts" --timeout 30000` and confirm it passes alongside the existing suite in that file.
- Run `cd packages/fret && npx tsc --noEmit` to confirm no type errors from the new imports (`ExpiringMap`, if not already imported in this spec file).
