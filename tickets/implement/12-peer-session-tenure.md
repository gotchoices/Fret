description: FRET treats a peer it has relied on for weeks the same as one that appeared five minutes ago. Each node should remember, from its own observations only, how long each peer has been continuously up, use that to keep long-lived peers in its routing table ahead of short-lived ones, and let the application ask for it.
architecture: docs/fret.md#relevance-scoring-and-table-management
files: packages/fret/src/store/tenure.ts (new), packages/fret/src/store/digitree-store.ts (PeerEntry, SerializedPeerEntry, upsert defaults, exportEntries, importEntries), packages/fret/src/store/relevance.ts (touch, recordSuccess, recordFailure, initialRelevance, baseRelevance), packages/fret/src/service/fret-service.ts (noteProofOfLife, listPeers neighbourhood for the new accessor), packages/fret/src/index.ts (FretService interface), packages/fret/src/service/libp2p-fret-service.ts (pass-through), packages/fret/test/tenure.spec.ts (new), packages/fret/test/libp2p-facade-forwarding.spec.ts (member count), packages/fret/test/rpc.codec-properties.spec.ts (SerializedPeerEntry generator), docs/fret.md, AGENTS.md
----
## Why

Asked by the maintainer: a server down for a few minutes of maintenance should not be handled like a phone that has been on for five minutes and will probably be gone in five more. Today the routing table has no notion of how long a peer has been around. Relevance counts *how often* we reached a peer (`accessCount`, `successCount`), not *for how long*, and nothing records when a peer's current run of uptime began. The churn literature (Stutzbach & Rejaie's measurements, and the reason Kademlia prefers its oldest contacts) finds that how long a peer has been up so far is the best simple predictor of how long it will stay up.

This ticket adds that signal, measured **locally from proof of life only**. Nothing is gossiped: a peer's tenure is what *this* node observed, so no other peer can inflate it (the same rule as frequency credit; see `noteDiscovered`). Sharing tenure between nodes needs signed evidence and stays in the "Reputation and exclusions (later phase)" section of the docs.

The follow-on ticket `tenure-dead-grace` uses the same signal to give long-lived peers time to come back before they are marked dead. This ticket only records tenure, uses it in eviction scoring, and exposes it.

## The design

### What "tenure" means

A **session** is a run of proofs of life in which no two consecutive proofs are more than `TENURE_GAP_TOLERANCE_MS` (15 min) apart. **Proven tenure** = `lastProvenAliveAt − sessionStartedAt`: the span this node actually observed, frozen while the peer is silent. It never grows on the clock alone, so a peer that has gone quiet does not get credit for the time it was away.

- A server we have heard from steadily for a week has about a week of tenure. If it goes down for 5 minutes its tenure stays frozen at a week, and the next proof after it returns *continues* the session, because 5 minutes is within the 15-minute tolerance.
- A phone that has been up for 5 minutes has at most 5 minutes.
- A peer that comes back after more than 15 minutes of silence starts a new session at 0. That includes the case where *our own* node was off for more than 15 minutes, because the gap is measured on our clock. That is the conservative reading: we cannot vouch for time we did not observe.
- 15 minutes covers "a few minutes of maintenance" with room to spare. It also has to stay comfortably above the longest regular contact interval for a peer we actively watch: the near-window pass at the idle-backoff cap is 60 s, and the dead re-probe arm's window is at most 32 s. Otherwise a healthy neighbour's session would break on its own.

**Accepted limit, stated in the docs:** tenure is meaningful only for peers we hear from regularly, meaning our successor/predecessor window and peers we route through often. A far peer we contact once an hour breaks its session at every contact and reads as tenure 0. That is fine for both consumers here. Eviction already protects the near window, and the peers ranked against each other at eviction are mostly far, so for them the stability factor is ~1 and changes nothing. A node computing a cohort for a key in its own neighbourhood (the in-cluster case, which is when it acts) holds steady contact with exactly those cohort members. Do not try to fix the far-peer case with a longer tolerance: a longer tolerance lets an intermittent peer accumulate tenure across absences.

### Where it lives

New pure module `src/store/tenure.ts`. It has no clock of its own (callers pass `now`) and no service dependencies, the same shape as `idle-backoff.ts`:

```ts
export const TENURE_GAP_TOLERANCE_MS = 15 * 60_000;
/** Below this many ms between stamps, a proof refreshes nothing (write coalescing). */
export const TENURE_STAMP_GRANULARITY_MS = 1_000;
/** Tenure at which the stability factor reaches half its maximum bonus. */
export const STABILITY_HALF_TENURE_MS = 60 * 60_000;
/** Maximum relevance multiplier bonus: factor ∈ [1, 1 + STABILITY_MAX_BONUS). */
export const STABILITY_MAX_BONUS = 0.5;

export interface TenureFields { sessionStartedAt: number; lastProvenAliveAt: number } // 0 = never proven
/** The patch a proof of life at `now` implies, or undefined when nothing needs writing. */
export function noteProven(cur: TenureFields, now: number): TenureFields | undefined;
export function provenTenureMs(cur: TenureFields): number;          // 0 when never proven
export function stabilityFactor(tenureMs: number): number;           // 1 + MAX·t/(t+HALF)
```

`noteProven` rules:
- Never proven (`lastProvenAliveAt === 0`), or the gap since the last proof is greater than the tolerance: start a new session at `now`.
- Gap at or below the tolerance: keep `sessionStartedAt` and advance `lastProvenAliveAt` to `now`.
- Advanced by less than the granularity: return `undefined` and write nothing. A burst of RPCs then costs one store write, not one per message.
- `now < lastProvenAliveAt` (the clock went backwards, or the table was imported from a skewed clock): treat it as a new session at `now`. Never produce negative tenure.

`stabilityFactor`: at 5 minutes it is about 1.038, at 1 hour 1.25, at 1 day about 1.49. It is monotone and bounded, so it can never let tenure dominate the other relevance terms.

### PeerEntry fields

Add `sessionStartedAt: number` and `lastProvenAliveAt: number` to `PeerEntry`, both local-clock unix ms, 0 meaning never proven. Document them like the other counters: the store stores them and never branches on them. Defaults are 0 in `upsert`. `upsert` already preserves every mutable field on a hit, so no change is needed there beyond the defaults.

**Serialized**, as optional fields on `SerializedPeerEntry` (they are on our own clock, so they mean the same thing after our restart). On import, a missing field reads as 0. They are *not* reset on import, unlike `contactFailures`: tenure is history, not liveness, and the gap rule already discounts our own downtime. A tampered file can inflate tenure, exactly as it can inflate the imported `relevance` and counters today. Table signing (`tickets/backlog/23-debt-routing-table-export-signing.md`) is where that class is closed. Say so in a sentence rather than adding a check.

### The one write site

`noteProofOfLife` (in `fret-service.ts`) is already the single seam every proof of life passes through: completed outbound RPCs and every inbound RPC via `noteRpcEvidence`, plus `peer:connect` directly. It is the only place tenure advances. Today it returns early with no write when the peer is already settled. Fold the `noteProven` patch into the same `store.update` call and keep its existing rule: **a tenure stamp alone is not a change** (no `noteChange`). Otherwise every RPC would reset the idle backoff, undoing `stabilize-idle-backoff`.

Hearsay paths never touch tenure: `noteDiscovered`, address hints, peerStore listeners, `peer:update`. `noteAnsweredOnProtocol` reaches the seam through `noteRpcEvidence` and does count, because an answer that arrived is proof of life whatever its body said. That matches the evidence table in the docs.

Self never reaches the seam with an RPC. Still guard `id === selfIdStr` cheaply, so self's entry never carries a meaningless tenure.

### Eviction: tenure in relevance

Multiply the stability factor into every relevance computation: `touch`, `recordSuccess`, `recordFailure` and `initialRelevance` in `src/store/relevance.ts`, as `base · S(x) · stabilityFactor(provenTenureMs(entry))`. `relevance.ts` already imports `PeerEntry` from the store. The helpers live in `src/store/` rather than `src/service/` for exactly this import: they are entry bookkeeping, not service policy, and the follow-on ticket's grace function lives beside it.

Consequences, all intended:
- A brand-new or hearsay entry has tenure 0 and factor 1, so `initialRelevance` is unchanged. **Existing tests that pin relevance values should stay green.** If one moves, it is because its rig produced real tenure; read it before adjusting.
- A long-tenured peer that is failing (a server under maintenance) is scored by `recordFailure` with its frozen tenure, so it keeps up to a 1.5× edge at eviction over a fresh peer with similar counters.
- Relevance is still *compared as stored* at eviction. The docs already say so; tenure does not change that.

Not in scope, deliberately:
- **Cohort order is not changed.** Cohort membership has to agree across nodes: the in-cluster test is "am I among the first k of the key's cohort", computed independently by every node from its own view. Reordering it by *local* tenure would make views diverge in exactly the way the ring-position definition avoids. Tenure reaches cohort *policy* through the accessor below, which a higher layer can use when choosing which cohort members to ask first or which way to expand. That is the doc's own "FRET exposes primitives, higher layers set policy" split.
- **Next-hop selection is not changed.** `linkQuality` stays the success rate. Leave a `NOTE:` at `linkQuality` saying tenure is available and when to fold it in: if routes are measured failing mid-path on short-lived hops.

### Public accessor

Add `getPeerTenure(peerId: string): number | undefined` to the `FretService` interface in `src/index.ts`. It returns the proven tenure in ms for a peer the table holds (0 if never proven) and `undefined` for one it does not. Implement it on the core, and add the pass-through on `Libp2pFretService`. `implements FretService` makes a missing pass-through a compile error. `test/libp2p-facade-forwarding.spec.ts` enumerates the member count: bump it and add the member to its table.

Do not add tenure to `listPeers` rows. One accessor is enough, and `listPeers` is a whole-table read.

## Edge cases & interactions

- **Burst of concurrent proofs for one peer** (several inbound RPCs at once): `noteProofOfLife` is synchronous, reading and writing with no await, so there is no lost update. Granularity coalesces the writes. *Inspection.*
- **Clock goes backwards** (`now < lastProvenAliveAt`): new session, never negative. *Unit test row.*
- **Gap exactly at the tolerance**: continues (≤). *Unit test row.*
- **Peer removed and re-added** (eviction, then rediscovery): the new entry starts at 0. Eviction dropping tenure is correct, because we chose to forget the peer. *Inspection.*
- **Dead peer revived**: `noteProofOfLife`'s revive arm and the tenure stamp go in the same write. A revive within tolerance continues the session. That is the whole point for the maintenance case. *Covered by the follow-on ticket's integration test; inspection here.*
- **Imported table, then a proof**: the gap is measured from the imported `lastProvenAliveAt`, so if we were off more than 15 min the session restarts. *Unit-level, via the `noteProven` rows (no separate test).*
- **Import of an older table lacking the fields**: they read as 0. *Covered by the codec property once the generator carries optional fields.*
- **Idle backoff**: a tenure-only write is not a change. Verify by reading the existing two-node idle strand case in `test/near-exchange.spec.ts`: it drives a ladder climb with pings landing every few passes, and it must stay green unchanged. That is the regression guard.
- **Store write cost**: `noteProofOfLife` used to skip the write for a settled peer. It now writes at most once per second per peer. `store.update` is O(log n) with the cached key. *Inspection.* Add no benchmark.
- **Sim harness** (`test/simulation/`): it uses its own scoring calls through `relevance.ts`, so its entries get factor 1 (tenure fields default 0) unless it sets them. Make sure its entry literals compile with the new fields (it may build `PeerEntry` literals directly; grep `avgLatencyMs:` under `test/simulation`). No behaviour change is expected there.

## Tests (keep to these)

- `test/tenure.spec.ts`: one table-driven case over `noteProven`. The rows: never proven → new session; gap within tolerance → continue; gap exactly at tolerance → continue; gap over tolerance → new session; advance under granularity → `undefined`; clock backwards → new session. Plus one case: `stabilityFactor` is 1 at 0, strictly increasing, and below `1 + STABILITY_MAX_BONUS`.
- Extend the `SerializedPeerEntry` generator in `test/rpc.codec-properties.spec.ts` with the two optional fields so the existing round-trip property covers them. That is not a new test.
- No service-level test for the stamp write. The follow-on ticket's integration test drives it end to end.

## TODO

- Create `src/store/tenure.ts` with the constants and the three pure functions.
- Add the two fields to `PeerEntry` (doc comments), `SerializedPeerEntry` (optional), `upsert` defaults, `exportEntries`, `importEntries`.
- Fix any `PeerEntry` literals elsewhere (tests, sim) that the new required fields break: `npx tsc --noEmit` lists them.
- Multiply `stabilityFactor` into the four scoring functions in `relevance.ts`.
- Fold the `noteProven` patch into `noteProofOfLife`'s write without making it a change; guard self.
- Add `getPeerTenure` to the interface, core and facade; update the facade-forwarding spec's table and count.
- Add a `NOTE:` at `linkQuality` (tenure available; fold in if short-lived hops are measured failing mid-route).
- Tests as listed.
- Docs (`docs/fret.md`):
  - Under *Relevance scoring and table management*, add a *Tenure* component bullet: what a session is, the 15-min tolerance, local-only/proof-only, the stability factor and its bounds, and the far-peer limit.
  - Add the factor to the formula block in *Relevance score calculation*.
  - Add the two fields to the *Serialized routing table* interface.
  - Add `getPeerTenure` and why cohort order is untouched (policy belongs to higher layers) near *Flexible cohort and thresholding*.
- Update the `AGENTS.md` layout (`store/{digitree-store,relevance,tenure}.ts`).
- `cd packages/fret && npx tsc --noEmit && yarn test`.
