description: The service keeps two small bookkeeping tables tidy by cleaning them out on a timer; add a test proving that cleanup is actually hooked up to that timer, since nothing today would notice if it got disconnected.
files: packages/fret/src/service/fret-service.ts (`sweepBoundedMaps` line 3084, `pruneBackoffMap` line 3068, called from `stabilizeOnce` line 2246; `backoffMap` constructed ~494-497, `departureDebounce` constructed ~502-505; `selfIdStr` field ~176, set ~436; `BACKOFF_RETAIN_MS` = 300_000 at line 268, `DEPARTURE_DEBOUNCE_MS` = 2000 at line 244), packages/fret/test/profile.behavior.spec.ts (`Bounded internal map capacities` describe block, lines 346-384 — add the new test inside it, before the closing `})` at 384), packages/fret/test/ring-membership.spec.ts (lines 455-482, the fake-clock swap idiom to copy verbatim), packages/fret/src/utils/expiring-map.ts (`ExpiringMap`, injectable `now` clock — confirmed API: `set(key,value)`, `get(key)`, `has(key)`, `keys()`; live check is `expiresAt < clock()`, i.e. strictly-less, so an entry is still live *at* its expiry instant — use `ttlMs + 1` to force expiry, matching the existing idiom)
difficulty: easy
----

<!-- resume-note -->
Prior run stopped on a BUDGET_WARNING after read-only investigation, before writing any test
code or making any edit. Nothing in the repo has changed. All file:line references in the
`files:` header above were verified against the current source during that investigation (they
match the original ticket's claims exactly, so they can be trusted without re-grepping):

- `stabilizeOnce` (fret-service.ts:2246) opens with `this.sweepBoundedMaps();` — confirmed.
- `sweepBoundedMaps` (fret-service.ts:3084) calls `this.pruneBackoffMap();` (fret-service.ts:3087)
  among other work — confirmed.
- `pruneBackoffMap` is at fret-service.ts:3068 — confirmed.
- `ExpiringMap` (src/utils/expiring-map.ts) constructor takes `{ capacity, ttlMs, now? }`; `now`
  defaults to `Date.now` and is the injection point for the fake clock. `set()` refresh-or-insert,
  `get()`/`has()` drop an expired entry as a side effect, `keys()` returns only live (non-expired)
  keys. Expiry test is `entry.expiresAt < this.clock()` (strict), so advancing the clock by
  exactly `ttlMs` is NOT enough to expire an entry — must advance by `ttlMs + 1` (matches the
  idiom already used at ring-membership.spec.ts:477).
- The fake-clock swap idiom at ring-membership.spec.ts:455-482 ("escalation resets to factor 1
  after BACKOFF_RETAIN_MS...") is exactly the pattern to copy: start a real service, then replace
  `(svc as any).<mapField>` with a fresh `ExpiringMap` built with the same `capacity`/`ttlMs` as
  the original but `now: clock.now`, where `clock` is a local `{ now, advance }` closure over a
  mutable `clockNow` variable.
- `profile.behavior.spec.ts`'s `Bounded internal map capacities` describe block runs from line 346
  to its closing `})` at line 384 (module ends at 385/386). The new test goes inside that block,
  after the last existing `it(...)` (currently the `an explicit discoveryCfg.maxTracked...` case
  ending ~383).
- `createService(profile)` helper (profile.behavior.spec.ts:26-33) is the existing pattern for
  starting a real node + real `CoreFretService`: `new CoreFretService(node, { profile, k: 7, m: 4 })`
  then `await svc.start()`, with `onCleanup` registering teardown. Use this rather than hand-rolling
  node/service setup — it already exists in the file and the other tests in this describe block use it.

Everything else is unread/undone. Proceed as follows — this is effectively the original ticket,
unchanged in substance:

## What is untested

`stabilizeOnce` opens every tick with `this.sweepBoundedMaps()`, which sweeps two `ExpiringMap`s —
`backoffMap` (peer probe backoff, TTL `BACKOFF_RETAIN_MS` = 5 min) and `departureDebounce`
(departure-announce debounce, TTL `DEPARTURE_DEBOUNCE_MS` = 2 s) — plus `pruneBackoffMap()`, which
separately drops any `backoffMap` entry whose peer id is no longer in the routing store. The
cap-size defaults for both maps are already covered (`Bounded internal map capacities` in
`profile.behavior.spec.ts`), and `ExpiringMap`'s own expiry/eviction logic is covered in isolation
(`test/expiring-map.spec.ts`). What no test covers is that `stabilizeOnce` actually calls
`sweepBoundedMaps()` — i.e. that a real maintenance tick drives the cleanup at all.

## What the test must do

Using `createService('core')` (or equivalent direct construction — see resume-note above) to get a
real `CoreFretService` on a real node, replace `(svc as any).backoffMap` and
`(svc as any).departureDebounce` with fresh `ExpiringMap`s constructed with the same
`capacity`/`ttlMs` as the originals but an injected `now: clock.now` (a mutable `{ now, advance }`
closure over a local `clockNow` variable — copy the exact idiom from ring-membership.spec.ts:455-482).
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
