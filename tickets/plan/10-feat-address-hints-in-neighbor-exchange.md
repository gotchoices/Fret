description: FRET tells peers about each other by identity only, never by address, so a peer behind a NAT can be known to the whole ring while nobody except its relay can reach it, and a restarted node remembers who its neighbours were but not how to dial them. Carry signed, dialable address hints in the neighbour exchange and in the saved routing table. When this ships, it replaces the equivalent feature Sereus built one layer up.
files: packages/fret/src/index.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/validate.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/service/peer-discovery.ts, packages/fret/src/store/digitree-store.ts, docs/fret.md
----
# Signed address hints in the neighbour exchange and the saved table

## Decision (maintainer, 2026-09-28)

**Option 2 of the original proposal: carry signed address hints in the neighbour exchange.** Also carry the addresses in the exported routing table, so a restarted node can dial its neighbours before anyone tells it anything. When this ships it **replaces Sereus's downstream "strand peer book"** (see *The Sereus feature this replaces* below). The maintainer does not want the two layers duplicating each other.

Options 1 (emit only what the peerStore already holds) and 3 (flag members admitted without a dialable address) are out of scope here.

## Problem

FRET's wire format carries peer-id strings only (`NeighborSnapshotV1` successors, predecessors and sample; `NearAnchorV1`; `LeaveNoticeV1`; breadcrumbs). The table entry (`SerializedPeerEntry` in `store/digitree-store.ts`) has no address field either. FRET never writes to the libp2p peerStore, so every dial by peer id depends on addresses libp2p learned some other way. libp2p identify only exchanges addresses between directly connected peers, and there is no DHT.

Two failures follow:
- **Unreachable members** (gotchoices/Optimystic#11). A NAT-only peer that reaches the network through a circuit relay becomes a full ring member, but no third party ever learns its `/p2p-circuit` address. Membership looks healthy, and every sibling-initiated dial fails with `NoValidAddressesError`.
- **Restart** (gotchoices/sereus#18). Optimystic's db-p2p saves and restores the FRET table (`exportTable` / `importTable`, `NodeOptions.persistence`), but that table holds no addresses. Two relay-only parties that restart re-import each other's ids, cannot dial them, and each ring contains only itself. The strand reports active, and nothing replicates.

Related work already landed elsewhere, both live-only and neither surviving a restart:
- this repo's `unguarded-bare-peerid-dials-fail-on-addressless-peers`: stop dialling peers known to be addressless;
- Optimystic's `relay-only-cohort-member-addresses-never-reach-siblings`: addresses carried in cluster records.

## What to build

1. **Signed address hints on the wire.**
   - Extend `NeighborSnapshotV1` so the snapshot's sender, and each successor, predecessor and sample peer it names, can carry a libp2p **signed peer record**: the existing replay-protected envelope (`RecordEnvelope` over `PeerRecord`, with a sequence number). Do not invent a signature scheme.
   - Receivers verify each envelope, drop any that fail or whose signer is not the peer id it describes, and pass the rest to `peerStore.consumePeerRecord`. Dials by peer id then work natively, for FRET and for everything above it.
   - A peer's own record is signed by itself. A forwarded record is still that peer's own signed record, so forwarding grants no authority.
   - The dialled peer still authenticates by peer id at the handshake, so a bad hint wastes a dial but cannot impersonate anyone.
   - This is a wire-format change: version it (`v: 2` or an optional field that v1 readers ignore) and document it in `docs/fret.md`.
2. **Addresses in the saved table.**
   - Add the peer's latest verified signed record, or its multiaddrs plus when they were last confirmed, to `SerializedPeerEntry`.
   - `importTable` consumes the records into the peerStore, so the first dials after a restart have addresses.
   - Keep the rule that a corrupt table is refused as a whole.
3. **Relay circuit addresses must survive.** For a relay-only peer the useful address is `/p2p-circuit` through its relay. Make sure the record a node signs, and the hints it forwards, include its circuit addresses once its reservation lands, and that nothing filters them out as non-public.

## Protections to build in from the start

These are lessons from Sereus's review of its own version (`sereus/tickets/backlog/debt-strand-peer-book-remote-write-bounds.md`):
- **A forwarded hint must never push out a peer this node has connected to itself.** When capacity forces eviction, rank peers this node has met above peers it only heard about, then by freshness. Otherwise a sender with throwaway keys can fill a node's view with fakes and evict every real peer.
- **Bound inbound rate per sender:** at most one full snapshot per sender per window. The exception is a fresher record by the sender about itself, which covers an honest address change.
- **Bound clock skew** on anything time-stamped, and prefer the envelope's sequence number over wall-clock time where possible.
- **Age out stale addresses.** A failed relayed dial costs up to 14 s at Sereus's declared 3 s link round trip, so dead addresses slow every restart. Sereus uses 14 days, capped at 16 peers per strand. FRET should choose its own limits and state them.
- **Cap message size.** Signed records add bytes to every snapshot; keep a frame limit (Sereus uses 64 KiB).

## Tests to plan for

- Two nodes behind a relay only: after one neighbour exchange through a third node, each can dial the other by peer id, with no identify between them.
- **Restart:** export, stop, import, then a dial by peer id succeeds with no network exchange first.
- A tampered envelope, or one whose signer is not the peer it describes, is dropped and never reaches the peerStore.
- Eviction under pressure: 16 forwarded hints with future timestamps do not evict a peer this node is connected to.
- A v1 snapshot from an older peer still parses.

## The Sereus feature this replaces

Sereus 1.7 (unreleased as of 2026-09-28) added a **strand peer book** to fix gotchoices/sereus#18:
- `packages/cadre-core/src/strand-peer-book.ts`: a local, persisted list, per strand, of peer id → last-known multiaddrs and last-seen time, dialled first when a strand attaches;
- `strand-peer-book-swap.ts` and `strand-peer-book-protocol.ts`: a signed swap of those lists between strand members on connect, over `/sereus/strand-peers/1.0.0`.

Once this ticket ships in a FRET release and Optimystic picks it up, **Sereus should remove the swap and the local book**, and instead:
- pass `NodeOptions.persistence` to db-p2p for each strand node, so the FRET table with its addresses survives a restart;
- rely on FRET's signed hints for addresses learned from other peers.

Sereus's "remember the strands we joined" feature (`joined-strand-store`) is separate and stays. File the Sereus removal as a Sereus ticket when this is released, and tell the Sereus maintainer. Until then, the Sereus peer book stays in place, because it is what fixes #18 in shipped releases.

Downstream order: FRET release → Optimystic raises its FRET floor (and wires `persistence` for its own nodes if it doesn't already) → Sereus removes the peer book.
