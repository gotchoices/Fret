description: Each node now remembers, from its own observations only, how long each peer has been continuously up, gives long-lived peers a bounded edge in its routing table's eviction scoring, and lets the application ask for that number.
architecture: docs/fret.md#relevance-scoring-and-table-management
files: packages/fret/src/store/tenure.ts, packages/fret/src/store/digitree-store.ts, packages/fret/src/store/relevance.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/index.ts, packages/fret/src/service/libp2p-fret-service.ts, packages/fret/test/tenure.spec.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/test/libp2p-facade-forwarding.spec.ts, docs/fret.md, AGENTS.md
----
## What landed

**Tenure** = the span this node itself observed a peer staying up. A *session* is a run of proofs of life with no gap over 15 min (`TENURE_GAP_TOLERANCE_MS`, our clock); proven tenure = `lastProvenAliveAt − sessionStartedAt`, frozen while the peer is silent. Local, proof-only, never gossiped.

- `src/store/tenure.ts` — pure, clock-free: constants, `noteProven(cur, now)`, `provenTenureMs`, `stabilityFactor(t) = 1 + 0.5·t/(t + 1 h)`.
- `PeerEntry` gains `sessionStartedAt` / `lastProvenAliveAt` (0 = never proven); serialized as optionals, restored on import (not reset).
- Relevance: all four scoring functions multiply by `stabilityFactor(provenTenureMs(entry))` through one helper, `weighted`.
- `FretService.noteProofOfLife` is the only write site; the stamp rides the liveness patch, is coalesced to one write per second per peer, and is not a change for the idle backoff.
- `getPeerTenure(peerId)` on the `FretService` interface, core and facade.
- Cohort order and next-hop selection untouched by design; `NOTE:` at `linkQuality` says when to fold tenure in.

## Review findings

Read the `ticket(implement): peer-session-tenure` diff first, then the handoff; ran `npx tsc --noEmit` (clean) and `yarn test` (1336 passing, 0 failing, ~5 min).

**Fixed inline (minor):**
- **`provenTenureMs` could return `Infinity`** despite its doc comment ("never negative or non-finite"). Two finite JSON numbers (`lastProvenAliveAt: 1.7e308`, `sessionStartedAt: -1.7e308`) subtract to `Infinity`, and `stabilityFactor(Infinity)` is `NaN` — so the handoff's "unreachable" claim was wrong: a persisted table (and the codec property generator, which draws `fc.double`) can carry it, and a `NaN` relevance breaks eviction ordering until the peer's first proof starts a new session. Guarded with `Number.isFinite`; one test row added in `test/tenure.spec.ts` (the reproduction of this defect).
- **Scoring lagged the stamp by one proof** (flagged by the implementer). Worse than "off by one contact interval": a peer back after a long absence had its first success scored with the *previous* session's frozen tenure (up to ×1.48), which then stayed in the stored relevance until its next scoring call — for a rarely-contacted peer, a long time. `applySuccess` now raises the membership signal and `noteRpcEvidence` before reading the entry it scores, matching `peer:connect` (stamp, then `applyTouch`). The score patch never touches the fields those seams write (`state`, `contactFailures`, `membership`, tenure), so moving them ahead of the `selfCoord()` await cannot clobber or be clobbered. Docstring updated.
- **Wrong number in docs and code comment**: the factor at one day is 1.48 (`1 + 0.5·24/25`), not 1.49. Fixed in `docs/fret.md` and `tenure.ts`.

**Checked, no change needed:**
- Lost updates across the scoring awaits: `applyTouch` / `applySuccess` / `applyFailure` patch field by field and none names a tenure field, so a stamp landing across their await survives. Confirmed by reading.
- Hearsay isolation: `noteDiscovered`, address-hint ingestion and the peerStore listeners never reach `noteProofOfLife`; `initialRelevance` on a fresh entry sees tenure 0 → factor 1, so the hearsay baseline is unchanged.
- Idle backoff: a stamp-only write returns before `noteChange`; the two-node idle-strand test in `test/near-exchange.spec.ts` stays green.
- Self guard, `upsert` defaults, import/export of both fields, facade forwarding (count 21 and membership asserted), `verbatimModuleSyntax`-safe imports.
- Clock backwards / non-finite / string stamps from a tampered table: `noteProven` falls to a fresh session and `provenTenureMs` reads 0; inflation of tenure by a tampered table is bounded (×1.5) and already noted at the import site against the table-signing backlog ticket.
- Docs: *Tenure* bullets, formula block, serialized-table interface, `getPeerTenure` under *Flexible cohort*, idle-backoff "not a change" list, AGENTS.md layout — all read and consistent with the code after the fixes above.

**Tests:** `tenure.spec.ts` rows each pin a branch of the gap/granularity/backwards rule — kept. Codec generator change covers the new optionals in existing properties — kept. Literal fixes in two relevance specs are compile-only. Added one row (above). No service-level stamp test, by design — the follow-on `tenure-dead-grace` drives that seam end to end.

**Tripwires / declined:** none filed. Frozen tenure of a long-dead peer still multiplies its relevance at eviction (up to ×1.5) indefinitely — that is the documented design ("a server under maintenance keeps its edge") and the `tenure-dead-grace` ticket builds on it; its relevance still decays through `recordFailure`'s ×0.7 per failure. Store write cost (≤ 1 `store.update` per second per settled peer) left as the handoff stated, unmeasured.

**Major findings:** none.
