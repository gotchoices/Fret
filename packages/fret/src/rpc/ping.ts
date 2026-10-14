import type { Libp2p } from 'libp2p';
import {
	PROTOCOL_PING,
	decodeJson,
	registerJsonHandler,
} from './protocols.js';
import type { StreamCaps } from './protocols.js';
import { rpcRequest, type RpcRequestOptions } from './request.js';
import { parseOrThrow, parsePingResponse } from './validate.js';
import type { RpcOutcome } from './outcome.js';
import type { BusyResponseV1 } from '../index.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:ping');

export interface PingResponseV1 {
	ok: boolean;
	ts: number;
	size_estimate?: number;
	confidence?: number;
	/**
	 * The responder's current `NeighborSnapshotV1.digest`, so a neighbour that already merged that
	 * content can skip its snapshot fetch. Optional, no version bump: an older responder omits it
	 * and the sender fetches as before.
	 */
	snapshot_digest?: string;
}

/** The optional fields a responder adds to its pong — see {@link PingResponseV1}. */
export type PingReplyExtras = Pick<PingResponseV1, 'size_estimate' | 'confidence' | 'snapshot_digest'>;

/** Supplies {@link PingReplyExtras} per inbound ping, or a busy refusal in place of the pong. */
export type PingReplyProvider = () => PingReplyExtras | BusyResponseV1 | Promise<PingReplyExtras | BusyResponseV1>;

export async function registerPing(
	node: Libp2p,
	protocol = PROTOCOL_PING,
	getReplyExtras?: PingReplyProvider,
	onInbound?: (from: string) => void,
	// Trailing and optional so existing positional callers keep compiling. Forwarded verbatim to
	// `node.handle`; omitting it leaves libp2p's own per-connection defaults.
	streamCaps: StreamCaps = {}
): Promise<void> {
	// Ping carries no `from`, but the connection's remote peer is transport-authenticated —
	// and reaching this handler at all means the remote dialed *this network's* namespaced
	// protocol. `onInbound` hands that proof to the caller.
	// Reply-only: this protocol reads no request body, so it takes the body-less overload of
	// `registerJsonHandler` — a decode step here would be pure ceremony. Encoding, errors and
	// stream release (including the budgeted close) belong to the seam, not this body.
	await registerJsonHandler(node, protocol, {
		...streamCaps,
		serve: (connection) => {
			onInbound?.(connection.remotePeer.toString());
			return pingReply(getReplyExtras);
		},
	});
}

/**
 * The body of a ping answer. Split out so the provider's `try` covers the *provider* alone: while
 * it also wrapped the send-and-close tail, a stream that failed mid-reply was logged as a failed
 * provider and then answered a second time on the same broken stream.
 *
 * A failed provider is not a failed ping — it degrades to a plain pong.
 */
async function pingReply(getReplyExtras?: PingReplyProvider): Promise<PingResponseV1 | BusyResponseV1> {
	// Busy test on the *provider's return* — an in-process value, not a wire reply, so this is not
	// a copy of `rpcRequest`'s busy classification.
	const isBusy = (res: unknown): res is BusyResponseV1 =>
		typeof res === 'object' && res !== null && 'busy' in res && (res as { busy?: unknown }).busy === true;
	const pong = (): PingResponseV1 => ({ ok: true, ts: Date.now() });
	if (!getReplyExtras) return pong();
	let extras: Awaited<ReturnType<PingReplyProvider>>;
	try {
		extras = await getReplyExtras();
	} catch (err) {
		log.error('ping reply provider failed - %e', err);
		return pong();
	}
	if (isBusy(extras)) return extras;
	const response = pong();
	if (extras.size_estimate !== undefined) {
		response.size_estimate = extras.size_estimate;
		response.confidence = extras.confidence;
	}
	if (extras.snapshot_digest !== undefined) response.snapshot_digest = extras.snapshot_digest;
	return response;
}

/**
 * Ping `peer` over this network's namespaced protocol. Read-only request (the handler replies
 * without reading). `dial` defaults to `'always'`; the service's maintenance passes pass
 * `'never'`, because opening a connection is the redial seam's job under its own budget and a
 * 2 s ping budget cannot cover a dial on a slow link. `ok.value.ok` is the peer's own pong flag;
 * rttMs on the outcome. Truncation/undecodable replies are `decode-error` — the service scores
 * them as proof of life.
 */
export async function sendPing(
	node: Libp2p,
	peer: string,
	protocol = PROTOCOL_PING,
	opts: { signal?: AbortSignal; timeoutMs?: number; dial?: RpcRequestOptions<unknown>['dial'] } = {}
): Promise<RpcOutcome<{ ok: boolean; size_estimate?: number; confidence?: number; snapshot_digest?: string }>> {
	return rpcRequest(node, peer, protocol, {
		...opts,
		// A ping reply is tiny and fixed-shape ({ok, ts, size_estimate?, confidence?,
		// snapshot_digest?}) — ~140 bytes at its worst against this cap.
		maxBytes: 1024,
		// The parser replaces the old `Boolean(r.ok)` coercion: a legal value always encodes as a
		// boolean, so the coercion could only ever have hidden a malformed peer. A rejection
		// throws (see `parseOrThrow`) and surfaces as `decode-error` — proof of life, never a
		// contact strike.
		decode: (b) => parseOrThrow(parsePingResponse, decodeJson(b)),
	});
}
