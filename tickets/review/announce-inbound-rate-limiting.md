description: A node can no longer be forced into thousands of expensive crypto operations by one oversized peer-list announcement — inbound announcements are now rate-limited and the number of peers each one can carry is capped.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/test/announce-rate-limit.spec.ts, docs/fret.md
---

## What changed

Implements review finding **M-core-2** (threat-analysis.md §3.4): the inbound announce path was unbounded and unbucketed, unlike the neighbor-fetch merge path. Two guards added, both in `fret-service.ts`:

1. **Inbound-announce token bucket (`bucketAnnounceInbound`).** New per-profile `TokenBucket`, initialized in the constructor alongside the other buckets. The announce callback now routes through a small gate method `handleAnnounce(from, snap)` which checks the bucket *before* any merge work. On rejection it increments `diag.rejected.rateLimited` and drops the message (returns; does not throw, does not merge). Wired at the `registerNeighbors(...)` onAnnounce closure in `registerRpcHandlers`.
   - Rates: Core capacity 20 / refill 10per-sec; Edge capacity 6 / refill 2per-sec (Edge < Core, as specified).

2. **Per-message merge caps in `mergeAnnounceSnapshot`.** Remote `successors` / `predecessors` / `sample` are `.slice()`d to per-profile caps before the ingest loops, matching the neighbor-fetch merge (`mergeNeighborSnapshots`). The cap values are now a **single source of truth**: new private helper `mergeSnapshotCaps()` returns `{ successors, predecessors, sample }` (Core 16/16/8, Edge 8/8/6) and *both* merge paths consume it. This removed the previously-inlined cap constants in `mergeNeighborSnapshots`.

`docs/fret.md` security section updated: inbound announce is now listed under implemented rate limiting + merge caps; the "not yet implemented" line trimmed to per-peer buckets only.

## Design notes / rationale

- The gate lives in a dedicated `handleAnnounce` method rather than inline in the closure so it is a small single-purpose unit and directly unit-testable.
- Merge caps bound work *per message* independent of the 128 KB RPC byte limit. A peer sending many small announces is still governed by the token bucket (each announce costs one token).
- Bucket exhaustion drops silently (only the diag counter moves) — no throw, so no inflight counter desync.

## How to validate

Type-check + full suite both green:
- `cd packages/fret && npx tsc --noEmit` → clean (exit 0)
- `cd packages/fret && yarn test` → **284 passing**

New test file `test/announce-rate-limit.spec.ts` (6 cases, all deterministic — drives the private handlers directly, no reliance on stabilization timing):
- bucket exhausted → announce dropped + `rejected.rateLimited` +1 + store size unchanged
- bucket has tokens → merge runs, no rate-limited increment, entries ingested
- Edge inbound bucket capacity < Core (drains both buckets, compares)
- Core announce with 30 successors / 30 predecessors / 20 sample → store grows by exactly `1 (from) + 16 + 16 + 8 = 41` (uncapped would be 81)
- Edge same input → `1 + 8 + 8 + 6 = 23`
- `mergeSnapshotCaps()` returns the documented values for both profiles (guards the single-source-of-truth invariant that keeps announce and neighbor-fetch caps in lockstep)

## Use cases exercised
- **Attack:** one connected peer floods announces → bucket drains, subsequent announces dropped, counter climbs. (unit-tested via direct bucket drain)
- **Attack:** one crafted announce carrying thousands of ids → merge caps clamp ingest to the profile bound. (unit-tested at 30/30/20 → capped)
- **Normal:** legit announce under quota → merged fully. (unit-tested)

## Known gaps / where the reviewer should push

- **Bucket rate values are first-cut guesses**, not derived from measured churn load. A `NOTE:` tripwire sits at the `bucketAnnounceInbound` init site: on a large Core ring, churn can produce many *legitimate* announces from distinct neighbors at once; if `diag.rejected.rateLimited` climbs in normal operation the fix is to raise these constants, not to assume an attack. Reviewer: sanity-check the Core numbers against `announceFanout` (8) and expected neighbor count.
- **No end-to-end (real-transport) test of the gate.** The rate-limit and cap tests call `handleAnnounce` / `mergeAnnounceSnapshot` directly for determinism. The wire path (register → announceNeighbors → readAllBounded → decode → gate) is already covered for identity by `identity-verification.spec.ts` but not re-exercised here for rate limiting. If desired, an integration test that spams `announceNeighbors` from a connected mem node and asserts `rejected.rateLimited > 0` would close this — flag is that it is timing-sensitive.
- **Global, not per-peer.** This is a global bucket; a single hostile peer shares the same bucket as honest peers, so a flood can cause honest announces to be dropped (collateral). Per-peer rate limiting is explicitly still planned (docs "not yet implemented"); out of scope for M-core-2.
- **Sample entries are not coordinate-verified.** Merge still trusts `sample[].coord` (base64url) as-is; re-hashing sample coords rather than trusting them is a separate planned item (docs "Verify ring coordinates in sample entries"), untouched here.

## Review findings index (tripwire parked)
- Inbound-announce bucket rate constants are unvalidated first-cut values → parked as a `NOTE:` code comment at the `bucketAnnounceInbound` constructor init in `fret-service.ts` (condition: `rejected.rateLimited` rising in normal Core operation). Not a ticket.
