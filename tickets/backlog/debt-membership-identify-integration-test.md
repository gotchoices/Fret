----
description: The code that classifies peers as same-network or foreign by reading libp2p's "identify" handshake data has no automated test, because the in-memory test nodes don't run identify. Add a test using real networking nodes that do.
prereq:
files:
  - packages/fret/src/service/fret-service.ts (peer:identify / peer:update listeners ~lines 339-360; classifyByProtocols; classifyFromPeerStore ~lines 270-295; seedFromPeerStore opportunistic classify ~line 789)
  - packages/fret/test/ring-membership.spec.ts (existing probe-based coverage; extend or add a sibling spec)
  - packages/fret/test/helpers/libp2p.ts (createMemNode — memory transport, no identify; a TCP+identify factory is needed)
difficulty: medium
----

# Integration-test the identify-driven membership classification path

## What's missing

Ring membership (`ring-membership-classification`) resolves same-network vs foreign
peers through two paths:

1. **Probe path** — a namespaced ping; success → member, `UnsupportedProtocolError`
   → foreign. **Covered** by `test/ring-membership.spec.ts` (in-memory nodes).
2. **identify path** — when libp2p's `identify` protocol has exchanged a peer's
   negotiated-protocol list, the `peer:identify` / `peer:update` listeners and the
   opportunistic `classifyFromPeerStore` in `seedFromPeerStore` classify off that list
   (contains one of ours → member; non-empty but none → foreign; empty → unknown).
   This path also delivers **re-admission** (`foreign → member`) when a peer later
   starts serving this network and re-identifies. **Not covered by any test.**

The in-memory test node factory (`createMemNode`) has no identify service, so the
peerStore protocol list never populates and these listeners never fire under CI. The
handlers are written defensively against libp2p's `IdentifyResult` / `PeerUpdate`
shapes but are unverified end-to-end.

## What to add

- A TCP-transport node factory with the identify service enabled (sibling to
  `createMemNode` in `test/helpers/libp2p.ts`).
- An integration test asserting, via the peerStore/identify path (no outbound probe):
  - a same-network peer is labeled `member`,
  - a foreign-network peer (different `networkName`) is labeled `foreign`,
  - `foreign → member` re-admission fires on `peer:update` when a node that was foreign
    begins serving this network's protocol.

## Why debt, not bug

The path is exercised in real deployments (where identify runs) and the handlers are
defensively coded; the gap is **test coverage**, not a known defect. Behaviour is also
inert today — no read path consumes `membership` for exclusion until the
`network-scoped-ring-admission` gating work lands, which is the point where a
classification mistake would actually change routing. Worth closing before then.
