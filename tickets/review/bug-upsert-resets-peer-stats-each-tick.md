----
description: Every routing-table refresh wipes a known peer's accumulated quality stats back to zero — fix makes upsert preserve all mutable stats on re-insert, so relevance/health data accumulates over time as intended.
files:
  - packages/fret/src/store/digitree-store.ts (upsert fixed — lines 83–116)
  - packages/fret/test/ring-membership.spec.ts (two new tests added — "preserves relevance and health counters across a re-upsert", "initializes a new id to zero counters and disconnected state")
  - docs/fret.md (Ring membership section updated to document full stat preservation)
----

## What was done

`DigitreeStore.upsert` was create-or-replace: when an id already existed it deleted the entry and rebuilt it from defaults, carrying only `membership` forward (from a prior fix). Every unconditional caller — `seedFromPeerStore` on each stabilization tick, snapshot merges, `peer:connect`, routing hints — wiped `relevance`, `accessCount`, `successCount`, `failureCount`, `avgLatencyMs`, and `state` roughly once per tick. Relevance scoring (which drives eviction victim selection and next-hop cost) could only ever reflect the current tick's activity; no peer's score accumulated.

**Fix** (`digitree-store.ts:83`): on a hit, build `next = { ...prev, coord, lastAccess: now }` and update in place (or delete+re-insert if coord changed, preserving BTree key consistency). On a miss (new id), build from defaults as before. The old `membership`-only carry-forward comment is replaced with one covering all mutable stats.

**Tests** (`ring-membership.spec.ts`): two tests added to the existing `DigitreeStore membership field` describe block:
- `preserves relevance and health counters across a re-upsert` — upserts, sets non-zero relevance/counters/state/membership, re-upserts, asserts all fields survive.
- `initializes a new id to zero counters and disconnected state` — asserts the new-id default path is unaffected.

**Docs** (`docs/fret.md`): the Ring membership section sentence about `upsert` durability is broadened to name all preserved fields (relevance, health counters, state, membership, metadata) and to clarify that only coord/lastAccess are refreshed.

## Validation

- `npx tsc --noEmit`: clean.
- `ring-membership.spec.ts`: 23/23 passing (includes the 2 new tests).
- `yarn test` (full suite): 258/258 passing, 0 failing.

## Use cases for testing / review focus

- **Stat accumulation across ticks**: verify that after a stabilization tick fires `seedFromPeerStore`, a peer with non-zero relevance/counters retains those values. The existing unit test covers this at the store level; the integration tests (churn, routing) exercise it end-to-end.
- **New peer defaults**: a genuinely new id must still start with zeroed counters and `state: 'disconnected'`.
- **Coord-change re-key guard**: the defensive branch (`prevKey !== newKey`) handles a coord change by delete+insert. This path should not fire in practice (coord is hash-derived from peer id), but the guard prevents a stale BTree key if it ever did.
- **No caller relied on zeroing**: confirmed by 258/258 passing across churn simulation, routing-under-churn, membership classification, and size-estimation tests.

## Review findings

None. The fix is minimal and surgical — three changed lines in `upsert` replacing the defaults block with a spread of the prior entry. The coord-change guard mirrors the existing re-key pattern already in `DigitreeStore.update`.
