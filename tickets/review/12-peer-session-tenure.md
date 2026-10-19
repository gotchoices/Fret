description: Each node now remembers, from its own observations only, how long each peer has been continuously up, gives long-lived peers a bounded edge in its routing table's eviction scoring, and lets the application ask for that number. Review the implementation.
architecture: docs/fret.md#relevance-scoring-and-table-management
files: packages/fret/src/store/tenure.ts (new), packages/fret/src/store/digitree-store.ts, packages/fret/src/store/relevance.ts, packages/fret/src/service/fret-service.ts (noteProofOfLife, livenessPatch, linkQuality NOTE, getPeerTenure), packages/fret/src/index.ts, packages/fret/src/service/libp2p-fret-service.ts, packages/fret/test/tenure.spec.ts (new), packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/test/libp2p-facade-forwarding.spec.ts, packages/fret/test/relevance.eviction.spec.ts, packages/fret/test/relevance.properties.spec.ts, docs/fret.md, AGENTS.md
----
## What landed

**Tenure** = the span this node itself observed a peer staying up. A *session* is a run of proofs of life with no gap over 15 min (`TENURE_GAP_TOLERANCE_MS`, on our clock); proven tenure = `lastProvenAliveAt − sessionStartedAt`, frozen while the peer is silent. Local, proof-only, never gossiped.

- `src/store/tenure.ts` — pure, clock-free: constants, `noteProven(cur, now)` (patch or `undefined`), `provenTenureMs`, `stabilityFactor(t) = 1 + 0.5·t/(t + 1 h)`. `noteProven` is written as "continue only when `0 ≤ gap ≤ tolerance` and previously proven", so a backwards clock and a non-finite stamp both fall to a new session; `provenTenureMs` returns 0 for anything not positive.
- `PeerEntry` gains `sessionStartedAt` / `lastProvenAliveAt` (0 = never proven), defaulted in `upsert`. `SerializedPeerEntry` carries both as optional; export always writes them, import reads a missing one as 0 and does **not** reset them (tenure is history; the gap rule discounts our downtime). Tampering noted in a comment pointing at backlog ticket 23 (table signing), no check added.
- `relevance.ts`: one private `weighted(base, entry, x, model)` = `base · S(x) · stabilityFactor(provenTenureMs(entry))`, used by `touch`, `initialRelevance`, `recordSuccess`, `recordFailure`.
- `FretService.noteProofOfLife` is the only write site. The liveness half was factored into `livenessPatch(e)`; the tenure patch rides the same `store.update`. A stamp alone returns before `noteChange` (not a change → idle backoff unaffected). Self guarded.
- `getPeerTenure(peerId): number | undefined` on the `FretService` interface, core and facade. Facade-forwarding spec count 20 → 21 and asserts `getPeerTenure` is in the set.
- `NOTE:` at `linkQuality`: tenure available; fold in if short-lived hops are measured failing mid-route.
- Cohort order and next-hop selection untouched by design (docs explain why).
- Docs: *Tenure* component bullet under *Relevance scoring and table management*, formula block, serialized-table interface, `getPeerTenure` + cohort-order rationale under *Flexible cohort and thresholding*, and the idle-backoff "not a change" list now names tenure stamps. AGENTS.md layout updated.

## Tests

- `test/tenure.spec.ts` (new): one table over `noteProven` — never proven, within tolerance, exactly at tolerance, over tolerance, under granularity → `undefined`, clock backwards; one case that `stabilityFactor` is 1 at 0, strictly increasing and below `1 + STABILITY_MAX_BONUS`.
- `test/rpc.codec-properties.spec.ts`: the `SerializedPeerEntry` generator now carries the two fields as optionals, so the existing JSON round trip and store-normalization fixpoint properties cover them (no new test).
- `PeerEntry` literals in `relevance.eviction.spec.ts` / `relevance.properties.spec.ts` gained the two fields (compile fix only). Sim harness builds entries through `upsert`, needed nothing.
- `npx tsc --noEmit` clean; `yarn test` 1335 passing, 0 failing (5 min). `test/near-exchange.spec.ts` two-node idle strand — the regression guard for "a stamp is not a change" — green unchanged. No existing relevance-value test moved.

## For the reviewer — known gaps and things worth checking

- **Scoring lags the stamp by one proof.** `applySuccess` scores (reading tenure) *before* calling `noteRpcEvidence` → `noteProofOfLife`, so a success is scored with the tenure as of the previous proof. Harmless (off by at most one contact interval) and left as-is to avoid reordering the success path; `peer:connect` already stamps before its `applyTouch`. Reorder if you disagree.
- **No lost-update risk from the scoring awaits**: `applyTouch` / `applySuccess` / `applyFailure` patch field-by-field, so a tenure stamp written across their `selfCoord()` await is not clobbered. Worth a second look.
- **No service-level test** of the stamp write, per the ticket; the follow-on `tenure-dead-grace` integration test drives it end to end. Until that lands, the seam is pinned only by inspection and the idle-strand regression guard.
- `stabilityFactor(Infinity)` is `NaN`; unreachable (JSON cannot carry `Infinity`; import maps `null` to 0 via `??`). Not guarded.
- Not exported from the package root: the tenure helpers/constants. Only `getPeerTenure` is public surface.
- Store write cost: a settled peer now costs at most one `store.update` per second (was zero). Inspection only, no benchmark, per the ticket.
