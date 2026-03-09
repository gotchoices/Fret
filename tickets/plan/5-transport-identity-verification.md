description: Verify message `from` fields against the transport-authenticated peer identity
dependencies: none — standalone; prerequisite for all other trust mechanisms
files: src/rpc/neighbors.ts, src/rpc/maybe-act.ts, src/rpc/leave.ts, src/rpc/ping.ts, src/rpc/protocols.ts, src/service/fret-service.ts
----

### Problem

All FRET RPC handlers destructure `IncomingStreamData` to just `{ stream }`, discarding the `connection` object entirely. The `from` field in every message type (`NeighborSnapshotV1`, `RouteAndMaybeActV1`, `LeaveNoticeV1`) is trusted at face value. A grep for `remotePeer` across `src/` returns zero matches.

libp2p's Noise transport authenticates the remote peer at the connection level — `connection.remotePeer` is the cryptographically verified identity of the sender. By not checking `from` against this value, any connected peer can impersonate any other peer in any message.

This single gap enables impersonation, leave spoofing, snapshot forgery, and routing table poisoning for all direct connections. It also undermines Right-is-Right's dispute escalation, since dispute messages routed through FRET inherit the same forgery risk.

### Expected behavior

Every RPC handler accepts the full `IncomingStreamData` (or at minimum `{ stream, connection }`). Before processing any message, the handler verifies that the message's sender field matches `connection.remotePeer.toString()`. Messages that fail this check are dropped and the sender's reputation is penalized.

### Threat references

- threat-analysis.md §5.2 (Critical): No `from` field verification against transport identity
- threat-analysis.md §3.1 (Critical): Message forgery — unsigned messages (partially addressed)
- threat-analysis.md §3.2 (Critical): Leave notice spoofing (partially addressed)
- threat-rir-mitigated.md §5.2: Unchanged by RiR — FRET transport layer
