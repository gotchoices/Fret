----
description: Review the foreign re-probe backoff growth fix — ensures the exponential backoff actually persists across probe windows instead of resetting to factor=1 each time.
prereq:
files:
  - packages/fret/src/service/fret-service.ts
  - packages/fret/test/ring-membership.spec.ts
  - docs/fret.md
----

## What was done

### Root cause fixed

`getBackoffPenalty` was deleting the backoff entry on expiry (`backoffMap.delete(id)`), so the next `recordBackoff` call always saw no existing entry and re-seeded `factor = 1`. The doubling path was unreachable.

### Changes

**`getBackoffPenalty`** (`fret-service.ts` ~line 1321) — removed the `backoffMap.delete` on expiry. Entry is retained; return value is still 0 (off-backoff). Next `recordBackoff` correctly doubles the factor.

**`pruneBackoffMap()`** (`fret-service.ts` ~line 1330) — new private method. Removes backoff entries whose peer ID is no longer in the store (evicted from the routing table). Called once per stabilization tick at the top of `reprobeForeignPeers`, keeping the map bounded by store capacity (C=2048).

**`reprobeForeignPeers`** — calls `this.pruneBackoffMap()` at the top of each tick.

**`probeMembership`** — updated inline comment to accurately describe the growing backoff (old comment described the now-fixed bug).

**`docs/fret.md`** — "Foreign re-probe pass" bullet updated: dropped the `NOTE: the backoff is currently re-seeded each window…` paragraph, replaced with accurate description of exponentially-growing (capped at 32×) backoff.

### Tests added (`test/ring-membership.spec.ts`)

New `describe('Foreign re-probe backoff growth')` block:

- **backoff window grows on repeated confirmed-foreign probes** — records a backoff, simulates window expiry by manipulating `until`, asserts `getBackoffPenalty` returns 0 without deleting the entry, then records again and asserts `factor` doubled (1 → 2).
- **backoff caps at factor 32 and prunes evicted peers** — drives factor to cap (1→2→4→8→16→32) and asserts `pruneBackoffMap` removes entries for peers not in the store.

Both access private fields via `(svc as any)` — standard pattern in this codebase.

### Test results

All 261 tests passing, 1 pending (unchanged from baseline). New backoff tests are among the 26 in `ring-membership.spec.ts`.

## Use cases for validation

1. **Steady-state foreign peer**: a peer confirmed foreign should be re-probed at 1s → 2s → 4s → 8s → 16s → 32s intervals, then held at 32s. Each tick that the probe fails records a doubled backoff.
2. **Mislabeled same-network peer**: first off-backoff re-probe succeeds → `clearBackoff` resets the entry; peer is re-admitted to the ring.
3. **Evicted peer**: once a foreign peer is evicted from the routing table, `pruneBackoffMap` removes its backoff entry so the map doesn't grow unboundedly.
4. **Map bounds**: with store capacity C=2048, the backoff map cannot exceed 2048 entries (one prune per tick cleans evicted peers).

## Known gaps / tripwires

None. The fix is narrow and targeted; the two new unit tests cover both the growth path and the pruning path directly.

## Review findings

- Tripwire noted in `getBackoffPenalty` inline comment (`// NOTE: re-counts…` — none added here; no new tripwires were identified during this fix).
