import type { Libp2p } from 'libp2p';
import {
	PROTOCOL_PING,
	decodeJson,
	registerJsonHandler,
} from './protocols.js';
import { rpcRequest } from './request.js';
import type { RpcOutcome } from './outcome.js';
import type { BusyResponseV1 } from '../index.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:ping');

export interface PingResponseV1 {
	ok: boolean;
	ts: number;
	size_estimate?: number;
	confidence?: number;
}

export type SizeEstimateProvider = () => { size_estimate?: number; confidence?: number } | BusyResponseV1 | Promise<{ size_estimate?: number; confidence?: number } | BusyResponseV1>;

export async function registerPing(
	node: Libp2p,
	protocol = PROTOCOL_PING,
	getSizeEstimate?: SizeEstimateProvider,
	onInbound?: (from: string) => void
): Promise<void> {
	// Ping carries no `from`, but the connection's remote peer is transport-authenticated —
	// and reaching this handler at all means the remote dialed *this network's* namespaced
	// protocol. `onInbound` hands that proof to the caller.
	// Reply-only: this protocol reads no request body, so it takes the body-less overload of
	// `registerJsonHandler` — a decode step here would be pure ceremony. Encoding, errors and
	// stream release (including the budgeted close) belong to the seam, not this body.
	await registerJsonHandler(node, protocol, {
		serve: (connection) => {
			onInbound?.(connection.remotePeer.toString());
			return pingReply(getSizeEstimate);
		},
	});
}

/**
 * The body of a ping answer. Split out so the estimate's `try` covers the *provider* alone: while
 * it also wrapped the send-and-close tail, a stream that failed mid-reply was logged as a failed
 * estimate and then answered a second time on the same broken stream.
 *
 * A failed estimate is not a failed ping — it degrades to a plain pong.
 */
async function pingReply(getSizeEstimate?: SizeEstimateProvider): Promise<PingResponseV1 | BusyResponseV1> {
	// Busy test on the size-estimate *provider's return* — an in-process value, not a wire reply,
	// so this is not a copy of `rpcRequest`'s busy classification.
	const isBusy = (res: unknown): res is BusyResponseV1 =>
		typeof res === 'object' && res !== null && 'busy' in res && (res as { busy?: unknown }).busy === true;
	const pong = (): PingResponseV1 => ({ ok: true, ts: Date.now() });
	if (!getSizeEstimate) return pong();
	let sizeInfo: Awaited<ReturnType<SizeEstimateProvider>>;
	try {
		sizeInfo = await getSizeEstimate();
	} catch (err) {
		log.error('getSizeEstimate failed - %e', err);
		return pong();
	}
	if (isBusy(sizeInfo)) return sizeInfo;
	const response = pong();
	if (sizeInfo.size_estimate !== undefined) {
		response.size_estimate = sizeInfo.size_estimate;
		response.confidence = sizeInfo.confidence;
	}
	return response;
}

/**
 * Ping `peer` over this network's namespaced protocol. Read-only request (the handler replies
 * without reading); dial 'always'. `ok.value.ok` is the peer's own pong flag; rttMs on the
 * outcome. Truncation/undecodable replies are `decode-error` — the service scores them as
 * proof of life.
 */
export async function sendPing(
	node: Libp2p,
	peer: string,
	protocol = PROTOCOL_PING,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<RpcOutcome<{ ok: boolean; size_estimate?: number; confidence?: number }>> {
	return rpcRequest(node, peer, protocol, {
		...opts,
		maxBytes: 1024,
		decode: async (b) => {
			const r = await decodeJson<PingResponseV1>(b);
			return { ok: Boolean(r.ok), size_estimate: r.size_estimate, confidence: r.confidence };
		},
	});
}
