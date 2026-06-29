description: Verify message `from` fields against transport-authenticated `connection.remotePeer` on all RPC handlers
dependencies: none — standalone; prerequisite for leave-authentication and per-peer-rate-limiting
files: src/rpc/neighbors.ts, src/rpc/maybe-act.ts, src/rpc/leave.ts, src/rpc/ping.ts, src/service/fret-service.ts, docs/fret.md, test/identity-verification.spec.ts (new)
----

### Overview

libp2p's Noise transport authenticates the remote peer at the connection level — `connection.remotePeer` is the cryptographically verified identity of the sender. All FRET RPC handlers currently destructure `IncomingStreamData` to just `stream`, discarding the `connection` object entirely. The `from` field in `NeighborSnapshotV1` and `LeaveNoticeV1` is trusted at face value. This enables impersonation, leave spoofing, snapshot forgery, and routing table poisoning.

The fix: every `node.handle()` callback accepts `(stream: Stream, connection: Connection)`. For messages with a `from` field, verify `from === connection.remotePeer.toString()` before processing. Mismatches are logged, counted, and dropped.

This closes threat-analysis.md §5.2 (Critical) and partially addresses §3.1 and §3.2.

### Handler-by-handler changes

#### `src/rpc/neighbors.ts` — `registerNeighbors`

Two handlers registered here:

1. **Neighbors request handler** (line ~23): Only sends our snapshot — no inbound `from` field. Update callback to `(stream: Stream, connection: Connection)` for consistency but no verification needed.

2. **Announce handler** (line ~34): Receives `NeighborSnapshotV1` with `from` field. After decoding `snap`, verify:
   ```
   if (snap.from !== connection.remotePeer.toString()) → log.warn, call onIdentityMismatch, close stream, return
   ```
   Only call `onAnnounce` if identity matches.

Add `onIdentityMismatch?: (claimed: string, actual: string) => void` as a new 6th parameter to `registerNeighbors`.

#### `src/rpc/leave.ts` — `registerLeave`

Receives `LeaveNoticeV1` with `from` field. After decoding `msg`, verify:
```
if (msg.from !== connection.remotePeer.toString()) → log.warn, call onIdentityMismatch, close stream, return
```
Only call `onLeave` if identity matches.

Add `onIdentityMismatch?: (claimed: string, actual: string) => void` as a new 4th parameter to `registerLeave`.

#### `src/rpc/maybe-act.ts` — `registerMaybeAct`

`RouteAndMaybeActV1` has no `from` field (it's a forwarded message; the originator is authenticated by signature, which is a separate ticket). However, the transport-authenticated sender identity is useful for diagnostics and future per-peer rate limiting.

- Update `node.handle()` callback to `(stream: Stream, connection: Connection)`
- Pass `connection.remotePeer.toString()` as a second argument to the `handle` callback
- Update `handle` callback type: `(msg: RouteAndMaybeActV1, remotePeer: string) => Promise<...>`

#### `src/rpc/ping.ts` — `registerPing`

Stateless request-response. No `from` field. Update `node.handle()` callback signature to `(stream: Stream, _connection: Connection)` for consistency. No verification needed.

#### `src/service/fret-service.ts`

- Add `identityMismatch: 0` to `diag.rejected` (line ~122)
- In `registerRpcHandlers()` (~line 296):
  - Pass identity mismatch callback to `registerNeighbors`: `() => { this.diag.rejected.identityMismatch++; }`
  - Pass identity mismatch callback to `registerLeave`: `() => { this.diag.rejected.identityMismatch++; }`
  - Update `handleMaybeAct` call to accept `remotePeer` parameter (unused initially, prefix with `_`)

#### `docs/fret.md`

In the "Not yet implemented" section, move "Verify `from` field against transport-authenticated `connection.remotePeer` on all RPC handlers" from the planned list to a new "Implemented" note or remove it from the planned list.

### Test plan (`test/identity-verification.spec.ts`)

Tests use `createMemoryNode()` from `test/helpers/libp2p.ts` to create real connected libp2p peers.

**Spoofed leave notice is dropped:**
- Node A and Node B connect
- Register leave handler on Node B with an `onLeave` spy and `onIdentityMismatch` spy
- Node A sends a `LeaveNoticeV1` with `from: <fake peer ID>` (not Node A's actual ID)
- Assert `onLeave` was NOT called
- Assert `onIdentityMismatch` WAS called with the fake ID and Node A's actual ID

**Valid leave notice is processed:**
- Node A sends `LeaveNoticeV1` with `from: nodeA.peerId.toString()`
- Assert `onLeave` WAS called

**Spoofed announce is dropped:**
- Node A sends a `NeighborSnapshotV1` via the announce protocol with `from: <fake peer ID>`
- Assert `onAnnounce` was NOT called
- Assert `onIdentityMismatch` WAS called

**Valid announce is processed:**
- Node A sends `NeighborSnapshotV1` with `from: nodeA.peerId.toString()`
- Assert `onAnnounce` WAS called

**MaybeAct handler receives remotePeer:**
- Node A sends a `RouteAndMaybeActV1` to Node B
- Assert the handle callback's second argument (`remotePeer`) equals `nodeA.peerId.toString()`

**Integration with FretService diag counter:**
- Create a FretService instance, connect a peer, send a spoofed leave
- Assert `service.diagnostics().rejected.identityMismatch > 0`

### TODO

Phase 1: RPC handler updates
- [ ] Update `src/rpc/leave.ts`: import `Connection`, accept `(stream, connection)`, verify `from`, add `onIdentityMismatch` parameter
- [ ] Update `src/rpc/neighbors.ts`: import `Connection`, accept `(stream, connection)` on both handlers, verify `from` in announce handler, add `onIdentityMismatch` parameter
- [ ] Update `src/rpc/maybe-act.ts`: import `Connection`, accept `(stream, connection)`, thread `remotePeer` to handle callback, update callback type
- [ ] Update `src/rpc/ping.ts`: import `Connection`, accept `(stream, _connection)` for consistency

Phase 2: Service integration
- [ ] Add `identityMismatch: 0` to `diag.rejected` in `src/service/fret-service.ts`
- [ ] Wire `onIdentityMismatch` callbacks in `registerRpcHandlers()` to increment the counter
- [ ] Update `handleMaybeAct` signature to accept `_remotePeer: string`

Phase 3: Tests
- [ ] Create `test/identity-verification.spec.ts` with spoofed and valid message tests per the test plan above
- [ ] Ensure all existing tests still pass (`yarn test`)
- [ ] Type-check passes (`cd packages/fret && npx tsc --noEmit`)

Phase 4: Documentation
- [ ] Update `docs/fret.md` "Not yet implemented" section — remove the `from` field verification bullet from planned items
