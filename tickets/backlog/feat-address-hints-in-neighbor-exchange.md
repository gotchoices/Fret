----
description: FRET tells peers about each other by identity only, never by address — so a peer behind a NAT can be known to the whole ring while nobody except its relay can actually reach it. Carry dialable address hints in the neighbor exchange.
files: packages/fret/src/index.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/service/peer-discovery.ts, packages/fret/src/store/digitree-store.ts, packages/fret/src/rpc/neighbors.ts
tradeoffs: Real security surface (unsigned address hints are an eclipse/traffic-redirection vector, so hints must be self-signed peer records, which grows message size and adds verification cost) and partial duplication of libp2p identify — a maintainer may prefer fixing propagation one layer up (in the embedder, e.g. Optimystic's cluster records) and leaving FRET address-free by design.
----
Filed from the investigation of gotchoices/Optimystic#11: a NAT-only peer that reaches the network through a circuit relay is admitted as a full ring member, but no third party ever learns its `/p2p-circuit` address — libp2p identify only exchanges addresses between directly connected peers, and FRET's own wire format has no address fields at all. Result observed on real devices: healthy-looking membership, and every sibling-initiated dial failing with `NoValidAddressesError`.

Current state (all address-free by design):

- Wire types carry bare peer-id strings only: `NeighborSnapshotV1` (`src/index.ts:14-25` — successors/predecessors/sample), `NearAnchorV1`, `LeaveNoticeV1`, breadcrumbs.
- The store entry has no address field (`store/digitree-store.ts:23-35`).
- FRET never writes to the libp2p peerStore (zero `peerStore.merge/patch/save` in the repo); its only peerStore use is a read in `seedFromPeerStore` that ignores `p.addresses`.
- Discovery events are emitted with empty address lists: `{ id, multiaddrs: [] }` at `fret-service.ts:1176`, `peer-discovery.ts:81`, `discovery.ts:13` — an autodialer consuming these can only fail.
  - **Update (planning of `consolidate-discovery-emission`):** those three sites collapse to one. `discovery.ts` is deleted and `fret-service.ts`'s `emitDiscovered` is removed; `peer-discovery.ts` `scan` becomes the only emission site, so option 1 below is a one-site change rather than three. That plan also decided *against* doing option 1 on its own: the only addresses available locally are the ones libp2p's peerStore already holds, and libp2p's `#onDiscoveryPeer` merges whatever a discovery source reports straight back into that same peerStore — so emitting them is a no-op for libp2p itself and only helps an application that listens on `peer:discovery` instead of reading the peerStore. The real value is options 2/3 here (addresses FRET learns from *other* peers), which is why this ticket stays open.
- Membership is granted on the first successful ping over an *inbound* connection (`applySuccess` sets `membership: 'member'`, `fret-service.ts:238-252`) with no requirement that a return path exist.

Proposed capability, in increasing order of ambition (a plan pass should pick the cut line):

1. **Emit what we already know**: when emitting `peer:discovery` or classifying a connected peer, include the addresses libp2p already holds for it instead of `[]`.
2. **Carry signed address hints in the neighbor exchange**: extend `NeighborSnapshotV1` (and/or the sample entries) so each referenced peer can carry a libp2p *signed peer record* (the existing, replay-protected envelope format — do not invent a new signature scheme). Receivers verify and `peerStore.consumePeerRecord` them, which makes later dials by peer id work natively.
3. **Return-path awareness at admission**: a peer whose only known path is an inbound connection could be flagged (not rejected — rejecting shrinks cohorts) so embedders can surface "member admitted without a dialable address" instead of failing silently at consensus time.

A NAT'd peer already knows its own circuit address (it is in `getMultiaddrs()` once the reservation lands), so the information exists at the moment it announces; it just is not carried.

Security note: unsigned hints must not be trusted — an attacker could redirect traffic for a victim peer id. libp2p's signed-peer-record envelope exists for exactly this; hints that fail verification are dropped. The dialed peer also still authenticates by peer id at the handshake, so a bad hint wastes a dial but cannot impersonate.

Related: Optimystic repo `fix/relay-only-cohort-member-addresses-never-reach-siblings` (embedder-level fix consuming addresses already carried in cluster records — lands independently and sooner); this repo `fix/unguarded-bare-peerid-dials-fail-on-addressless-peers` (stop dialing peers known to be addressless).
