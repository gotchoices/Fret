----
description: Peers from other networks sharing the same transport are now kept out of this network's neighbor ring, cohort selection, size estimate, snapshot sample, and discovery feed — a node only routes to, counts, and gossips its own network's peers.
prereq:
files:
  - packages/fret/src/store/digitree-store.ts (optional filter on neighborsRight/Left/successorOfCoord/predecessorOfCoord + bounded-scan guard; protectedIdsAround forwards filter)
  - packages/fret/src/service/cohort.ts (assembleCohort optional filter)
  - packages/fret/src/estimate/size-estimator.ts (estimateSizeAndConfidence optional filter)
  - packages/fret/src/service/fret-service.ts (isMember predicate; member-scoped getNeighbors/assembleCohort/snapshot/selectDiverseSample/size-estimate/emitDiscovered/enforceCapacity; NEW foreign re-probe pass)
  - packages/fret/src/service/peer-discovery.ts (FretPeerDiscovery.scan emits members only)
  - packages/fret/test/ring-membership.spec.ts (gating + foreign re-probe tests)
  - packages/fret/test/peer-discovery.spec.ts (member-only emission)
  - docs/fret.md (Discovery / Ring membership / Network-scoped admission / Network size estimation)
----

# Review: gate ring, cohort, size estimate, and discovery on network membership

## What landed

The prereq (`ring-membership-classification`) added a tri-state `membership` label
(`unknown` | `member` | `foreign`) to every routing-table entry but changed **no read path**.
This ticket makes the read paths **member-only**: a peer participates in this network's ring
only once its `membership === 'member'`. A `foreign` (or still-`unknown`) peer is never a
neighbor, cohort member, routing candidate, size-estimate contributor, snapshot sample entry,
or discovery emission. Self is seeded `member`, so a single-node ring still self-reports.

**The single seam.** All four ordered-walk methods on `DigitreeStore` (`neighborsRight`,
`neighborsLeft`, `successorOfCoord`, `predecessorOfCoord`) take an optional
`filter?: (e: PeerEntry) => boolean`. On a miss the walk **skips and keeps advancing** (not
stop), so a cluster of foreign peers nearest a key can't starve the cohort — the alternating
walk over-fetches `wants * 2` and still collects `wants` members. A **bounded-scan guard**
caps a filtered walk at one full traversal (`size()` entries) so a ring with zero matches
terminates instead of spinning on the wrap-around. The store stays network-agnostic (never
names `membership`); `FretService` owns the predicate `isMember = e => e.membership === 'member'`
and passes it. With no filter (the default) behavior is **byte-for-byte unchanged**, so the
design simulator and the exported `assembleCohort` / `estimateSizeAndConfidence` /
`selectDiverseSample` standalones are unaffected.

**Converted read paths** (all in `fret-service.ts` unless noted): `getNeighbors`,
`assembleCohort` (+ `cohort.ts`), `snapshot` (successors/predecessors via `getNeighbors`,
plus member-scoped `sample` and size estimate), `selectDiverseSample`, every
`estimateSizeAndConfidence` call site (`size-estimator.ts`), `emitDiscovered` +
`FretPeerDiscovery.scan` (`peer-discovery.ts`), and `enforceCapacity`'s `protectedIdsAround`
(so a foreign peer can't squat in a protected slot and, at relevance ~0, becomes a preferred
eviction victim).

**Deliberately left unfiltered** (maintenance / bootstrap / announce-*target* walks, each
commented at the site): announce-target selection, preconnect/active warm-up, leave-notice
fan-out (`sendLeaveToNeighbors`/`handleLeave`/`computeReplacements`),
`announceReplacementsToNeighbors`, `announceOnDeparture`, `isNearNeighbor`. Rationale: these
must reach **not-yet-classified** peers (a ping is itself a classification signal), and the
ones that emit data emit member-scoped *snapshots* — only the *targets* are unfiltered.

## NEW work beyond the original ticket — foreign re-probe (please scrutinize)

The prereq's review left a tripwire aimed squarely at this ticket: once gating excludes
`foreign` peers from the ring, `probeNeighborsLatency` (which pings near *ring* peers) no
longer touches them — closing the RPC path that used to self-heal a same-network peer that
got **mislabeled** `foreign` (e.g. libp2p `identify` completed before the peer had registered
our protocol handlers). The prereq said gating "must add an occasional foreign re-probe or
guarantee the `peer:update` path."

I added `FretService.reprobeForeignPeers()` (called from `stabilizeOnce` after
`classifyUnknownPeers`): each tick it re-probes a small, bounded number of off-backoff,
reachable `foreign` peers (core 2 / edge 1) with a namespaced ping; a success re-admits the
peer to `member`. To keep it from hammering *genuinely* foreign peers, `probeMembership` now
records a growing backoff when it **confirms** foreign (the `UnsupportedProtocolError` branch),
so a real foreign peer is re-probed at most about once per backoff window, not every tick.

**Why this needs a reviewer's eye:**
- It is **scope beyond the original ticket** (the original listed only read-path gating). I
  judged it in-scope because the prereq explicitly assigned it here and it is a real latent
  gap; a reviewer may disagree and prefer it split out.
- The `recordBackoff` added to the confirmed-foreign branch also feeds the next-hop cost
  function's `backoffPenalty`. Post-gating a foreign peer is not a next-hop candidate, so I
  believe there's no adverse interaction — **please confirm.**
- The real-world trigger (identify-race mislabel via `classifyByProtocols`) is **still
  untested** — the in-memory harness runs no `identify` service. That gap is already tracked
  by the prereq's `backlog/debt-membership-identify-integration-test`.

## Tests (this is a floor, not a ceiling)

`test/ring-membership.spec.ts` — new `describe('Ring membership gating')` (pure store/standalone,
fast + deterministic):
- `neighborsRight/Left` skip foreign and keep advancing.
- A filtered walk with **zero** matches terminates and returns empty (bounded-scan guard).
- **Foreign-near-key starvation**: with the closest slots to the key all foreign, the cohort
  still returns `wants` members; contrast asserts the unfiltered cohort *would* pick foreign.
- **Fresh peer**: excluded while `unknown`, admitted once flipped to `member`.
- Size estimate over members equals an estimate over a members-only store; unfiltered estimate
  is strictly larger (foreign inflation).
- `selectDiverseSample` member-scoping; standalone (no filter) still includes foreign.
- **Single-network regression**: member-scoped == unfiltered when every peer is a member.
- Standalone exports unchanged when membership is unset.

`test/ring-membership.spec.ts` — `describe('classification (probe-based)')` (live in-memory libp2p):
- End-to-end net-a/net-b/net-c: foreign B absent from A's `getNeighbors`, `assembleCohort`,
  size estimate, and discovery emissions; same-network C present.
- **NEW** `re-admits a same-network peer that was mislabeled foreign` — exercises
  `reprobeForeignPeers` (see harness caveat below). Ran 3× clean.

`test/peer-discovery.spec.ts` — `FretPeerDiscovery.scan` emits members only, never foreign.

**Validation:** `npx tsc --noEmit` → 0; `yarn build` → ok; `yarn test` → **254 passing, 0
failing**. No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` was written.

## Honest gaps & things to probe

- **In-memory transport ping quirk (pre-existing, shaped the test).** Over the `/memory`
  transport with `negotiateFully: false`, only the **first** A→C ping on a reused connection
  returns bytes; subsequent A→C pings read **empty** (`ok:false`). Existing tests are immune
  (a peer needs only one successful ping to become `member`, then stays). It bit the foreign
  re-probe test, which needs a re-admitting ping *after* steady state — so the test is
  structured to tag C `foreign` **before** the unknown-probe pings it, making the re-probe's
  ping the first (and only good) A→C ping. I could not determine whether this is purely a
  memory-transport artifact or would affect repeated TCP pings in production; the simulation
  suite uses its own harness (not real libp2p) and the real-libp2p tests only ever need one
  ping, so neither exercises it. **Recommend the reviewer decide whether this warrants a
  `debt-` repro over TCP.** It is not a test failure (everything passes), so it is recorded
  here rather than in `.pre-existing-error.md`.
- **Worst-case filtered-walk cost.** A filtered walk is O(`size()`) when matches are sparse
  near the coord (large, mostly-foreign shared-infra ring). Recorded as a `NOTE:` tripwire at
  the walk site in `digitree-store.ts` — if it ever shows as slow, add a member-only secondary
  index. Conditional; not ticketed.
- **`computeReplacements` can suggest a foreign peer** as a leave-notice replacement to a
  same-network neighbor (unfiltered walk). Mitigated because the recipient upserts suggestions
  as `unknown` and classification vets them before any ring use — same guard as inbound
  snapshot merges — so it can't enter a ring un-vetted. Flagged because it is an outbound
  propagation surface not in the original ticket's transitive-propagation list; a reviewer may
  want it member-scoped for tidiness.
- **`unknown`-peer latency.** A fresh same-network peer is excluded from the ring until the
  probe pass promotes it (~1 tick). Tested only at the unit level (flip `unknown`→`member`),
  matching the ticket's "assert it *eventually* appears" guidance — not a live timing test.

## Docs

`docs/fret.md` updated: new "Network-scoped admission (member-only ring views)" subsection;
"Determining cluster membership", "Network size estimation", and "libp2p integration /
Discovery" now state the member-only rule; the classification section gained a "Foreign
re-probe pass" bullet. The stale "no read path consumes it yet" paragraph was replaced.
