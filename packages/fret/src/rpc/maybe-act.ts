import type { Libp2p } from 'libp2p';
import {
	PROTOCOL_MAYBE_ACT,
	encodeJson,
	decodeJson,
	readFramed,
	sendFramed,
	registerRpcHandler,
} from './protocols.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:maybe-act');
import { rpcRequest } from './request.js';
import { parseMaybeActReply, parseOrThrow, MAX_ACTIVITY_BYTES, MAYBE_ACT_OVERHEAD_BYTES } from './validate.js';
import type { RpcOutcome } from './outcome.js';
import type { RouteAndMaybeActV1, NearAnchorV1, BusyResponseV1 } from '../index.js';

export async function registerMaybeAct(
	node: Libp2p,
	handle: (msg: RouteAndMaybeActV1, from: string) => Promise<NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }>,
	protocol = PROTOCOL_MAYBE_ACT,
	maxBytes = MAX_ACTIVITY_BYTES + MAYBE_ACT_OVERHEAD_BYTES,
	onMalformed?: () => void
): Promise<void> {
	// No inbound `from` on RouteAndMaybeAct, but thread the transport-authenticated
	// sender id through to `handle` for future per-peer rate limiting / diagnostics.
	// Errors and stream release belong to `registerRpcHandler`, not this body — including the
	// close, which the seam performs under its own budget so a remote that stops reading cannot
	// hold the handler open.
	await registerRpcHandler(node, protocol, async (stream, connection) => {
		const bytes = await readFramed(stream, maxBytes);
		let msg: RouteAndMaybeActV1;
		try {
			msg = decodeJson<RouteAndMaybeActV1>(bytes);
		} catch (err) {
			log.error('%s: undecodable body - dropping - %e', protocol, err);
			onMalformed?.();
			sendFramed(stream, encodeJson({ v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 0, confidence: 0 } satisfies NearAnchorV1));
			return;
		}
		const res = await handle(msg, connection.remotePeer.toString());
		sendFramed(stream, encodeJson(res));
	});
}

/**
 * Route one `RouteAndMaybeAct` to `peerIdStr` and await its answer.
 *
 * `opts.timeoutMs` budgets the whole RPC (dial + open + write + read) and defaults to
 * {@link RPC_TIMEOUT_MS}. It is deliberately left at that default by every call site: this call
 * returns only once the *entire remaining route* has completed downstream, so its budget is a
 * route budget rather than a link budget, and tightening it truncates healthy long routes.
 */
export async function sendMaybeAct(
	node: Libp2p,
	peerIdStr: string,
	msg: RouteAndMaybeActV1,
	protocol = PROTOCOL_MAYBE_ACT,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<RpcOutcome<NearAnchorV1 | { commitCertificate: string }>> {
	return rpcRequest(node, peerIdStr, protocol, {
		...opts,
		body: msg,
		halfCloseBeforeRead: true,
		maxBytes: MAX_ACTIVITY_BYTES + MAYBE_ACT_OVERHEAD_BYTES,
		// A reply that is neither shape is `decode-error`, not a half-parsed cast.
		decode: (b) => parseOrThrow(parseMaybeActReply, decodeJson(b)),
	});
}

