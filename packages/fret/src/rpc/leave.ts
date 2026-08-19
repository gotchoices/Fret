import type { Libp2p } from 'libp2p';
import {
	PROTOCOL_LEAVE,
	encodeJson,
	decodeJson,
	readFramed,
	sendFramed,
	registerRpcHandler,
} from './protocols.js';
import { rpcRequest } from './request.js';
import { sanitizeReplacements } from './validate.js';
import type { RpcOutcome } from './outcome.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:leave');

export interface LeaveNoticeV1 {
	v: 1;
	from: string;
	replacements?: string[];
	timestamp: number;
}

export async function registerLeave(
	node: Libp2p,
	onLeave: (notice: LeaveNoticeV1) => Promise<void> | void,
	protocol = PROTOCOL_LEAVE,
	onIdentityMismatch?: (claimed: string, actual: string) => void
): Promise<void> {
	// Errors and stream release belong to `registerRpcHandler`, not this body — including the
	// close, which the seam performs under its own budget so a remote that stops reading cannot
	// hold the handler open.
	await registerRpcHandler(node, protocol, async (stream, connection) => {
		const bytes = await readFramed(stream, 4096);
		const msg = await decodeJson<LeaveNoticeV1>(bytes);
		// A leave notice removes the peer it names, so an unverified `from` lets any
		// connected peer evict any other. Reject unless `from` matches the
		// transport-authenticated sender before touching the routing table. The drop is a
		// normal outcome, not a failure — returning normally lets the seam close, never abort.
		const actual = connection.remotePeer.toString();
		if (msg.from !== actual) {
			onIdentityMismatch?.(msg.from, actual);
			// NOTE: debug-gated (@libp2p/logger emits only under DEBUG). If mismatch logging
			// is ever routed to an always-on sink, a hostile peer can spam it — rate-limit then.
			log.error('leave identity mismatch: claimed %s actual %s - dropping', msg.from, actual);
			return;
		}
		msg.replacements = sanitizeReplacements(msg.replacements);
		await onLeave(msg);
		sendFramed(stream, await encodeJson({ ok: true }));
	});
}

export async function sendLeave(
	node: Libp2p,
	peerIdStr: string,
	notice: LeaveNoticeV1,
	protocol = PROTOCOL_LEAVE,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<RpcOutcome<undefined>> {
	// Write-only — still reads no reply; see the parking note in docs/fret.md *Leave*.
	return rpcRequest(node, peerIdStr, protocol, { ...opts, body: notice });
}
