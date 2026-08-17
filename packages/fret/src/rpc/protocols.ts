import type { Libp2p } from 'libp2p';
import type { Connection, NewStreamOptions, PeerId, Stream } from '@libp2p/interface';
import { abortReasonError } from '../utils/deadline.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:handler');

/**
 * Default budget for one whole outbound RPC — dial + stream open + write + read.
 *
 * Historically this was `readAllBounded`'s own default and bounded the *read* alone, so a peer
 * that accepted a connection but never answered, or was slow to connect in the first place,
 * held the caller open indefinitely. The magnitude is unchanged; what changed is its scope.
 *
 * Exported so the four outbound RPC families cannot drift apart. Per-call-site overrides are
 * stated at the call site (see the maintenance-ping and announce budgets in `FretService`).
 */
export const RPC_TIMEOUT_MS = 5000;

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

/**
 * Register an inbound RPC handler whose stream is released on every path — the receive-side
 * mirror of the sender-side rule enforced by {@link releaseRpcStream}.
 *
 * Before this seam each handler carried its own `try/catch` that logged and returned, leaving
 * the inbound stream open forever on any throw (malformed JSON, a bad field deep in the body).
 * libp2p counts inbound streams *per protocol per connection* and FRET passes no
 * `maxInboundStreams`, so ~32 unparseable messages permanently consumed one protocol's slots on
 * that connection. Releasing here means a handler added later cannot forget to release, because
 * releasing is no longer the handler's job.
 *
 * Success path: `serve` normally closes on its own, and `close()` early-returns once our write
 * end is closing/closed, so calling it again is a no-op rather than a second release. `status`
 * cannot stand in for that test: a half-closed stream stays `'open'` until the *remote* also
 * closes its write end, which for every FRET sender happens only after it has read the reply.
 *
 * Error path: `abort()`, which is synchronous and safe against a stalled remote (same reasoning
 * as `releaseRpcStream`). It is skipped in two cases — a stream that already left `'open'`
 * (reset by the remote, which is usually how the error arrived), and one whose write end
 * `serve` already closed, because that reply is committed and a reset would destroy it.
 */
export async function registerRpcHandler(
	node: Libp2p,
	protocol: string,
	serve: (stream: Stream, connection: Connection) => Promise<void>
): Promise<void> {
	await node.handle(protocol, async (stream: Stream, connection: Connection) => {
		try {
			await serve(stream, connection);
			// NOTE: `close()` waits for the write queue to drain, so a remote that stops reading
			// holds this handler (and its stream slot) open with no budget of its own — the
			// write-side twin of the read-side slow-loris note on `readAllBounded`. Replies are
			// small enough to fit a muxer window today, so the wait is not reachable in practice;
			// if it ever is, pass an `AbortOptions` deadline here rather than skipping the close.
			await stream.close();
		} catch (err) {
			log.error('%s handler error - %e', protocol, err);
			if (stream.status === 'open' && stream.writeStatus !== 'closed') {
				try { stream.abort(err instanceof Error ? err : new Error(String(err))); } catch { /* best effort */ }
			}
		}
	});
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
	const parsed = JSON.parse(text) as unknown;
	// Every FRET wire message and reply is a JSON object, so a non-object top level (the
	// literal null, an array, a number, a string, a boolean) is malformed by definition.
	// Rejecting once here kills that whole class for every body-reading handler, instead of
	// asking each one to null-check what it decoded.
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('non-object JSON payload');
	}
	return parsed as T;
}

export function toBytes(chunk: Uint8Array | { subarray(): Uint8Array }): Uint8Array {
	if (chunk instanceof Uint8Array) return chunk;
	return chunk.subarray();
}

type StreamChunk = Uint8Array | { subarray(): Uint8Array };

/** Race sentinel — distinct from a real `IteratorResult`, so a poll tick is never read as EOF. */
const POLL_TICK = Symbol('readAllBounded.poll');

/**
 * Race sentinel for the caller's abort signal. The abort arm **resolves** with this rather than
 * rejecting, so an abort that loses the race can never surface as an unhandled rejection; the
 * loop turns the sentinel into a throw itself.
 */
const ABORTED = Symbol('readAllBounded.aborted');

/**
 * How often to re-check the stream's own end-of-read state; see {@link remoteFinishedWriting}.
 *
 * NOTE: this adds up to one poll interval to every RPC that hits the lost-event case,
 * which is a floor under the measured ping RTT that feeds peer health scoring. The
 * durable fix is to subscribe before writing so the event is never missed at all (see
 * the framing/iterator-priming arm on `tickets/plan/15-rpc-shared-helper`); revisit this
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
 * `opts.signal` cancels the read from outside, on exactly the same contract as the deadline —
 * so a caller that gave up never mistakes what it had already buffered for a whole message.
 *
 * @throws if the deadline expires, `opts.signal` aborts, or `maxBytes` is exceeded — a partial
 * read is an error, never a short-but-valid result, so callers report a timeout instead of the
 * malformed-JSON error a truncated buffer would produce downstream.
 */
export async function readAllBounded(
	stream: AsyncIterable<StreamChunk>,
	maxBytes: number,
	timeoutMs = RPC_TIMEOUT_MS,
	opts: { signal?: AbortSignal } = {}
): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	let len = 0;
	const iter = stream[Symbol.asyncIterator]();
	const deadline = Date.now() + timeoutMs;
	const timedOut = () => new Error(`read timed out after ${timeoutMs}ms (${len} bytes read)`);
	// Held across poll ticks: re-calling `iter.next()` would queue a second read and
	// silently drop whichever chunk the abandoned one consumes.
	let pending: Promise<IteratorResult<StreamChunk>> | undefined;
	const signal = opts.signal;
	let onAbort: (() => void) | undefined;
	// Armed only for a signal that is live *now*: an already-aborted one is caught by the loop's
	// own check on its first pass, before any read is queued.
	const abortWait = signal == null || signal.aborted
		? undefined
		: new Promise<typeof ABORTED>((resolve) => {
			onAbort = () => resolve(ABORTED);
			signal.addEventListener('abort', onAbort, { once: true });
		});

	try {
		while (true) {
			if (signal?.aborted === true) throw abortReasonError(signal);
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw timedOut();

			let timer: ReturnType<typeof setTimeout> | undefined;
			const poll = new Promise<typeof POLL_TICK>(r => {
				timer = setTimeout(() => r(POLL_TICK), Math.min(remaining, EOF_POLL_MS));
			});
			if (pending == null) {
				pending = iter.next();
				// Belt-and-braces against an unhandled rejection when the poll wins and `pending` is
				// abandoned. NOTE: not load-bearing today — the `Promise.race` below attaches its own
				// reject reaction to `pending` in this same iteration, so removing this line changes
				// nothing (measured: deleting it leaves `rpc.stream-errors.spec.ts` green). It is kept
				// because it stops mattering only for as long as every read promise is raced; keep it
				// if that race is ever restructured to skip an iteration.
				pending.catch(() => {});
			}
			type RaceResult = IteratorResult<StreamChunk> | typeof POLL_TICK | typeof ABORTED;
			const racers: Array<Promise<RaceResult>> = [pending, poll];
			if (abortWait != null) racers.push(abortWait);
			const result = await Promise.race<RaceResult>(racers);
			clearTimeout(timer);

			if (result === ABORTED) throw abortReasonError(signal!);
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
	} finally {
		// One listener per read; without this a long-lived run signal accumulates one per RPC.
		if (onAbort != null && signal != null) signal.removeEventListener('abort', onAbort);
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
 *
 * `opts.signal` bounds the open itself. Both `newStream` and `dialProtocol` take
 * `NewStreamOptions extends AbortOptions`; without it a dial that hangs — no address,
 * unresponsive transport, half-open TCP — hangs the caller with no budget at all. An
 * already-aborted signal throws here rather than dialing, so a `stop()` racing a
 * maintenance tick cannot still issue dials.
 */
export async function openRpcStream(
	node: Libp2p,
	pid: PeerId,
	protocols: string[],
	opts: { requireExisting?: boolean; signal?: AbortSignal } = {}
): Promise<Stream | undefined> {
	if (opts.signal?.aborted === true) throw abortReasonError(opts.signal);
	const open = node.getConnections(pid)
		.filter(c => c?.status === 'open' && typeof c?.newStream === 'function');
	// Prefer a direct connection; fall back to the limited one only when it is
	// the only open path (the steady state for browsers and NATed peers).
	const chosen = open.find(c => !isLimitedConnection(c)) ?? open[0];
	const streamOpts: NewStreamOptions = {
		runOnLimitedConnection: true,
		negotiateFully: false,
		signal: opts.signal,
	};
	if (chosen) return chosen.newStream(protocols, streamOpts);
	if (opts.requireExisting) return undefined;
	return node.dialProtocol(pid, protocols, streamOpts);
}

/**
 * Release an outbound RPC stream on the way out of a sender.
 *
 * On the success path `close()` is the right call and is awaited. On the failure path it is
 * not: `close()` on a stream whose remote has stalled is itself unbounded, so the *cleanup*
 * of a timed-out read would hang after the read's own deadline had already fired. `abort()`
 * is synchronous and releases the stream at once — which matters because outbound stream caps
 * are finite (libp2p's default 64 per protocol per connection; FRET passes no override), so a
 * leaked stream is a real ceiling rather than mere waste.
 *
 * Both arms are best-effort: this runs from a `finally` on an already-failing path, where a
 * second throw would mask the real error.
 */
export async function releaseRpcStream(stream: Stream | undefined, signal: AbortSignal): Promise<void> {
	if (stream == null) return;
	if (signal.aborted) {
		try { stream.abort(abortReasonError(signal)); } catch { /* best effort */ }
		return;
	}
	try { await stream.close(); } catch { /* best effort */ }
}
