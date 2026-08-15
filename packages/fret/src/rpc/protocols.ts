import type { Libp2p } from 'libp2p';
import type { Connection, PeerId, Stream } from '@libp2p/interface';

export function makeProtocols(networkName = 'default') {
	const prefix = `/optimystic/${networkName}/fret/1.0.0`;
	return {
		PROTOCOL_NEIGHBORS: `${prefix}/neighbors`,
		PROTOCOL_NEIGHBORS_ANNOUNCE: `${prefix}/neighbors/announce`,
		PROTOCOL_MAYBE_ACT: `${prefix}/maybeAct`,
		PROTOCOL_LEAVE: `${prefix}/leave`,
		PROTOCOL_PING: `${prefix}/ping`,
	};
}

// Backward compatibility: default export uses 'default' network
export const PROTOCOL_NEIGHBORS = '/optimystic/default/fret/1.0.0/neighbors';
export const PROTOCOL_NEIGHBORS_ANNOUNCE = '/optimystic/default/fret/1.0.0/neighbors/announce';
export const PROTOCOL_MAYBE_ACT = '/optimystic/default/fret/1.0.0/maybeAct';
export const PROTOCOL_LEAVE = '/optimystic/default/fret/1.0.0/leave';
export const PROTOCOL_PING = '/optimystic/default/fret/1.0.0/ping';

/**
 * True when `err` is libp2p's protocol-negotiation failure — i.e. the remote does
 * not support the dialed protocol. Thrown by `dialProtocol`/`newStream` (via
 * multistream-select) as `UnsupportedProtocolError`.
 *
 * This is the definitive "foreign network" signal for namespaced FRET RPCs: it must
 * be distinguished from a generic timeout / transient failure (which leaves a peer
 * unclassified). Matches by `name` (modern libp2p) and `code` (legacy
 * `ERR_UNSUPPORTED_PROTOCOL`), with a message-substring fallback.
 */
export function isUnsupportedProtocolError(err: unknown): boolean {
	if (err == null || typeof err !== 'object') return false;
	const e = err as { name?: unknown; code?: unknown; message?: unknown };
	if (e.name === 'UnsupportedProtocolError') return true;
	if (e.code === 'ERR_UNSUPPORTED_PROTOCOL') return true;
	if (typeof e.message === 'string') {
		const m = e.message.toLowerCase();
		if (m.includes('could not negotiate') || m.includes('protocol selection failed')) return true;
	}
	return false;
}

export async function encodeJson(obj: unknown): Promise<Uint8Array> {
	const text = JSON.stringify(obj);
	return new TextEncoder().encode(text);
}

export async function decodeJson<T = unknown>(bytes: Uint8Array): Promise<T> {
	// guard against binary frames or empty buffers from underlying muxers
	if (bytes.byteLength === 0) throw new Error('empty response');
	// strip any leading/trailing nulls/whitespace
	let start = 0;
	let end = bytes.byteLength;
	while (start < end && (bytes[start] === 0 || bytes[start] === 9 || bytes[start] === 10 || bytes[start] === 13 || bytes[start] === 32)) start++;
	while (end > start && (bytes[end - 1] === 0 || bytes[end - 1] === 9 || bytes[end - 1] === 10 || bytes[end - 1] === 13 || bytes[end - 1] === 32)) end--;
	if (end <= start) throw new Error('whitespace response');
	const text = new TextDecoder().decode(bytes.subarray(start, end));
	return JSON.parse(text) as T;
}

export function toBytes(chunk: Uint8Array | { subarray(): Uint8Array }): Uint8Array {
	if (chunk instanceof Uint8Array) return chunk;
	return chunk.subarray();
}

type StreamChunk = Uint8Array | { subarray(): Uint8Array };

/** Race sentinel — distinct from a real `IteratorResult`, so a poll tick is never read as EOF. */
const POLL_TICK = Symbol('readAllBounded.poll');

/**
 * How often to re-check the stream's own end-of-read state; see {@link remoteFinishedWriting}.
 *
 * NOTE: this adds up to one poll interval to every RPC that hits the lost-event case,
 * which is a floor under the measured ping RTT that feeds peer health scoring. The
 * durable fix is to subscribe before writing so the event is never missed at all (see
 * the framing/iterator-priming arm on `tickets/plan/8-rpc-shared-helper`); revisit this
 * constant if RTT-derived scoring ever needs finer resolution than this floor allows.
 */
const EOF_POLL_MS = 20;

/**
 * The subset of libp2p's `MessageStream`/`Stream` state we consult to recognise an
 * end-of-stream whose event we never received. Optional because `readAllBounded`
 * also accepts plain async iterables (tests, non-libp2p sources).
 */
interface ReadEndState {
	readBufferLength?: number;
	remoteWriteStatus?: string;
	readStatus?: string;
}

/**
 * True when the remote has closed its writing end AND everything it sent has been
 * drained — i.e. no further chunk can arrive, so the read is complete.
 *
 * libp2p's async-iterator adaptor ends the iteration off the one-shot
 * `remoteCloseWrite` / `close` events, which it subscribes to when iteration
 * *starts*. Every FRET RPC opens a stream, writes, and only then begins reading, so
 * a fast responder routinely closes before that subscription exists and the event is
 * lost — the iterator then never yields `done` and the read runs to its deadline.
 * Polling the stream's state recovers that case without ever guessing: a stream that
 * is merely slow reports neither a closed remote nor an empty-and-final buffer, so it
 * keeps being read.
 *
 * Returns false for a plain async iterable (no state to consult), leaving those
 * callers on ordinary iterator EOF.
 */
function remoteFinishedWriting(stream: unknown): boolean {
	const s = stream as ReadEndState | null;
	if (typeof s?.readBufferLength !== 'number') return false;
	if (s.readBufferLength > 0) return false;
	return s.remoteWriteStatus === 'closed' || s.readStatus === 'closed';
}

/**
 * Read a whole stream into one buffer, bounded by `maxBytes` and a single overall
 * `timeoutMs` deadline.
 *
 * There is deliberately no *idle* timer — a gap between chunks means a slow link, not
 * end-of-stream, and treating it as EOF truncated healthy transfers into malformed
 * JSON and failure-scored the (healthy) sender. Reads end on iterator EOF, or on the
 * stream itself reporting the remote finished writing; only the overall deadline
 * bounds a peer that genuinely stalls mid-payload.
 *
 * NOTE: an inbound handler holds a stalled stream for the full `timeoutMs` (5s
 * default) rather than failing fast, bounded by the per-profile inbound stream caps.
 * If slow-loris pressure ever shows up, give handlers a shorter read deadline — do
 * not reintroduce an idle timer.
 *
 * @throws if the deadline expires or `maxBytes` is exceeded — a partial read is an
 * error, never a short-but-valid result, so callers report a timeout instead of the
 * malformed-JSON error a truncated buffer would produce downstream.
 */
export async function readAllBounded(
	stream: AsyncIterable<StreamChunk>,
	maxBytes: number,
	timeoutMs = 5000
): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	let len = 0;
	const iter = stream[Symbol.asyncIterator]();
	const deadline = Date.now() + timeoutMs;
	const timedOut = () => new Error(`read timed out after ${timeoutMs}ms (${len} bytes read)`);
	// Held across poll ticks: re-calling `iter.next()` would queue a second read and
	// silently drop whichever chunk the abandoned one consumes.
	let pending: Promise<IteratorResult<StreamChunk>> | undefined;

	while (true) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw timedOut();

		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = new Promise<typeof POLL_TICK>(r => {
			timer = setTimeout(() => r(POLL_TICK), Math.min(remaining, EOF_POLL_MS));
		});
		if (pending == null) {
			pending = iter.next();
			pending.catch(() => {}); // Prevent unhandled rejection if the poll wins
		}
		const result = await Promise.race<IteratorResult<StreamChunk> | typeof POLL_TICK>([pending, poll]);
		clearTimeout(timer);

		if (result === POLL_TICK) {
			if (remoteFinishedWriting(stream)) break;
			continue; // still open — keep waiting on `pending`, bounded only by the deadline
		}
		pending = undefined;
		if (result.done) break;

		const bytes = toBytes(result.value);
		len += bytes.length;
		if (len > maxBytes) throw new Error(`payload too large: ${len} exceeds ${maxBytes} byte limit`);
		parts.push(bytes);
	}

	const out = new Uint8Array(len);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

/**
 * Freshness check for an inbound message: is its timestamp within `maxDriftMs` of now?
 *
 * The default is deliberately the same 30s as the dedup cache's TTL (`DedupCache`). Any slack
 * between the two is a replay window: a captured message whose dedup entry has already expired
 * but whose timestamp still passes is accepted and re-performed. The old 5-minute default left
 * 4.5 minutes of that. 30s is generous for NTP-synced clocks; a deployment with poor time sync
 * should widen it explicitly — and understand that it widens the replay window by the same
 * amount unless the dedup TTL is widened with it.
 */
export function validateTimestamp(ts: number, maxDriftMs = 30_000): boolean {
	return Math.abs(Date.now() - ts) <= maxDriftMs;
}

/**
 * True for a circuit-relay ("limited") connection. libp2p stamps a relayed
 * connection with `limits` (per-circuit data/duration caps); we additionally
 * sniff the multiaddr for `/p2p-circuit` as a fallback for transports/versions
 * that don't populate `limits`.
 */
export function isLimitedConnection(c: Connection): boolean {
	if ((c as { limits?: unknown }).limits != null) return true;
	const addr = c.remoteAddr?.toString?.();
	return addr != null && addr.includes('/p2p-circuit');
}

/**
 * Open an RPC stream to `pid`, preferring a DIRECT open connection and falling
 * back to a limited (circuit-relay) one.
 *
 * `runOnLimitedConnection: true` is REQUIRED for the relayed path — libp2p
 * rejects a stream over a limited connection without it — and is a harmless
 * no-op on a direct connection. Preferring a direct connection avoids riding a
 * circuit that the relay can reset once a per-circuit cap or reservation lapses
 * (and which briefly coexists with the upgraded direct link after DCUtR).
 *
 * When `requireExisting` is set the caller skips dialing if no connection
 * exists (neighbors fetch/announce reduce churn this way) and `undefined` is
 * returned; otherwise we `dialProtocol`.
 */
export async function openRpcStream(
	node: Libp2p,
	pid: PeerId,
	protocols: string[],
	opts: { requireExisting?: boolean } = {}
): Promise<Stream | undefined> {
	const open = node.getConnections(pid)
		.filter(c => c?.status === 'open' && typeof c?.newStream === 'function');
	// Prefer a direct connection; fall back to the limited one only when it is
	// the only open path (the steady state for browsers and NATed peers).
	const chosen = open.find(c => !isLimitedConnection(c)) ?? open[0];
	const streamOpts = { runOnLimitedConnection: true, negotiateFully: false } as const;
	if (chosen) return chosen.newStream(protocols, streamOpts);
	if (opts.requireExisting) return undefined;
	return node.dialProtocol(pid, protocols, streamOpts);
}
