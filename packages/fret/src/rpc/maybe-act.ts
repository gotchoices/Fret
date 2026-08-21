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
import { rpcRequest } from './request.js';
import { parseMaybeActReply, parseOrThrow, MAX_ACTIVITY_BYTES, MAYBE_ACT_OVERHEAD_BYTES } from './validate.js';
import type { RpcOutcome } from './outcome.js';
import type { RouteAndMaybeActV1, NearAnchorV1, BusyResponseV1 } from '../index.js';

const log = createLogger('rpc:maybe-act');

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
			// Body-level failure: the peer framed correctly and is alive, it just sent junk. Drop
			// it — close the stream (the seam's own budgeted close, hence the bare return and no
			// `close()` here) and write nothing back. Same rule the other four handlers get from
			// `registerJsonHandler`'s body-level tier; maybeAct only parses in its own body
			// because its token bucket must be taken first.
			//
			// Answering with a static reject would be *unmetered*, which is what separates this
			// from the cheap-guard rejections that do answer: `decodeJson` runs here, upstream of
			// the maybeAct token bucket taken inside `handleMaybeAct`, so a static reply would
			// hand a peer one reply frame per undecodable message without ever spending a token.
			// The cheap guards run after the bucket, so they are metered. Metered -> answer;
			// unmetered -> drop.
			log.error('%s: undecodable body - dropping - %e', protocol, err);
			onMalformed?.();
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

