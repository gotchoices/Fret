import type { Libp2p } from 'libp2p';
import type { Connection, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { PROTOCOL_LEAVE, encodeJson, decodeJson, readAllBounded, openRpcStream } from './protocols.js';
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
	protocol = PROTOCOL_LEAVE,
	onIdentityMismatch?: (claimed: string, actual: string) => void
): void {
	void node.handle(protocol, async (stream: Stream, connection: Connection) => {
		try {
			const bytes = await readAllBounded(stream, 4096);
			const msg = await decodeJson<LeaveNoticeV1>(bytes);
			// A leave notice removes the peer it names, so an unverified `from` lets any
			// connected peer evict any other. Reject unless `from` matches the
			// transport-authenticated sender before touching the routing table.
			const actual = connection.remotePeer.toString();
			if (msg.from !== actual) {
				onIdentityMismatch?.(msg.from, actual);
				// NOTE: debug-gated (@libp2p/logger emits only under DEBUG). If mismatch logging
				// is ever routed to an always-on sink, a hostile peer can spam it — rate-limit then.
				log.error('leave identity mismatch: claimed %s actual %s - dropping', msg.from, actual);
				await stream.close();
				return;
			}
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
	let stream: Stream | undefined;
	try {
		stream = await openRpcStream(node, pid, [protocol]);
		stream!.send(await encodeJson(notice));
		await stream!.close();
	} finally {
		if (stream != null) {
			try { await stream.close(); } catch {}
		}
	}
}
