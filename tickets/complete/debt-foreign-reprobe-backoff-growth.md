description: Made the foreign-peer re-probe backoff actually grow across probe windows (so a genuinely-foreign peer is probed less and less often) instead of resetting to the shortest delay every time.
files:
  - packages/fret/src/service/fret-service.ts
  - packages/fret/test/ring-membership.spec.ts
  - docs/fret.md
  - docs/threat-analysis.md
----

## Summary

A co-resident peer that belongs to *another* network is labeled `foreign` and re-probed occasionally (in case it was a same-network peer mislabeled before its protocol handlers registered). Each confirmed-foreign probe is supposed to record an exponentially-growing backoff so a genuinely-foreign peer is probed at most once per window and tapers toward ~once/32s. The doubling path was unreachable: `getBackoffPenalty` deleted the backoff entry on expiry, so the next `recordBackoff` always saw no entry and re-seeded `factor = 1`. Probing was throttled to a fixed ~1s rate — a steady-state chatter source in multi-network deployments.

The implement stage fixed it by (a) retaining the entry past expiry in `getBackoffPenalty` so `recordBackoff` doubles the prior factor, and (b) adding `pruneBackoffMap()` (run once per stabilization tick) to keep the now-persistent map bounded by store capacity. Docs and tests were updated.

## Review findings

### Scope checked
- Read the implement diff (commit `082fc3a`) with fresh eyes before the handoff summary, then the surrounding code: `recordBackoff` / `getBackoffPenalty` / `clearBackoff` / `pruneBackoffMap` (fret-service.ts ~1310–1334), both callers of the eligibility filter (`classifyUnknownPeers` line 952, `reprobeForeignPeers` line 984), the cost-function consumer (`backoffPenalty` line 1298), and every other `recordBackoff` call site (iterative-lookup and maybeAct routing-failure paths).
- Ran typecheck (`tsc --noEmit`, clean) and the full suite (`yarn test`): **261 passing, 1 pending** — unchanged from baseline. The two new tests in `ring-membership.spec.ts` pass.

### Correctness — no defects found
- The fix is correct. Traced the real loop tick-by-tick: first probe seeds `factor=1`/`until=now+1s`; within the window `getBackoffPenalty` returns >0 so the peer is ineligible; after expiry it returns `0` **and retains the entry**, so the next probe's `recordBackoff` doubles to 2 (`until=now+2s`), and so on to the 32× cap. The previously-unreachable doubling path is now reached.
- `pruneBackoffMap` is wired into `reprobeForeignPeers`, which runs every `stabilizeOnce` tick, so the now-persistent map is swept each tick. Deleting Map keys during `for...of keys()` iteration is well-defined in JS — safe.
- Map is bounded: the only growth sources are peers in the store (foreign, or members/unknowns that failed), and `pruneBackoffMap` drops any entry whose peer left the store. Bounded by routing-table capacity C=2048, plus at most one tick of stragglers. The implementer's "map bounds" claim holds.

### Tests — adequate, extended coverage considered
- New `Foreign re-probe backoff growth` block directly covers the two paths that were broken: (1) expiry must not delete the entry and the next record must double the factor with a strictly longer window; (2) factor caps at 32 and `pruneBackoffMap` removes entries for peers absent from the store. Both happy path and the cap/prune edges are exercised.
- The growth is verified at the unit level (private-field access, simulated window expiry) rather than by driving real ticks. The end-to-end re-probe loop is already covered by the pre-existing `re-admits a same-network peer that was mislabeled foreign` test; I judged a further integration test redundant and did not add one.

### Docs — one stale reference fixed inline (minor)
- `docs/fret.md` "Foreign re-probe pass" bullet was correctly rewritten by the implementer to describe the growing/capped backoff. Verified accurate.
- **Fixed inline:** `docs/threat-analysis.md` §4.3 (Unbounded Map Growth) still claimed `backoffMap` is "Never pruned except by `clearBackoff` ... or `getBackoffPenalty` on expiry (lazy pruning)" — this fix *removed* the expiry-delete and *added* `pruneBackoffMap`. Updated the bullet to the new reality (per-tick sweep + store-capacity bound), which also strengthens the section's own concern. (The neighboring stale `fret-service.ts:1033-1052` line-number reference in §2.5 is pre-existing drift unrelated to this change; left as-is.)

### Behavioral broadening — checked, intentional, no action
- Because `getBackoffPenalty` no longer deletes on expiry, the *routing-failure* backoff paths (iterative lookup, maybeAct) and the *unknown* re-probe path now also let the factor grow across windows rather than resetting. This is wider than the ticket's stated foreign-only scope but is the documented intent ("retry with exponential backoff"); it still self-clears via `clearBackoff` on any success and expires by window, so no peer is permanently penalized. No regression; no action needed.

### Tripwires — one considered, not recorded as work
- `pruneBackoffMap` does an O(map size) sweep with a store lookup per entry, every tick. With the map bounded at ≤2048 and a 1–3s passive cadence this is negligible, so I did **not** add a `NOTE:` comment or ticket — recording it here in the index is sufficient. If the map bound or tick cadence ever changes materially, revisit.

### Other categories
- No major findings → **no new tickets filed.**
- No new blocking decisions → nothing to `blocked/`.
