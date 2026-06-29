description: A node should only route to, count, and gossip peers that actually belong to its own network. This ticket uses the per-peer network label from the previous ticket to keep peers from other networks out of the neighbor ring, cohort selection, size estimate, and discovery feed.
prereq: ring-membership-classification
files:
  - packages/fret/src/store/digitree-store.ts (neighborsRight/Left/successorOfCoord/predecessorOfCoord: optional filter predicate + bounded scan)
  - packages/fret/src/service/cohort.ts (assembleCohort: thread optional filter)
  - packages/fret/src/estimate/size-estimator.ts (estimateSizeAndConfidence: optional filter)
  - packages/fret/src/service/fret-service.ts (member-scoped getNeighbors/assembleCohort/snapshot/selectDiverseSample/emitDiscovered/enforceCapacity; size estimate over members)
  - packages/fret/src/service/peer-discovery.ts (FretPeerDiscovery.scan: emit members only)
  - packages/fret/test/ring-membership.spec.ts (extend: assert ring/cohort/estimate exclusion)
  - docs/fret.md (Discovery / Ring membership / Network size estimation sections)
difficulty: medium
----

# Gate ring membership, cohort, size estimate, and discovery on network membership

## What this builds on

`ring-membership-classification` (prereq) adds `PeerEntry.membership: 'unknown' | 'member' | 'foreign'`
and the logic that fills it in. That ticket changed no read path — every peer, foreign or not, still
appears in neighbor sets, cohorts, the size estimate, and the discovery feed. **This ticket makes
those reads member-only**, which is the actual cure: a foreign peer is never a neighbor, cohort
member, routing candidate, discovery emission, or size-estimate contributor for this network.

"Member-only" means: `membership === 'member'`. Self is seeded as `member` by the prereq, so self is
always included. `unknown` peers are excluded from the ring (they are not yet confirmed same-network);
the prereq's probe pass resolves them to `member`/`foreign` within ~1 tick so they are not starved —
that pass reads the store directly, *not* the ring views gated here, which is why the probe still sees
them.

## The single seam

Every ring-shaped read funnels through `DigitreeStore`'s ordered-walk methods
(`neighborsRight`, `neighborsLeft`, `successorOfCoord`, `predecessorOfCoord`) — directly via
`FretService.getNeighbors` (`fret-service.ts:898`) and transitively via `cohort.ts`'s `assembleCohort`
(which calls `neighborsRight/Left`). Filtering **inside the walk** (skip non-members, keep advancing)
rather than filtering the result is required: if the `wants*2` nearest ring slots are mostly foreign,
post-filtering would starve the cohort, whereas skip-and-continue still collects `wants` members.

Keep the store **network-agnostic**: add an optional `filter?: (e: PeerEntry) => boolean` parameter to
the four walk methods (default `undefined` = no filtering → simulator and existing direct-store callers
are byte-for-byte unchanged). `FretService` owns the predicate `e => e.membership === 'member'` and
passes it; the store never names `membership`. Add a **bounded-scan guard** to the walks: when a filter
is supplied, stop after scanning at most `store.size()` entries so a ring with zero members can't spin
on the wrap-around (`neighborsRight`/`Left` currently loop `while (i < count)` and re-seek `first()`/
`last()` on wrap — that becomes an infinite loop if no entry ever passes the filter).

## Read paths to convert

- **`FretService.getNeighbors`** (`fret-service.ts:898`): pass the member predicate to
  `store.neighborsRight/neighborsLeft`. This is the public API used by Optimystic
  (`libp2p-fret-service.ts`) — member-scoping it is the point.
- **`cohort.ts` `assembleCohort`** (`cohort.ts:12`): add optional `filter` param, forward it to both
  `neighborsRight`/`neighborsLeft`. `FretService.assembleCohort` (`fret-service.ts:920`) passes the
  member predicate; the exported standalone (used by the simulator) defaults to none.
- **`FretService.snapshot`** (`fret-service.ts:862`): `successors`/`predecessors` come from
  `getNeighbors` (now member-scoped automatically). Ensure the `sample` is member-only too — see next.
- **`selectDiverseSample`** (`fret-service.ts:59`): scans `store.list()`; skip entries that are not
  `member` so our outgoing snapshot never advertises a foreign peer to same-network neighbors. This is
  the transitive-propagation guard the source ticket calls out: neighbor-exchange must not re-introduce
  foreign peers. (Inbound merges in `mergeAnnounceSnapshot`/`mergeNeighborSnapshots` still upsert
  received ids as `unknown`; they are then classified by the prereq's machinery before they can be
  used — so received lists are membership-checked, not trusted.)
- **Size estimation** (`size-estimator.ts:18`): add an optional `filter` param; iterate only members
  so `n_est` (and the derived `d_max` / cluster span / near-radius) reflect this network only.
  `FretService` (`fret-service.ts:864`, and `getNetworkSizeEstimate`) passes the member predicate; the
  exported standalone defaults to counting all (simulator unchanged).
- **Discovery emission**: `FretService.emitDiscovered` (`fret-service.ts:953`) and
  `FretPeerDiscovery.scan` (`peer-discovery.ts:67`) must emit only `member` peers, so foreign peers are
  never surfaced to libp2p's discovery pipeline (which is what re-seeds them into selection upstream).
  `FretPeerDiscovery` already holds the store; read `entry.membership` directly alongside the existing
  `state !== 'dead'` check.
- **`enforceCapacity`** (`fret-service.ts:196`): its `protectedIdsAround` set is built from
  `neighborsRight/Left`; once those are member-scoped, foreign peers are no longer protected and
  (with relevance 0) become preferred eviction victims — desirable. Verify the protect set still uses
  the member-scoped walk so a foreign peer can't squat in a protected slot.

## Edge cases & interactions

- **Cohort starvation under heavy foreign load.** With skip-and-continue + the `wants*2` over-fetch,
  the walk must still reach `wants` members when foreign peers cluster near the key. Test with a ring
  where the nearest several slots to the key are foreign and assert the cohort still returns the
  expected same-network members. NOTE the worst-case walk cost (scanning past many foreign entries up
  to `store.size()`); record as a tripwire at the walk site — *if* shared-infra rings get large and
  mostly-foreign, maintain a member-only secondary index instead of skip-scanning.
- **Fresh same-network peer not starved.** An `unknown` peer is excluded here but promoted to `member`
  by the prereq's probe within ~1 tick, after which it appears in the ring. Assert it eventually
  appears (not that it appears instantly).
- **Single-network deployments.** After warm-up every peer is `member`, so member-scoping is a no-op
  on results; the only cost is the membership comparison per walked entry. Regression-guard: an
  existing single-network spec's neighbor/cohort output is unchanged.
- **Size estimate with foreign peers present.** `net-a`'s estimate must equal what it would be with
  only `net-a` peers + self — assert the foreign peer does not inflate `n_est`.
- **Self always present.** Self is `member`; member-scoped walks/estimate/sample include it. A
  single-node ring still self-reports membership and a size estimate of 1.
- **Simulator / standalone exports unchanged.** `assembleCohort` and `estimateSizeAndConfidence`
  default to no filter; add/keep a test that the standalone exports behave identically with membership
  unset.
- **Relayed / limited connections.** No new connection handling — gating is read-side only.

## Acceptance (from the source ticket)

- Two FRET services with different `networkName`s sharing a bootstrap: each one's ring, neighbor set,
  cohort output, size estimate, and discovery emissions contain only same-network peers + self; the
  foreign peer never appears.
- A fresh same-network peer is admitted once confirmed and is not starved by the gate.
- Single-network behavior and discovery latency are unchanged (regression guard).
- `docs/fret.md` Discovery / Ring-membership / Network-size-estimation sections describe the
  network-scoped admission rule.

## TODO

### Phase 1 — store seam
- Add optional `filter?: (e: PeerEntry) => boolean` to `neighborsRight`, `neighborsLeft`,
  `successorOfCoord`, `predecessorOfCoord`; skip-and-continue on filter miss; bounded scan
  (≤ `size()`) when a filter is supplied. Default no-filter preserves current behavior.

### Phase 2 — member-scoped reads in FretService
- Thread the member predicate through `getNeighbors`, `assembleCohort` (and `cohort.ts`'s param),
  `selectDiverseSample`, and `getNetworkSizeEstimate`/`snapshot` (via `size-estimator` param).
- Member-scope `emitDiscovered` and `FretPeerDiscovery.scan`.
- Verify `enforceCapacity`'s protect set is member-scoped.
- Add the worst-case-walk-cost `NOTE:` tripwire at the walk site.

### Phase 3 — tests & docs
- Extend `test/ring-membership.spec.ts`: foreign peer absent from `net-a`'s `getNeighbors`,
  `assembleCohort`, size estimate, and discovery emissions; same-network peer present; foreign-near-key
  cohort-starvation case; fresh-peer eventually-admitted case; single-network regression; standalone
  `assembleCohort`/`estimateSizeAndConfidence` unchanged with membership unset.
- Update `docs/fret.md` (Discovery, Ring membership / cluster membership, Network size estimation) to
  state the network-scoped admission rule and that ring views are member-only.
- Run `npx tsc --noEmit`, `yarn build`, and `yarn test`; stream output (`yarn test 2>&1 | tee
  /tmp/fret-test.log`).
