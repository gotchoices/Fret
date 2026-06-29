----
description: Every routing-table refresh wiped a known peer's accumulated quality stats back to zero; the fix makes upsert preserve all mutable stats on re-insert so relevance/health data accumulates over time as intended.
files:
  - packages/fret/src/store/digitree-store.ts (upsert: preserve-on-hit, default-on-miss — lines 83–122)
  - packages/fret/test/ring-membership.spec.ts (3 tests: preserve stats, new-id defaults, coord-change re-key)
  - docs/fret.md (Ring membership section: upsert preserves full mutable state)
----

## What shipped

`DigitreeStore.upsert` was create-or-replace: on a hit it deleted the entry and rebuilt from
defaults, carrying only `membership` forward. Every unconditional caller (`seedFromPeerStore`
each stabilization tick, snapshot merges, `peer:connect`, routing hints) therefore wiped
`relevance`, `accessCount`, `successCount`, `failureCount`, `avgLatencyMs`, and `state` ~once
per tick, so relevance scoring (eviction victim selection + next-hop cost) never accumulated.

The fix makes `upsert` honour an "ensure-an-entry-exists" contract: on a hit it builds
`next = { ...prev, coord, lastAccess: now }` and updates in place (delete + re-insert if the
coord ever changed); on a miss it builds from defaults as before.

## Review findings

**Scope of review:** read the full implement diff (`0075e2a`) before the handoff, then the
whole touched file (`digitree-store.ts`), all 15 `upsert` call sites in `fret-service.ts`,
the `state`/`'dead'` reader (`peer-discovery.ts`), and `relevance.ts` to confirm the
now-accumulating counters stay bounded.

- **Correctness (fix) — OK.** The preserve-on-hit / default-on-miss split is correct. The
  `prevKey !== newKey` re-key branch (delete + `insert`) is cleaner than the in-place pattern
  in `DigitreeStore.update` and keeps `byId`, the ordered index, and stats consistent.
- **`state` preservation — OK, and a latent bonus fix.** The implementer called the old
  `state → 'disconnected'` reset "cosmetic." Verified: `state` is only ever written
  `'connected'` (peer:connect) / `'disconnected'` (peer:disconnect); `'dead'` is read in
  `peer-discovery.ts:72` but **never written** anywhere, so there is no dead-revival hazard.
  Preserving `state` actually fixes a pre-existing latent flap — previously a connected peer's
  stored `state` was reset to `'disconnected'` every tick between its connect and disconnect
  events. The `peer:connect` handler order (`upsert` → `setState('connected')` → `applyTouch`)
  remains correct.
- **All 15 upsert callers — OK.** None rely on zeroing: `getById ?? upsert` callers never hit
  `upsert` on an existing entry; the unconditional callers immediately follow with
  `applyTouch`/`setState`; self-membership (`upsert` → `setMembership('member')`) is preserved
  across ticks (more robust now); `importTable` uses `insert`, not `upsert`.
- **Test coverage — gap found and fixed inline (minor).** The implementer's two tests cover
  preserve-on-hit and new-id defaults but left the defensive coord-change re-key branch
  (lines 97–100) untested. Added `re-keys without orphaning when a re-upsert changes the
  coord`, asserting stats survive, `size()`/`list()` stay at 1 (no orphan), and the entry is
  reachable at the new coord. Suite went 258 → 259.
- **Docs — OK.** `docs/fret.md` Ring membership section accurately broadened to name all
  preserved fields (relevance, health counters, state, membership, metadata) and to state
  only coord/lastAccess are refreshed; defaults apply only to a genuinely new peer.
- **Unbounded counters — observed and dismissed (no action).** `accessCount`/`successCount`/
  `failureCount` now accumulate for a long-lived peer instead of resetting each tick. Verified
  in `relevance.ts` that all three feed bounded functions (`log1p(accessCount)/5` saturates,
  health is a success ratio, latency is an EMA), so relevance stays bounded. Raw integer
  growth is negligible (`Number.MAX_SAFE_INTEGER` at one tick/1.5 s is geologic-scale). Not a
  tripwire — there is no condition under which it becomes work.

**Major findings:** none — no new tickets filed.
**Tripwires:** none recorded. (The pre-existing O(size()) filtered-walk NOTE in
`digitree-store.ts:204` is unrelated to this change and already parked.)

## Validation

- `npx tsc --noEmit`: clean.
- `ring-membership.spec.ts`: 24/24 passing (2 implementer tests + 1 added re-key test).
- `yarn test` (full suite): 259 passing, 1 pending, 0 failing.
