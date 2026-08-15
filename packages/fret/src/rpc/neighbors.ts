import type { Libp2p } from 'libp2p';
import type { Connection, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import {
	PROTOCOL_NEIGHBORS,
	PROTOCOL_NEIGHBORS_ANNOUNCE,
	encodeJson,
	decodeJson,
	readAllBounded,
	openRpcStream,
} from './protocols.js';
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
	await node.handle(protocols.PROTOCOL_NEIGHBORS, async (stream: Stream, connection: Connection) => {
		onInbound?.(connection.remotePeer.toString());
		try {
			const snap = await getSnapshot();
			stream.send(await encodeJson(snap));
			await stream.close();
		} catch (err) {
			log.error('neighbors handler error - %e', err);
		}
	});

	if (onAnnounce) {
		await node.handle(protocols.PROTOCOL_NEIGHBORS_ANNOUNCE, async (stream: Stream, connection: Connection) => {
			try {
				const bytes = await readAllBounded(stream, maxBytes);
				const snap = await decodeJson<NeighborSnapshotV1>(bytes);
				// The snapshot's self-reported `from` must match the transport-authenticated
				// remote peer — otherwise a connected peer can impersonate another and poison
				// the routing table via a forged sample/successor set.
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
				stream.send(await encodeJson({ ok: true }));
				await stream.close();
			} catch (err) {
				log.error('neighbors announce handler error - %e', err);
			}
		});
	}
}

export async function fetchNeighbors(
	node: Libp2p,
	peerIdOrStr: string,
	protocol = PROTOCOL_NEIGHBORS
): Promise<NeighborSnapshotV1> {
	const pid = peerIdFromString(peerIdOrStr);
	let stream: Stream | undefined;
	try {
		stream = await openRpcStream(node, pid, [protocol], { requireExisting: true });
		if (stream == null) {
			// No existing connection - skip to reduce churn
			return { v: 1, from: peerIdOrStr, timestamp: Date.now(), successors: [], predecessors: [], sig: '' } as NeighborSnapshotV1;
		}
		const bytes = await readAllBounded(stream, 128 * 1024);
		const res = await decodeJson<NeighborSnapshotV1 | BusyResponseV1>(bytes);
		if ('busy' in res && (res as BusyResponseV1).busy) {
			return { v: 1, from: peerIdOrStr, timestamp: Date.now(), successors: [], predecessors: [], sig: '' } as NeighborSnapshotV1;
		}
		return res as NeighborSnapshotV1;
	} catch (err) {
		log.error('fetchNeighbors decode failed for %s - %e', peerIdOrStr, err);
		return { v: 1, from: peerIdOrStr, timestamp: Date.now(), successors: [], predecessors: [], sig: '' } as NeighborSnapshotV1;
	} finally {
		if (stream != null) {
			try { await stream.close(); } catch {}
		}
	}
}

export async function announceNeighbors(
	node: Libp2p,
	peerIdOrStr: string,
	snapshot: NeighborSnapshotV1,
	protocol = PROTOCOL_NEIGHBORS_ANNOUNCE
): Promise<void> {
	const pid = peerIdFromString(peerIdOrStr);
	let stream: Stream | undefined;
	try {
		stream = await openRpcStream(node, pid, [protocol], { requireExisting: true });
		if (stream == null) {
			return; // skip if not connected
		}
		stream.send(await encodeJson(snapshot));
		await stream.close();
	} catch (err) {
		log.error('announceNeighbors failed to %s - %e', peerIdOrStr, err);
	} finally {
		if (stream != null) {
			try { await stream.close(); } catch {}
		}
	}
}

