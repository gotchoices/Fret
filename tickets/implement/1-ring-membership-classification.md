description: A node should be able to tell, for each peer it knows about, whether that peer actually belongs to its own network or to a different network sharing the same machines. This ticket adds that per-peer label and the logic that fills it in; it does not yet change any routing behavior.
prereq:
files:
  - packages/fret/src/store/digitree-store.ts (PeerEntry: add membership field + setMembership; serialize/import)
  - packages/fret/src/index.ts (export MembershipState type; SerializedPeerEntry membership)
  - packages/fret/src/service/fret-service.ts (membership transitions: probe pass, RPC-failure demotion, identify/peerStore promotion, seed self as member)
  - packages/fret/src/rpc/protocols.ts (isUnsupportedProtocolError helper)
  - packages/fret/src/rpc/ping.ts (sendPing already uses the namespaced protocol — the probe vehicle)
  - packages/fret/test/ring-membership.spec.ts (NEW — FRET-local reproduction asserting classification)
  - packages/fret/test/helpers/libp2p.ts (existing memory-node factory is sufficient; no identify needed for probe-based classification)
  - docs/fret.md (Discovery / Ring membership — note the membership states; full prose lands in the gating ticket)
difficulty: medium
----

# Classify each known peer as same-network / foreign / unknown

## Background — read this first

FRET already namespaces every wire RPC by network: the protocol strings are
`/optimystic/${networkName}/fret/1.0.0/{neighbors,maybeAct,leave,ping,...}`
(`rpc/protocols.ts`, built per-service in `makeProtocols` and stored as `this.protocols`
in `fret-service.ts:153`). Two FRET services with different `networkName`s therefore cannot
negotiate each other's FRET protocols.

**But the routing table (`DigitreeStore`) is populated network-agnostically.** Peers enter the
store from libp2p-level signals that know nothing about `networkName`:

- `seedFromPeerStore()` (`fret-service.ts:704`) — upserts *every* peer in the libp2p peerStore;
  runs at start and on every stabilization tick (`fret-service.ts:739`).
- the `peer:connect` handler (`fret-service.ts:260`) — upserts *any* connecting peer.
- `seedFromBootstraps()` (`fret-service.ts:757`) — upserts configured bootstrap ids.
- `mergeAnnounceSnapshot` (`fret-service.ts:659`) / `mergeNeighborSnapshots` (`fret-service.ts:821`)
  — upsert `from`, successors, predecessors, and sample entries received from neighbors.
- maybeAct `cohort_hint` upserts (`fret-service.ts:1366`), and `importTable`.

In an Optimystic deployment a single libp2p node hosts repos for **multiple control networks** over
**one shared transport**, so a peer that participates only in `control-B` is, at the libp2p level, a
fully-connected peer of a `control-A` node. `control-A`'s FRET admits it, but it never serves
`control-A`'s namespaced protocols. Downstream, Optimystic selects it as a co-coordinator and the
write fails with `could not negotiate /optimystic/control-<other>/repo/1.0.0`.

This ticket does **not** change routing yet. It only **labels** each peer so the follow-on gating
ticket (`ring-membership-gating`) can exclude non-members from the ring. Splitting this way keeps the
tree behavior-identical after this ticket lands (labels exist, nothing reads them for exclusion yet),
which is safe to ship independently and gives the gating ticket a tested signal to build on.

## The membership signal

The robust, deployment-independent question is: **does this peer serve *this* network's namespaced
FRET protocol?** We capture the answer as a tri-state on each peer entry:

```ts
export type MembershipState =
  | 'unknown'   // not yet classified — freshly discovered; default on insert
  | 'member'    // confirmed to serve this network's FRET protocol
  | 'foreign'   // confirmed NOT to serve it (belongs to another network)
```

Why tri-state and not a boolean: the crux named in the source ticket is distinguishing a
*freshly-discovered same-network peer whose `identify` hasn't completed* (legitimately `unknown`, must
not be starved) from a *confirmed-foreign* peer. A boolean collapses those.

### Signals that resolve `unknown`

Definitive, works in every deployment (no `identify` required):

- **Successful outbound namespaced RPC → `member`.** A ping/neighbors/maybeAct that completes over
  `this.protocols.*` proves the peer serves this network. The cheap dedicated vehicle is
  `sendPing(node, id, this.protocols.PROTOCOL_PING)` (`rpc/ping.ts:55`) — it already rides the
  namespaced ping protocol. Promote on any successful namespaced RPC (fold into the existing success
  paths: `applySuccess`, `probeNeighborsLatency`, and successful `fetchNeighbors`/`sendMaybeAct`), so
  normal traffic confirms members for free.
- **Outbound namespaced RPC fails protocol negotiation → `foreign`.** libp2p throws an
  `UnsupportedProtocolError` (name/code `ERR_UNSUPPORTED_PROTOCOL`, message mentions protocol
  selection) from `dialProtocol`/`newStream` when the remote doesn't support the protocol. This must
  be distinguished from a generic timeout / transient network failure — a timeout leaves the peer
  `unknown` (retry later), only an explicit unsupported-protocol error demotes to `foreign`. Add
  `isUnsupportedProtocolError(err): boolean` to `rpc/protocols.ts` (match by `err.name` /
  `err.code`, with a message-substring fallback) and use it wherever a namespaced RPC can throw.

Accelerator, only when `identify` has run (the common production case; not present in the test memory
nodes):

- **peerStore protocols.** Once `identify` completes, `peerStore.get(peerId).protocols` lists the
  peer's negotiated protocols. If it includes any `this.protocols.*` → `member`; if the list is
  **non-empty** and includes none of them → `foreign`; if **empty** → leave `unknown`. Evaluate this
  on the libp2p `peer:identify` and `peer:update` events (add listeners via `addNodeListener`) and
  opportunistically in `seedFromPeerStore` when `peerStore.get` is available. This also delivers
  **churn / re-admission**: a peer that later starts serving this network re-identifies, fires
  `peer:update`, and is re-evaluated `foreign → member`.

### The classification probe pass (the linchpin)

A peer stays `unknown` until something resolves it. Normal traffic only touches peers the ring
already selects — but the gating ticket will *exclude* `unknown` peers from the ring, so without a
dedicated pass an `unknown` same-network peer would never be selected, never probed, and be
**permanently starved**. Therefore add a bounded pass to the stabilization tick
(`stabilizeOnce`, `fret-service.ts:786`) that iterates `unknown` peers directly from the store
(*not* through ring views), prefers connected / has-addresses ones, sends a namespaced ping to at most
N per tick (N = 8 core / 4 edge, matching existing probe budgets), and promotes/demotes by result.
Bound it with the existing token buckets / backoff so it can't hammer an unreachable-but-connected
peer; a ping that times out (not unsupported-protocol) leaves the peer `unknown` for a later tick.

This pass runs only while unknowns exist; in single-network steady state every peer becomes `member`
and the unknown set empties, so there is **no steady-state extra traffic**.

### Self

Self is always `member`. Set it where self is seeded (`seedFromPeerStore` self upsert,
`fret-service.ts:719`).

## Data structure changes

`PeerEntry` (`digitree-store.ts:6`) gains `membership: MembershipState`. `upsert` defaults it to
`'unknown'`. Add `setMembership(id, state)` (thin wrapper over `update`, mirroring `setState`).
The store stays **network-agnostic**: it only stores and exposes the field; it never branches on it
(the gating ticket will read it via a caller-supplied predicate, not inside the store). Add
`membership` to `SerializedPeerEntry` and the export/import paths (`digitree-store.ts:206`/`221`);
preserve it on import (a persisted table is same-network by construction), defaulting a missing field
to `'unknown'` for back-compat with older snapshots.

Export `MembershipState` from `index.ts` alongside `PeerState`.

## Edge cases & interactions

- **Fresh same-network peer (`identify` pending, no traffic yet).** Stays `unknown`, gets picked up
  by the probe pass within ~1 tick (1.5s passive / 300ms active) and promoted. Must never be demoted
  to `foreign` on a *timeout* — only on an explicit unsupported-protocol error or a non-empty
  identify list lacking this network.
- **Shared-transport foreign peer.** Connection stays open (shared transport), so a namespaced ping
  returns `UnsupportedProtocolError` immediately (no timeout) → fast, cheap `foreign`. Do **not**
  evict it from the store — it would be re-added by the next `peer:connect`/peerStore seed and
  re-probed in a loop. Tag and retain; the gating ticket makes capacity-eviction prefer it (relevance
  0, unprotected).
- **`from` spoofing on inbound RPCs.** Promotion on an *inbound* FRET RPC is tempting (the peer dialed
  our namespaced protocol) but the `from` field is self-asserted and the handlers don't currently
  receive the transport-authenticated `connection.remotePeer`. Keep inbound promotion **out of scope
  here** (or strictly gated on an authenticated remote peer if trivially available); the outbound
  probe + success paths are authoritative and sufficient. Note the dependency on the planned
  message-authentication work rather than threading `from` trust in here.
- **Re-admission after a peer joins this network later.** `foreign` must be reversible: the
  `peer:update`/`peer:identify` re-evaluation and a later successful namespaced RPC both promote
  `foreign → member`. No state is permanent.
- **Relayed / limited connections.** Classification rides `sendPing`/`openRpcStream`, which already
  handle limited (circuit-relay) connections (`openRpcStream`, `protocols.ts:119`). No special-casing.
- **Single-node / zero-peer dev.** Only self in the store → self is `member`, unknown set empty,
  probe pass is a no-op.
- **Test memory nodes have no `identify` service.** peerStore protocols never populate there, so the
  reproduction must rely on the probe path (and it does — the probe is deployment-independent).
- **Simulator / direct store users.** The Optimystic simulator builds a `DigitreeStore` directly and
  never sets membership; entries default `'unknown'`. This ticket changes no read path, so the
  simulator is unaffected. (The gating ticket keeps it unaffected by making the member-filter
  opt-in.)

## Reproduction (build first, TDD)

`test/ring-membership.spec.ts` — two `FretService` instances over real (memory-transport) libp2p
nodes sharing a connection, one with `networkName: 'net-a'`, one with `networkName: 'net-b'`, plus a
third same-network (`net-a`) peer:

- After connect + a few stabilization ticks, assert from `net-a`'s service:
  `getStore().getById(<net-b id>)?.membership === 'foreign'` and
  `getStore().getById(<net-a peer id>)?.membership === 'member'`.
- Assert self is `member`.
- Assert a peer that is connected but never reachable on the namespaced protocol due to *timeout*
  (simulate by not registering handlers / closing) is **not** wrongly marked `foreign` — only the
  unsupported-protocol path demotes. (If hard to simulate a clean timeout in-memory, cover the
  unsupported-protocol → `foreign` and the success → `member` transitions, and unit-test
  `isUnsupportedProtocolError` directly.)

The gating ticket extends this same spec to assert ring/cohort/estimate exclusion.

## TODO

### Phase 1 — data structure & types
- Add `MembershipState` type and `PeerEntry.membership` (`digitree-store.ts`); default `'unknown'` in
  `upsert`; add `setMembership`.
- Add `membership` to `SerializedPeerEntry` + export/import (preserve; default `'unknown'`).
- Export `MembershipState` from `index.ts`.

### Phase 2 — classification signals
- Add `isUnsupportedProtocolError` to `rpc/protocols.ts`.
- Promote `→ member` on successful namespaced RPC (success paths in `applySuccess`/
  `probeNeighborsLatency`/`fetchNeighbors`/`sendMaybeAct`); demote `→ foreign` on
  `isUnsupportedProtocolError`.
- Add `peer:identify` / `peer:update` listeners that read `peerStore` protocols and classify; do the
  same opportunistically in `seedFromPeerStore`. Mark self `member` at the self-upsert site.

### Phase 3 — classification probe pass
- In `stabilizeOnce`, add a bounded pass over `unknown` store entries (prefer connected/has-addresses),
  ping ≤ N (8 core / 4 edge) on the namespaced protocol, classify by result, respect token
  buckets/backoff; timeout leaves `unknown`.

### Phase 4 — test & docs
- Build `test/ring-membership.spec.ts` (above).
- `docs/fret.md` Discovery / Ring-membership: note the three membership states and how they are
  resolved (full ring-scoping prose lands in the gating ticket).
- Run `npx tsc --noEmit`, `yarn build`, and the new spec (`node --import ./register.mjs
  node_modules/mocha/bin/mocha.js "test/ring-membership.spec.ts" --timeout 30000`); stream output.
