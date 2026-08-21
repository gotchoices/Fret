import type { Libp2p } from 'libp2p';
import {
	PROTOCOL_LEAVE,
	registerJsonHandler,
} from './protocols.js';
import { rpcRequest } from './request.js';
import { parseLeaveNotice } from './validate.js';
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
	onIdentityMismatch?: (claimed: string, actual: string) => void,
	onMalformed?: (reason: 'decode' | 'parse') => void
): Promise<void> {
	// Decode, shape-check and stream release all belong to `registerJsonHandler` /
	// `registerRpcHandler`, not this body — including the close, which the seam performs under its
	// own budget so a remote that stops reading cannot hold the handler open. `parseLeaveNotice`
	// also performs the `replacements` sanitizing this body used to do inline, so `onLeave`
	// receives an already-normalized notice.
	await registerJsonHandler(node, protocol, {
		maxBytes: 4096, // 12 replacements*64 + from 64 + timestamp 16 + punctuation ~64 ≈ 912 bytes; ~4.5x headroom kept
		parse: parseLeaveNotice,
		onMalformed,
		serve: async (msg, connection) => {
			// A leave notice removes the peer it names, so an unverified `from` lets any
			// connected peer evict any other. Reject unless `from` matches the
			// transport-authenticated sender before touching the routing table. Returning
			// `undefined` drops without replying — a normal outcome, not a failure, so the seam
			// closes and never aborts.
			const actual = connection.remotePeer.toString();
			if (msg.from !== actual) {
				onIdentityMismatch?.(msg.from, actual);
				// NOTE: debug-gated (@libp2p/logger emits only under DEBUG). If mismatch logging
				// is ever routed to an always-on sink, a hostile peer can spam it — rate-limit then.
				log.error('leave identity mismatch: claimed %s actual %s - dropping', msg.from, actual);
				return undefined;
			}
			await onLeave(msg);
			return undefined;
		},
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
