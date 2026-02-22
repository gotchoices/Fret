import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { PROTOCOL_LEAVE, encodeJson, decodeJson, readAllBounded } from './protocols.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:leave');

export interface LeaveNoticeV1 {
	v: 1;
	from: string;
	replacements?: string[];
	timestamp: number;
}

const MAX_REPLACEMENTS = 12;

function sanitizeReplacements(ids: string[] | undefined): string[] | undefined {
	if (!ids || ids.length === 0) return undefined;
	const valid: string[] = [];
	for (const id of ids.slice(0, MAX_REPLACEMENTS)) {
		try { peerIdFromString(id); valid.push(id); } catch { /* drop unparseable */ }
	}
	return valid.length > 0 ? valid : undefined;
}

export function registerLeave(
	node: Libp2p,
	onLeave: (notice: LeaveNoticeV1) => Promise<void> | void,
	protocol = PROTOCOL_LEAVE
): void {
	void node.handle(protocol, async (stream: Stream) => {
		try {
			const bytes = await readAllBounded(stream, 4096);
			const msg = await decodeJson<LeaveNoticeV1>(bytes);
			msg.replacements = sanitizeReplacements(msg.replacements);
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
