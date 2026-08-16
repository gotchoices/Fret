description: Tests now exist to catch anyone quietly re-tuning the two internal bookkeeping table size limits added by the map-capacity-bounds work (the probe-backoff map and the departure-announce debounce map, plus the libp2p discovery re-emission debounce map); this ticket asks a reviewer to double-check them and the one pre-existing unrelated test failure that turned up alongside them.
files: packages/fret/src/service/fret-service.ts (unchanged this pass — capacity/sweep logic landed in prior tickets), packages/fret/src/service/libp2p-fret-service.ts (unchanged — discovery maxTracked wiring), packages/fret/src/service/peer-discovery.ts (unchanged — emitted debounce map), packages/fret/src/utils/expiring-map.ts (unchanged), packages/fret/test/expiring-map.spec.ts (from a prior pass, 24 specs, unchanged this pass), packages/fret/test/ring-membership.spec.ts (3 new specs in the "Foreign re-probe backoff growth" block, from the pass before this one), packages/fret/test/profile.behavior.spec.ts (new "Bounded internal map capacities" describe block, this pass), packages/fret/test/peer-discovery.spec.ts (new capacity/re-emission spec, this pass), docs/fret.md (updated in a prior pass)
---

## What this ticket covers

This is the third and final continuation of a chain that started as `map-capacity-bounds` (design),
`map-capacity-bounds-service` (production change: `backoffMap` / `departureDebounce` converted from
plain `Map`s to capacity-bounded `ExpiringMap`s, swept every stabilization tick), and this ticket
(`map-capacity-bounds-tests`, tests only — no production code touched this pass or the pass before
it). The production change and its rationale are fully described in `docs/fret.md` under
*Security and abuse considerations → Current state* (the paragraph on the backoff map and departure
debounce map) — read that, not this file, for the "why" of the capacity/TTL/sweep design.

This pass's job was purely to close the testing gap: **prove the capacities are what the profile
tables say they are, and prove eviction is "recycle the oldest slot," not "silently drop and never
recover."**

## What was verified working this pass

Three spec additions, all confirmed passing via targeted runs (see *Gate status* below for why not
via the full suite):

1. **`test/ring-membership.spec.ts` → `Foreign re-probe backoff growth`** (written in the pass
   before this one, verified for the first time in this pass): two new specs plus one constant-only
   assertion —
   - `'backoff escalation survives an expired window, within retention'`
   - `'escalation resets to factor 1 after BACKOFF_RETAIN_MS with no further failure'` — swaps a
     fake-clock-driven `ExpiringMap` into `(svc as any).backoffMap` after `start()` so only the
     map's own TTL is under test, not the (wall-clock-derived) backoff window itself.
   - `'BACKOFF_RETAIN_MS comfortably exceeds the longest possible backoff window'` — reads
     `BACKOFF_BASE_MS` / `BACKOFF_MAX_FACTOR` / `BACKOFF_RETAIN_MS` off the real class rather than
     copying the numbers, so retuning either side fails this test rather than silently reintroducing
     the bug the retention constant exists to prevent.
   All 9 specs in that describe block pass (`node --import ./register.mjs
   node_modules/mocha/bin/mocha.js "test/profile.behavior.spec.ts" "test/ring-membership.spec.ts"
   --timeout 30000` → 75 passing).

2. **`test/profile.behavior.spec.ts` → new `Bounded internal map capacities` describe block**
   (this pass): 7 specs — Core/Edge `backoffMap.capacity` (2048 / 512), Core/Edge
   `departureDebounce.capacity` (512 / 128), Core/Edge discovery `emitted.capacity` i.e.
   `maxTracked` (4096 / 1024), and one confirming an explicit `discoveryCfg.maxTracked` wins over
   the profile default via the `??` merge in `Libp2pFretService`'s constructor. All pass (see run
   above).

3. **`test/peer-discovery.spec.ts` → new cap/re-emission spec** (this pass): 5 members, a debounce
   map capacity (`maxTracked`) of 4, `batchSize: 2` — proves every member is eventually emitted and
   at least one is emitted more than once, i.e. an evicted peer is re-emitted rather than dropped
   forever. **Note the capacity is 4, not 3** — the ticket's original sketch suggested `maxTracked:
   3` for 5 members; that value deterministically starves the ring-order-last member. `FretPeerDiscovery.scan`
   re-scans the *entire* store every tick in a fixed ring-coordinate order (not a resumable cursor)
   and breaks once `batchSize` emissions have happened in that tick. With `cap=3, batch=2, count=5`
   the eviction/re-emission churn among the first four ring-order members settles into a stable
   2-tick cycle that never advances the scan far enough to reach the fifth — worked out by hand-
   simulating `emitted.set`'s oldest-evicted-first rule against the scan's break condition, then
   confirmed by running the test at `maxTracked: 3` (failed: `... must eventually be emitted`,
   assertion `false` where `true` expected) and again at `maxTracked: 4` (18/18 passing in that
   file, run individually:
   `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/peer-discovery.spec.ts"
   --timeout 30000`). Worth a reviewer's second look: this is a real, narrow starvation mode in the
   production `scan()` logic itself (full-rescan-plus-break-on-batchSize can, for specific
   `capacity`/`batchSize`/population-size combinations, produce a stable cycle that never reaches
   some subset of members) — not just a test-parameter mistake. It's not a bug *today* because the
   shipped defaults (`maxTracked` 4096 Core / 1024 Edge against a routing-table capacity of 2048)
   put the cap well above any realistic live population, but the underlying mechanism deserves a
   `NOTE:` at `FretPeerDiscovery.scan` (`packages/fret/src/service/peer-discovery.ts`, the loop at
   line ~137) so a future change to `batchSize` or `maxTracked` sizing doesn't reintroduce it
   silently. **Not filed as a ticket — this is exactly the tripwire case** ("fine now, becomes a
   problem only if X"): no code site or docs bullet exists yet, so whoever picks this up should add
   that `NOTE:` rather than treat it as a queued task.

Also ran `npx tsc --noEmit` clean (no errors) after all three spec-file edits.

## Gate status — please finish this before merging

**The full `yarn test` suite was run once this pass, before the `peer-discovery.spec.ts` fix
above, and has not been re-run since.** That run: 576 passing, 3 failing —
1. the `peer-discovery.spec.ts` starvation failure described above (root-caused and fixed,
   `maxTracked: 3` → `4`, then verified green via a standalone run of that one file — not via a
   full-suite re-run);
2 & 3. `test/replay-hardening.spec.ts` → `dedup cache capacity` → `sizes Core larger than Edge` and
   `defaults to the Core capacity when no profile is given`, both `AssertionError: expected
   undefined to equal 2048`. **Confirmed pre-existing and unrelated to this ticket** — full
   root-cause and reproduction written to `tickets/.pre-existing-error.md` (not yet triaged; that
   file should still be present for the runner to pick up). Short version: an earlier ticket in this
   same chain, commit `d8449e7`, refactored `DedupCache` to wrap `ExpiringMap` internally and
   dropped the `maxSize` field these two tests read via `(svc as any).dedupCache.maxSize` — it's
   `undefined` now; the tests need to read `(svc as any).dedupCache.entries.capacity` instead
   (`ExpiringMap.capacity` is a public readonly field). Neither `dedup-cache.ts` nor
   `replay-hardening.spec.ts` is touched by this ticket's diff.

**A budget warning arrived immediately after that single full-suite run, before it could be
re-run with the peer-discovery fix in place.** So: `npx tsc --noEmit` is confirmed clean post-fix,
and the three touched spec files are confirmed green individually post-fix (75 + 18 = 93 specs, all
passing, run separately from the rest of the suite), but **nobody has run the complete `yarn test`
suite with the current working tree since the last edit.** Given the fix only touched one numeric
test parameter in an isolated spec file with no production-code changes, a full-suite regression
from it is unlikely — but it hasn't been literally proven, and that's a real gap, not a formality to
wave off. Please run `cd packages/fret && yarn test` (foreground, no redirection) once before
treating this as done. Expect 3 known-accounted-for outcomes: the two pre-existing dedup-cache
failures (leave them; the runner's triage pass handles `.pre-existing-error.md`) and everything else
green, including the newly-fixed `peer-discovery.spec.ts` line.

## Use cases for testing / validation

- **Capacity is what the profile table claims**: `(svc as any).backoffMap.capacity`,
  `(svc as any).departureDebounce.capacity`, and `(disc as any).emitted.capacity` are all directly
  readable (private-but-accessible-via-`as any` fields on `ExpiringMap`), so a future PR that
  changes a profile constant without updating `docs/fret.md`'s stated numbers fails these tests
  loudly rather than drifting silently.
- **Eviction is FIFO-by-nearest-expiry, not silent loss**: the backoff-growth specs prove an
  expired-but-retained entry survives to let the *next* failure double its escalation factor rather
  than resetting to 1; the peer-discovery spec proves an evicted discovery-debounce entry lets that
  peer re-emit rather than vanishing from libp2p's peerStore forever.
- **Retention (`BACKOFF_RETAIN_MS`) vs. window (backoff `until`) are independently tested** — the
  window is real-wall-clock-derived and can't be waited out in a test, so the retention-expiry spec
  swaps in a fake-clock `ExpiringMap` after `start()`, leaving `recordBackoff` and the RPC layer
  untouched; the window-survives-expiry spec uses the map's own `until` mutation instead. Worth
  checking these two don't accidentally test the same thing under different names — they don't
  (one is about the *map's* TTL, the other about the *backoff factor's* survival across an expired
  window within that TTL), but the distinction is subtle enough that a reviewer should confirm the
  comments explaining it still read clearly.
- **Known gap, not covered by any test in this chain**: nothing exercises `sweepBoundedMaps` /
  `pruneBackoffMap` racing with live RPC traffic under real (non-fake) concurrent load — all specs
  here either use a single service with directly-invoked private methods, or (for the discovery
  spec) a bare `DigitreeStore` with no live RPC traffic at all. That's consistent with how the rest
  of this map's surrounding test suite is written (unit-level, not load-level), so not something
  this ticket should have expanded scope to cover — flagging it here as awareness, not a gap to
  close.

## TODO for reviewer

- Run `cd packages/fret && yarn test` (foreground, no redirection) once, full suite, current working
  tree. Confirm exactly 2 failures (both in `replay-hardening.spec.ts`, both pre-existing per
  `tickets/.pre-existing-error.md`) and 0 unexpected ones.
- Consider adding the `NOTE:` tripwire at `packages/fret/src/service/peer-discovery.ts`'s `scan()`
  loop (~line 137) documenting the full-rescan-plus-break starvation mode described above, per the
  ticket workflow's tripwire convention — this ticket intentionally did not add it since the review
  stage is where tripwires get written up, not implement.
- Confirm `tickets/.pre-existing-error.md` gets picked up by the runner's triage pass (it's new this
  session, not yet acted on).
