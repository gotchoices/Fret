import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import {
	PROTOCOL_NEIGHBORS,
	PROTOCOL_NEIGHBORS_ANNOUNCE,
	RPC_TIMEOUT_MS,
	encodeJson,
	decodeJson,
	readFramed,
	sendFramed,
	openRpcStream,
	registerRpcHandler,
	releaseRpcStream,
} from './protocols.js';
import { deadline } from '../utils/deadline.js';
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
	// Errors and stream release belong to `registerRpcHandler`, not these bodies.
	await registerRpcHandler(node, protocols.PROTOCOL_NEIGHBORS, async (stream, connection) => {
		onInbound?.(connection.remotePeer.toString());
		const snap = await getSnapshot();
		sendFramed(stream, await encodeJson(snap));
		await stream.close();
	});

	if (onAnnounce) {
		await registerRpcHandler(node, protocols.PROTOCOL_NEIGHBORS_ANNOUNCE, async (stream, connection) => {
			const bytes = await readFramed(stream, maxBytes);
			const snap = await decodeJson<NeighborSnapshotV1>(bytes);
			// The snapshot's self-reported `from` must match the transport-authenticated
			// remote peer — otherwise a connected peer can impersonate another and poison
			// the routing table via a forged sample/successor set. The drop is a normal
			// outcome, not a failure — it closes, never aborts.
			const actual = connection.remotePeer.toString();
			if (snap.from !== actual) {
				onIdentityMismatch?.(snap.from, actual);
				// NOTE: debug-gated (@libp2p/logger emits only under DEBUG). If mismatch logging
				// is ever routed to an always-on sink, a hostile peer can spam it — rate-limit then.
				log.error('announce identity mismatch: claimed %s actual %s - dropping', snap.from, actual);
				await stream.close();
				return;
			}
			onAnnounce(snap.from, snap);
			sendFramed(stream, await encodeJson({ ok: true }));
			await stream.close();
		});
	}
}

/** The "nothing usable came back" answer, returned on every non-answer path (see the NOTE below). */
function emptySnapshot(from: string): NeighborSnapshotV1 {
	return { v: 1, from, timestamp: Date.now(), successors: [], predecessors: [], sig: '' } as NeighborSnapshotV1;
}

/**
 * Fetch `peerIdOrStr`'s neighbor snapshot. Connection-only (`requireExisting`).
 *
 * `opts.timeoutMs` budgets the whole RPC (open + read); `opts.signal` cancels it.
 *
 * NOTE: every failure — including a timeout and a cancellation — is swallowed into a fabricated
 * empty snapshot, so the caller cannot tell "this peer has no neighbors" from "this call never
 * completed". That predates the deadline work and is `15-rpc-shared-helper`'s "fetchNeighbors
 * fabricates success" arm; the deadline is cancelled and the stream released on that path either
 * way, so the fabrication leaks neither a timer nor a stream.
 */
export async function fetchNeighbors(
	node: Libp2p,
	peerIdOrStr: string,
	protocol = PROTOCOL_NEIGHBORS,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<NeighborSnapshotV1> {
	const pid = peerIdFromString(peerIdOrStr);
	const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;
	const d = deadline(timeoutMs, opts.signal);
	let stream: Stream | undefined;
	try {
		stream = await openRpcStream(node, pid, [protocol], { requireExisting: true, signal: d.signal });
		if (stream == null) {
			// No existing connection - skip to reduce churn
			return emptySnapshot(peerIdOrStr);
		}
		const bytes = await readFramed(stream, 128 * 1024, timeoutMs, { signal: d.signal });
		const res = await decodeJson<NeighborSnapshotV1 | BusyResponseV1>(bytes);
		if ('busy' in res && (res as BusyResponseV1).busy) {
			return emptySnapshot(peerIdOrStr);
		}
		return res as NeighborSnapshotV1;
	} catch (err) {
		log.error('fetchNeighbors decode failed for %s - %e', peerIdOrStr, err);
		return emptySnapshot(peerIdOrStr);
	} finally {
		await releaseRpcStream(stream, d.signal);
		d.cancel();
	}
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
): Promise<void> {
	const pid = peerIdFromString(peerIdOrStr);
	const d = deadline(opts.timeoutMs ?? RPC_TIMEOUT_MS, opts.signal);
	let stream: Stream | undefined;
	try {
		stream = await openRpcStream(node, pid, [protocol], {
			requireExisting: opts.dial !== true,
			signal: d.signal,
		});
		if (stream == null) {
			return; // no connection and dialing not requested
		}
		sendFramed(stream, await encodeJson(snapshot));
	} catch (err) {
		log.error('announceNeighbors failed to %s - %e', peerIdOrStr, err);
	} finally {
		// The close *is* the flush for this write-only RPC, so it happens here rather than in the
		// `try`; on the aborted path `releaseRpcStream` swaps it for a synchronous `abort`.
		await releaseRpcStream(stream, d.signal);
		d.cancel();
	}
}

