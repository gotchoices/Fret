----
description: Fix the foreign re-probe backoff so it actually grows across windows, tapering probes toward a ~once/32s rate in steady state.
prereq:
files:
  - packages/fret/src/service/fret-service.ts
  - packages/fret/test/ring-membership.spec.ts
  - docs/fret.md
difficulty: easy
----

## What was done

### Root cause (confirmed by research)

`getBackoffPenalty` deleted the backoff record the moment it expired (`bo.until < Date.now()` branch called `this.backoffMap.delete(id)`). So when `reprobeForeignPeers` selected a peer eligible for re-probe (`getBackoffPenalty === 0`) and then `probeMembership` re-recorded a backoff after another failed ping, `recordBackoff` saw no existing entry and re-seeded `factor = 1`. The doubling path (`existing ? existing.factor * 2 : 1`) was never reached.

### Fix

**`getBackoffPenalty`** — removed the `this.backoffMap.delete(id)` on expiry. The entry is retained (factor preserved); only the return value changes (0 = off-backoff). Next `recordBackoff` call doubles the factor correctly.

**`pruneBackoffMap()`** — new private method added. Iterates the backoff map and removes entries for peers no longer present in the store (evicted from the routing table). Called once per stabilization tick at the top of `reprobeForeignPeers`, keeping the map bounded by store capacity (C=2048).

**`probeMembership`** — removed the stale 4-line NOTE comment that described the now-fixed bug; replaced with a brief accurate description of the growing backoff behavior.

**`docs/fret.md`** — updated the "Foreign re-probe pass" bullet to drop the `NOTE: the backoff is currently re-seeded each window…` paragraph and replace it with an accurate description of the exponentially-growing (capped at 32×) backoff.

### Tests added (`test/ring-membership.spec.ts`)

New `describe('Foreign re-probe backoff growth')` block with two unit tests:

- **backoff window grows on repeated confirmed-foreign probes** — directly exercises the fixed path: records a backoff, simulates window expiry by manipulating `until`, asserts `getBackoffPenalty` returns 0 without deleting the entry, then records again and asserts `factor` doubled.
- **backoff caps at factor 32 and prunes evicted peers** — drives the factor to the 32× cap (1→2→4→8→16→32) and asserts `pruneBackoffMap` removes entries for peers not in the store.

Both tests access private fields via `(svc as any)` — standard pattern for internal-behavior unit tests in this codebase.

### Net behavior change

A genuinely-foreign peer is now re-probed at an exponentially-decreasing rate (1s → 2s → 4s → … → 32s window, then held at 32s) rather than at a fixed ~1s rate. A mislabeled same-network peer is still re-admitted on its first off-backoff probe (the probe itself succeeds and calls `clearBackoff`, resetting the factor to 0 for a clean next-sequence).

The same growth applies to the `classifyUnknownPeers` path, which also uses `getBackoffPenalty === 0` as its eligibility gate — an improvement: unknown peers that consistently fail probes back off more aggressively over time.

## TODO

- Verify no regression in the existing integration tests (`yarn test` — 261 passing, 1 pending, all green).
