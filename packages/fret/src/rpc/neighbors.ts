import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import {
	PROTOCOL_NEIGHBORS,
	PROTOCOL_NEIGHBORS_ANNOUNCE,
	encodeJson,
	decodeJson,
} from './protocols.js';
import type { NeighborSnapshotV1 } from '../index.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:neighbors');

export function registerNeighbors(
	node: Libp2p,
	getSnapshot: () => NeighborSnapshotV1 | Promise<NeighborSnapshotV1>,
	onAnnounce?: (from: string, snapshot: NeighborSnapshotV1) => void,
	protocols = { PROTOCOL_NEIGHBORS, PROTOCOL_NEIGHBORS_ANNOUNCE }
): void {
	void node.handle(protocols.PROTOCOL_NEIGHBORS, async (stream: Stream) => {
		try {
			const snap = await getSnapshot();
			stream.send(await encodeJson(snap));
			await stream.close();
		} catch (err) {
			log.error('neighbors handler error - %e', err);
		}
	});

	// Optional: accept pushed announcements of neighbor snapshots
	if (onAnnounce) {
		void node.handle(protocols.PROTOCOL_NEIGHBORS_ANNOUNCE, async (stream: Stream) => {
			try {
				const bytes = await readAll(stream);
				const snap = await decodeJson<NeighborSnapshotV1>(bytes);
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
	const conns = node.getConnections(pid);
	if (conns.length === 0) {
		// No existing connection - skip to reduce churn
		return { v: 1, from: peerIdOrStr, timestamp: Date.now(), successors: [], predecessors: [], sig: '' } as NeighborSnapshotV1;
	}
	let stream: Stream | undefined;
	try {
		stream = await conns[0].newStream([protocol]);
		const bytes = await readAll(stream);
		return await decodeJson<NeighborSnapshotV1>(bytes);
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
	const conns = node.getConnections(pid);
	if (conns.length === 0) {
		return; // skip if not connected
	}
	let stream: Stream | undefined;
	try {
		stream = await conns[0].newStream([protocol]);
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

function toBytes(chunk: Uint8Array | { subarray(): Uint8Array }): Uint8Array {
	if (chunk instanceof Uint8Array) return chunk;
	return chunk.subarray();
}

async function readAll(stream: Stream): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	for await (const chunk of stream) parts.push(toBytes(chunk));
	let len = 0;
	for (const p of parts) len += p.length;
	const out = new Uint8Array(len);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}
