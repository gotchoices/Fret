description: Each node now tags every peer it knows about as belonging to its own network, a different network, or not-yet-determined. This adds the label and the logic that fills it in; nothing reads the label for routing yet — that is the follow-on gating change.
prereq:
files:
  - packages/fret/src/store/digitree-store.ts (MembershipState type, PeerEntry.membership, setMembership, upsert preserves it, serialize/import)
  - packages/fret/src/index.ts (exports MembershipState)
  - packages/fret/src/rpc/protocols.ts (isUnsupportedProtocolError helper)
  - packages/fret/src/service/fret-service.ts (member/foreign transitions, probe pass, identify listeners, self seed)
  - packages/fret/test/ring-membership.spec.ts (NEW — unit + in-memory reproduction)
  - packages/fret/test/relevance.properties.spec.ts (added membership to a PeerEntry literal)
  - docs/fret.md (new "Ring membership" section; SerializedPeerEntry + persistence notes)
difficulty: medium
----

# Review: classify each known peer as same-network / foreign / unknown

## What this implements

A node's routing table (`DigitreeStore`) is populated by **network-agnostic** libp2p
signals (peerStore, `peer:connect`, bootstraps, neighbor snapshots), so it can admit a
peer that shares the transport but belongs to a *different* control network and never
serves this network's namespaced FRET protocols (`/optimystic/${networkName}/fret/1.0.0/*`).
This change labels each entry with a tri-state so the follow-on gating change can exclude
non-members from the ring.

```ts
export type MembershipState =
  | 'unknown'   // freshly discovered, not yet classified (default on insert)
  | 'member'    // confirmed to serve this network's FRET protocol
  | 'foreign'   // confirmed NOT to serve it (another network)
```

**Behaviour is unchanged after this ticket** — labels exist, but no read path consumes
them for exclusion. The store stays network-agnostic (stores/exposes the field, never
branches on it).

### How labels are resolved (all implemented)

- **Self → `member`** at the self-upsert site in `seedFromPeerStore`.
- **Successful namespaced RPC → `member`**, folded into `applySuccess` (the single point
  every ping/maybeAct success flows through). Normal traffic confirms members for free.
- **`UnsupportedProtocolError` → `foreign`** via the new `isUnsupportedProtocolError`
  helper, applied in `probeNeighborsLatency`'s catch, `probeMembership`'s catch, and
  `routeAct`'s forward catch. A **timeout / transient** error does NOT demote — the peer
  stays `unknown` for a later retry (this distinction is the crux of the tri-state).
- **Classification probe pass** (`classifyUnknownPeers`, called from `stabilizeOnce`):
  iterates `unknown` peers directly from the store (not ring views, which the gating
  ticket would filter), prefers connected/has-addresses, pings ≤ N (8 core / 4 edge) per
  tick over the namespaced ping, classifies by result, respects per-peer backoff, and is a
  no-op once no unknowns remain (no steady-state traffic). Without this pass an `unknown`
  same-network peer would be starved once gating excludes unknowns from the ring.
- **identify path** (`peer:identify` / `peer:update` listeners + opportunistic
  `classifyFromPeerStore` in `seedFromPeerStore`): when libp2p has negotiated a peer's
  protocols, classify off that list (contains one of ours → member; non-empty but none →
  foreign; empty → stay unknown). Also delivers re-admission (`foreign → member`).
- **Durability:** `upsert` now **preserves** an existing entry's membership across the
  network-agnostic re-seeds (it otherwise rebuilds the entry from defaults every tick).
- **Persistence:** `membership` round-trips through `exportTable`/`importTable`; a missing
  field in an older snapshot defaults to `'unknown'`.

## How to validate

Build first (TDD floor is `test/ring-membership.spec.ts`):

```
cd packages/fret
npx tsc --noEmit
yarn build
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/ring-membership.spec.ts" --timeout 30000
```

All green at handoff: **type-check 0 errors, build 0 errors, 11/11 in the new spec, full
suite 243 passing** (`yarn test`).

### Use cases the spec covers
- `isUnsupportedProtocolError`: matches by `name` (modern libp2p), `code`
  (legacy `ERR_UNSUPPORTED_PROTOCOL`), and message substring; **rejects** timeout/transient
  errors and non-errors (the guard that keeps a slow same-network peer from being demoted).
- Store: default `unknown`; `setMembership` both directions; **preserved across re-upsert**;
  export/import round-trip; missing-field back-compat → `unknown`.
- Integration (real in-memory libp2p, shared transport): A & C on `net-a`, B on `net-b`,
  all connected through A. After stabilization, from A's store: C → `member`, B → `foreign`,
  self → `member`. Plus single-node dev: self → `member`, no peers.

## Known gaps / where to look (treat tests as a floor)

- **`fetchNeighbors` success is NOT used as a member signal** (the ticket listed it as an
  option). `fetchNeighbors` swallows errors and returns an *empty* snapshot on both
  success-with-no-neighbors and failure, so it can't cleanly distinguish member from
  foreign without changing its contract. It's also redundant in practice: `stabilizeOnce`
  pings the same `near` set via `probeNeighborsLatency` immediately before merging
  snapshots, so those peers are already classified. Decision: rely on ping + maybeAct +
  the probe pass rather than weaken `fetchNeighbors`. Reviewer: confirm this is acceptable,
  or push the member signal into `fetchNeighbors` via a discriminated result.
- **identify path is untested in CI.** The memory test nodes have no identify service, so
  the `peer:identify`/`peer:update` listeners and `classifyFromPeerStore` are exercised by
  *no* test — they're written defensively against libp2p's `IdentifyResult` / `PeerUpdate`
  shapes but unverified end-to-end. The full suite re-ran clean through the main edits; the
  *final* refinement only touched these production-only handlers (conditional-upsert) and so
  changes no covered path. **Highest-value reviewer addition: a TCP-node integration test
  with the identify service enabled** asserting `foreign`/`member` via the peerStore path,
  and the `foreign → member` re-admission on `peer:update`.
- **Inbound-RPC promotion is out of scope.** Promoting on an inbound FRET RPC is tempting
  (the peer dialed our namespaced protocol) but `from` is self-asserted and handlers don't
  receive the authenticated `connection.remotePeer`. Deferred to the planned message-auth
  work; outbound probe + success paths are authoritative.
- **A "busy" ping reply leaves a member `unknown`.** `sendPing` collapses a busy response to
  `{ok:false}`, so `probeMembership` treats it as ambiguous (backoff, stay unknown) even
  though a busy reply actually *proves* the peer served our protocol. Conservative, not
  wrong — the peer is re-probed once it's not busy. Worth a glance if classification latency
  ever matters under load.
- **Observation (pre-existing, out of scope): `upsert` resets relevance/health every tick.**
  While adding membership-preservation I noticed `upsert` otherwise rebuilds an entry from
  defaults, and `seedFromPeerStore` upserts every peerStore peer on every stabilization tick
  — so relevance/access/health counters for those peers are effectively reset ~1×/tick. This
  predates this ticket and is orthogonal to membership (which I now preserve). Flagging so the
  reviewer can decide whether to file a `backlog/debt-` ticket; I did not change it here.

## Follow-on

`ring-membership-gating` (already planned) reads `membership` to scope ring/cohort/estimate
to members via a **caller-supplied predicate** (keeping the store and the simulator, which
build `DigitreeStore` directly and never set membership, unaffected). The new spec is the
place to extend with ring/cohort/estimate-exclusion assertions.
