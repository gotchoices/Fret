import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { PROTOCOL_LEAVE, encodeJson, decodeJson } from './protocols.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:leave');

export interface LeaveNoticeV1 {
	v: 1;
	from: string;
	replacements?: string[];
	timestamp: number;
}

export function registerLeave(
	node: Libp2p,
	onLeave: (notice: LeaveNoticeV1) => Promise<void> | void,
	protocol = PROTOCOL_LEAVE
): void {
	void node.handle(protocol, async (stream: Stream) => {
		try {
			const bytes = await readAll(stream);
			const msg = await decodeJson<LeaveNoticeV1>(bytes);
			await onLeave(msg);
			stream.send(await encodeJson({ ok: true }));
			await stream.close();
		} catch (err) {
			log.error('leave handler error - %e', err);
		}
	});
}

export async function sendLeave(
	node: Libp2p,
	peerIdStr: string,
	notice: LeaveNoticeV1,
	protocol = PROTOCOL_LEAVE
): Promise<void> {
	const pid = peerIdFromString(peerIdStr);
	const conns = node.getConnections(pid);
	let stream: Stream | undefined;
	try {
		if (conns.length > 0) {
			stream = await conns[0].newStream([protocol]);
		} else {
			stream = await node.dialProtocol(pid, [protocol]);
		}
		stream.send(await encodeJson(notice));
		await stream.close();
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
