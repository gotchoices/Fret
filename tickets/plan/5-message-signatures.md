description: Implement cryptographic signatures on all FRET protocol messages
dependencies: 5-transport-identity-verification (can be developed in parallel but provides defense-in-depth together)
files: src/rpc/protocols.ts, src/rpc/neighbors.ts, src/rpc/maybe-act.ts, src/rpc/leave.ts, src/service/fret-service.ts, docs/fret.md
----

### Problem

The design doc specifies "All messages signed with sender's private key" and the wire formats include `sig`/`signature` fields, but no signatures are ever generated or verified:

- `NeighborSnapshotV1.sig` is always `''` (fret-service.ts ~line 814)
- `RouteAndMaybeActV1.signature` is always `''` (fret-service.ts ~line 1257)
- `LeaveNoticeV1` has no signature field at all

Without signatures, any peer on the network can craft messages with arbitrary content. Transport identity verification (§5.2 ticket) covers direct connections, but signatures are needed for messages that are **forwarded** — a forwarding node can modify the message content between hops.

This is the design doc's single most significant unimplemented security requirement.

### Expected behavior

All outbound FRET messages are signed using the local peer's libp2p private key over canonical JSON (or a defined canonical byte representation). All inbound messages have their signature verified against the claimed sender's public key before processing. Invalid signatures are dropped and the connection peer is penalized.

`LeaveNoticeV1` gains a `sig` field matching the other message types.

The signing scheme should use libp2p's existing key infrastructure (`peerId.privateKey` / `peerId.publicKey`) with a standard algorithm (Ed25519 or the key type's native signing).

### Threat references

- threat-analysis.md §5.1 (Critical): Complete absence of message signatures
- threat-analysis.md §3.1 (Critical): Message forgery — enables nearly every other attack
- threat-rir-mitigated.md §5.1: Narrowly improved by RiR (client tx signatures only); FRET messages unchanged
