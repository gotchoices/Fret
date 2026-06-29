----
description: Peers from other networks sharing the same transport are now kept out of this network's neighbor ring, cohort selection, size estimate, snapshot sample, and discovery feed — a node only routes to, counts, and gossips its own network's peers.
prereq:
files:
  - packages/fret/src/store/digitree-store.ts
  - packages/fret/src/service/cohort.ts
  - packages/fret/src/estimate/size-estimator.ts
  - packages/fret/src/service/fret-service.ts
  - packages/fret/src/service/peer-discovery.ts
  - packages/fret/test/ring-membership.spec.ts
  - packages/fret/test/peer-discovery.spec.ts
  - docs/fret.md
----

# Complete: gate ring, cohort, size estimate, and discovery on network membership

Implements member-only ring views on top of the tri-state `membership` label added by the
`ring-membership-classification` prereq. A peer participates in this network's ring
(neighbors, cohort, routing candidates, size estimate, snapshot sample, discovery
emission) only once its `membership === 'member'`; `foreign` and still-`unknown` peers are
excluded. Self is seeded `member` so a single-node ring still self-reports. Also adds the
`reprobeForeignPeers` backstop that re-admits a mislabelled same-network peer via a
namespaced ping (the prereq's review tripwire, explicitly aimed here).

See the implement-stage handoff (commit `7a57bad`) for the full architecture: the single
`filter?` seam on `DigitreeStore`'s four ordered-walk methods, the skip-and-advance +
bounded-scan-guard behaviour, the list of converted read paths, and the list of
deliberately-unfiltered maintenance/announce-target walks.

## Review findings

Reviewed the implement diff (`7a57bad`) with fresh eyes against every read path, then the
handoff. Validation re-run clean: `npx tsc --noEmit` → 0; `yarn test` → **254 passing, 0
failing** (after the doc/comment edits below).

### What was checked

- **The store seam (`digitree-store.ts`).** Verified all four walk methods
  (`neighborsRight/Left`, `successorOfCoord`, `predecessorOfCoord`) skip-and-advance on a
  filtered miss and that the bounded-scan guard (`scanned < size()`) terminates a
  zero-match walk and prevents wrap-around double-counting (each entry visited ≤ once, so
  the trailing `new Set(out)` dedup is only defensive). No-filter path is byte-for-byte
  unchanged (`maxScan = +Infinity`). ✓
- **Starvation.** Confirmed `assembleCohort`'s `wants * 2` over-fetch per side plus
  skip-and-advance returns `wants` members even when the slots nearest the key are all
  foreign — covered by a dedicated test, with a contrast assertion that the *unfiltered*
  cohort would have picked foreign. ✓
- **All converted read paths** (`getNeighbors`, `assembleCohort`, `snapshot` neighbors +
  sample + size estimate, `selectDiverseSample`, every `estimateSizeAndConfidence` call
  site, `emitDiscovered`, `FretPeerDiscovery.scan`, `protectedIdsAround`). Routing
  candidates flow from member-scoped `assembleCohort`; the in-cluster test
  (`neighborDistance`) and `nearAnchorOnly` / `buildNearAnchor` flow from member-scoped
  `getNeighbors`. Self (seeded `member`) is correctly retained in all of them. ✓
- **Deliberately-unfiltered walks** (announce targets, preconnect/active warm-up, leave
  fan-out, `announceReplacementsToNeighbors`, `announceOnDeparture`, `isNearNeighbor`).
  Each is a *target-selection* walk that must reach not-yet-classified peers; the data they
  emit is the member-scoped `snapshot()`. The switch from `getNeighbors` back to raw
  `store.neighborsRight/Left` correctly preserves pre-gating reach (a ping is itself a
  classification signal). ✓
- **Bootstrap convergence.** On a fresh join every peer is `unknown`, so member-scoped
  `getNeighbors` is initially empty; `classifyUnknownPeers` reads the store *directly* (not
  the gated views) and promotes same-network peers within ~1 tick, after which the ring
  populates. Live in-memory test confirms convergence within 6s. ✓
- **Eviction interaction.** `protectedIdsAround(self, …, isMember)` protects only member
  neighbors, so a foreign peer (relevance ~0) is an eviction victim under capacity
  pressure. Consistent with `markForeign`'s "tag and retain" (which only governs that
  `markForeign` itself never evicts); capacity pressure is a separate path. ✓
- **Backoff / next-hop interaction** (handoff asked to confirm). `recordBackoff` on the
  confirmed-foreign branch feeds the next-hop cost's `backoffPenalty`, but post-gating a
  foreign peer is never a next-hop candidate (candidates come from member-scoped
  `assembleCohort`), so there is no adverse routing interaction. ✓ Confirmed.
- **Docs.** Read every touched file against `docs/fret.md`; the member-only rule is now
  stated in Discovery, cluster membership, size estimation, and the new "Network-scoped
  admission" subsection. ✓

### Found and fixed in this pass (minor)

- **Inaccurate "growing backoff" claim (doc + code comment).** The foreign re-probe's
  backoff does **not** actually grow. `reprobeForeignPeers` only selects peers whose
  `getBackoffPenalty(id) === 0`, and `getBackoffPenalty` *deletes* the backoff record on
  expiry — so when a confirmed-foreign peer becomes eligible again the prior record is
  gone and `recordBackoff` always re-seeds `factor = 1`. The throttle is therefore a fixed
  ~1s window, not a taper; in passive mode (tick ≥ 1s) a genuinely-foreign peer is
  re-probed roughly every budget-reached tick. Corrected the over-claim in
  `docs/fret.md`'s "Foreign re-probe pass" bullet and the code comment in
  `probeMembership`'s confirmed-foreign branch to describe the real behaviour and point at
  the new debt ticket.

### Filed as a new ticket (major-ish; safe fix needs care + its own test)

- **`tickets/backlog/debt-foreign-reprobe-backoff-growth`** — make the confirmed-foreign
  re-probe backoff actually taper toward the 32× cap. Not fixed inline because the proper
  fix touches shared backoff infrastructure (`recordBackoff` / `getBackoffPenalty` /
  `clearBackoff`), also consumed by `classifyUnknownPeers` and the next-hop cost function,
  and wants a dedicated growth test. Impact is bounded (budget-capped, multi-network-only,
  re-admission still works), hence `debt-` not `bug-`.

### Tripwires (recorded, not ticketed)

- **Worst-case filtered-walk cost is O(`size()`)** when matches are sparse near the coord
  (large, mostly-foreign shared-infra ring). Already carried as a `NOTE:` at the walk site
  in `digitree-store.ts` (add a member-only secondary index if it ever shows as slow).
  Conditional — left as-is.
- **Per-tick O(C) store scans.** `classifyUnknownPeers` and now `reprobeForeignPeers` each
  scan the whole store every tick even in steady state. `classifyUnknownPeers` already has
  the `NOTE:` covering this pattern (track an unknown-/foreign-count for an O(1) no-op
  tick). `reprobeForeignPeers`, unlike the unknown pass, does **not** go to no-op in a
  multi-network steady state (foreign peers persist), so it is a perpetual O(C)-per-tick
  scan there — folded into the same future optimization. Conditional — not ticketed.

### Deliberately not changed (noted, no action)

- **`computeReplacements` / leave-notice replacements can suggest a foreign peer** to a
  same-network neighbor (unfiltered walk). Safe: the recipient upserts suggestions as
  `unknown` and classification vets them before any ring use — same guard as inbound
  snapshot merges. Left unfiltered for parity with the sibling maintenance walks; a future
  tidy-up could member-scope it but there is no correctness need.
- **In-memory `/memory` transport ping quirk** (only the first ping on a reused connection
  returns bytes) shaped the foreign-re-probe test's structure but is not a product bug and
  not reproducible by the simulation harness or the single-ping real-libp2p tests. Not
  ticketed; recorded here per the handoff's request — a reviewer wanting a TCP repro can
  open a `debt-` ticket, but it is not blocking.
- **Identify-race mislabel (the real-world trigger for foreign re-probe) is still
  integration-untested** — the in-memory harness runs no `identify` service. Already
  tracked by the prereq's `backlog/debt-membership-identify-integration-test`; no new
  ticket.

### Pre-existing (not introduced here, not failures)

- Editor surfaced three unused-local hints in `fret-service.ts`
  (`nextSuccessor`/`nextPredecessor` ~line 1129/1133, `selfCoord` in `routeAct` ~line
  1220). They are outside this ticket's diff, and `tsc --noEmit` exits 0 (the project does
  not enforce `noUnusedLocals` as an error), so they are not build/test failures — no
  `.pre-existing-error.md` written.
