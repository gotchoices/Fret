import type { Libp2p } from 'libp2p';
import {
	PROTOCOL_NEIGHBORS,
	PROTOCOL_NEIGHBORS_ANNOUNCE,
	encodeJson,
	decodeJson,
	readFramed,
	sendFramed,
	registerRpcHandler,
} from './protocols.js';
import { rpcRequest } from './request.js';
import type { RpcOutcome } from './outcome.js';
import type { NeighborSnapshotV1, BusyResponseV1 } from '../index.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:neighbors');

export async function registerNeighbors(
	node: Libp2p,
	getSnapshot: () => NeighborSnapshotV1 | BusyResponseV1 | Promise<NeighborSnapshotV1 | BusyResponseV1>,
	onAnnounce?: (from: string, snapshot: NeighborSnapshotV1) => void,
	protocols = { PROTOCOL_NEIGHBORS, PROTOCOL_NEIGHBORS_ANNOUNCE },
	maxBytes = 128 * 1024,
	onIdentityMismatch?: (claimed: string, actual: string) => void,
	onInbound?: (from: string) => void
): Promise<void> {
	// The request carries no inbound `from`, but the connection's remote peer is
	// transport-authenticated — and reaching this handler at all means the remote dialed
	// *this network's* namespaced protocol. `onInbound` hands that proof to the caller.
	// Errors and stream release belong to `registerRpcHandler`, not these bodies — including the
	// close, which the seam performs under its own budget so a remote that stops reading cannot
	// hold the handler open.
	await registerRpcHandler(node, protocols.PROTOCOL_NEIGHBORS, async (stream, connection) => {
		onInbound?.(connection.remotePeer.toString());
		const snap = await getSnapshot();
		sendFramed(stream, await encodeJson(snap));
	});

	if (onAnnounce) {
		await registerRpcHandler(node, protocols.PROTOCOL_NEIGHBORS_ANNOUNCE, async (stream, connection) => {
			const bytes = await readFramed(stream, maxBytes);
			const snap = await decodeJson<NeighborSnapshotV1>(bytes);
			// The snapshot's self-reported `from` must match the transport-authenticated
			// remote peer — otherwise a connected peer can impersonate another and poison
			// the routing table via a forged sample/successor set. The drop is a normal
			// outcome, not a failure — returning normally lets the seam close, never abort.
			const actual = connection.remotePeer.toString();
			if (snap.from !== actual) {
				onIdentityMismatch?.(snap.from, actual);
				// NOTE: debug-gated (@libp2p/logger emits only under DEBUG). If mismatch logging
				// is ever routed to an always-on sink, a hostile peer can spam it — rate-limit then.
				log.error('announce identity mismatch: claimed %s actual %s - dropping', snap.from, actual);
				return;
			}
			onAnnounce(snap.from, snap);
			sendFramed(stream, await encodeJson({ ok: true }));
		});
	}
}

/**
 * Fetch `peerIdOrStr`'s neighbor snapshot. Connection-only (dial `'never'`): no existing
 * connection yields `skipped` — nothing attempted, nothing fabricated. Every failure mode is
 * its own `RpcOutcome` variant; the decoded snapshot is not shape-validated beyond "JSON
 * object" (parity with the cast this replaced).
 */
export async function fetchNeighbors(
	node: Libp2p,
	peerIdOrStr: string,
	protocol = PROTOCOL_NEIGHBORS,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<RpcOutcome<NeighborSnapshotV1>> {
	return rpcRequest(node, peerIdOrStr, protocol, {
		...opts,
		dial: 'never',
		maxBytes: 128 * 1024,
		decode: (b) => decodeJson<NeighborSnapshotV1>(b),
	});
}

/**
 * Push our snapshot to `peerIdOrStr`.
 *
 * Connection-only by default (announcing is maintenance; dialing for it adds churn). Callers
 * that deliberately target *non-connected* peers — the "tell peers we just learned about"
 * paths, whose whole point is reaching someone we are not talking to yet — pass `dial: true`.
 * Those callers own the reachability check: dialing a peer libp2p holds no address for can
 * only fail (FRET's wire format carries peer ids, never multiaddrs).
 */
export async function announceNeighbors(
	node: Libp2p,
	peerIdOrStr: string,
	snapshot: NeighborSnapshotV1,
	protocol = PROTOCOL_NEIGHBORS_ANNOUNCE,
	opts: { dial?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<RpcOutcome<undefined>> {
	// Write-only: `ok` proves the body reached the transport, nothing more. No swallow — the
	// caller sees every outcome now.
	return rpcRequest(node, peerIdOrStr, protocol, {
		signal: opts.signal,
		timeoutMs: opts.timeoutMs,
		dial: opts.dial === true ? 'always' : 'never',
		body: snapshot,
	});
}
