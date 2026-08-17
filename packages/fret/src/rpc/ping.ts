import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import {
	PROTOCOL_PING,
	RPC_TIMEOUT_MS,
	encodeJson,
	decodeJson,
	readAllBounded,
	openRpcStream,
	registerRpcHandler,
	releaseRpcStream,
} from './protocols.js';
import { deadline } from '../utils/deadline.js';
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

function isBusy(res: unknown): res is BusyResponseV1 {
	return typeof res === 'object' && res !== null && 'busy' in res && (res as any).busy === true;
}

export async function registerPing(
	node: Libp2p,
	protocol = PROTOCOL_PING,
	getSizeEstimate?: SizeEstimateProvider,
	onInbound?: (from: string) => void
): Promise<void> {
	// Ping carries no `from`, but the connection's remote peer is transport-authenticated —
	// and reaching this handler at all means the remote dialed *this network's* namespaced
	// protocol. `onInbound` hands that proof to the caller.
	// Errors and stream release belong to `registerRpcHandler` — the reply tail below used to
	// sit outside any try at all, so a reset stream rejected the handler promise unlogged.
	await registerRpcHandler(node, protocol, async (stream, connection) => {
		onInbound?.(connection.remotePeer.toString());
		stream.send(await encodeJson(await pingReply(getSizeEstimate)));
		await stream.close();
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
 * Ping `peer` over this network's namespaced protocol.
 *
 * `opts.timeoutMs` is the budget for the *whole* RPC — dial, stream open, and read — not the
 * read alone. `opts.signal` cancels it from outside (a `stop()`, or a caller-imposed budget);
 * the sender's own deadline is a child of it, so a caller can tell its own cancellation from a
 * genuine timeout by checking the signal it passed.
 */
export async function sendPing(
	node: Libp2p,
	peer: string,
	protocol = PROTOCOL_PING,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<{ ok: boolean; rttMs: number; size_estimate?: number; confidence?: number }> {
	const pid = peerIdFromString(peer);
	const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;
	const d = deadline(timeoutMs, opts.signal);
	let stream: Stream | undefined;
	try {
		stream = await openRpcStream(node, pid, [protocol], { signal: d.signal });
		// RTT is measured from *after* the open: a dial is not round-trip time, and counting it
		// inflated first-contact latency into peer health scoring.
		const start = Date.now();
		const bytes = await readAllBounded(stream!, 1024, timeoutMs, { signal: d.signal });
		const rttMs = Math.max(0, Date.now() - start);
		if (bytes.length === 0) return { ok: false, rttMs };
		try {
			const res = await decodeJson<PingResponseV1 | BusyResponseV1>(bytes);
			if (isBusy(res)) return { ok: false, rttMs };
			return {
				ok: Boolean(res.ok),
				rttMs,
				size_estimate: res.size_estimate,
				confidence: res.confidence
			};
		} catch (err) {
			log.error('sendPing decode failed - %e', err);
			return { ok: false, rttMs };
		}
	} finally {
		await releaseRpcStream(stream, d.signal);
		d.cancel();
	}
}

