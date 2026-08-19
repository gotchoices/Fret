import type { Libp2p } from 'libp2p';
import type { Connection, NewStreamOptions, PeerId, Stream } from '@libp2p/interface';
import * as lp from 'it-length-prefixed';
import type { Uint8ArrayList } from 'uint8arraylist';
import { abortReasonError, deadline } from '../utils/deadline.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:handler');

/**
 * Default budget for one whole outbound RPC — dial + stream open + write + read.
 *
 * Historically this bounded the *read* alone, so a peer that accepted a connection but never
 * answered, or was slow to connect in the first place, held the caller open indefinitely. The
 * magnitude is unchanged; what changed is its scope.
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
 *
 * The success-path close carries its own budget (`opts.closeBudgetMs`, default
 * {@link RPC_TIMEOUT_MS}). `close()` resolves only once the reply has reached the transport, so a
 * remote that accepts the stream and stops reading would otherwise hold this handler — and its
 * stream slot — open forever: the write-side twin of the read-side slow-loris note on
 * `readFramed`. When that budget expires the close rejects into the catch arm below with the
 * stream's write end at `'closing'` rather than `'closed'`, so the abort runs and the slot is
 * reclaimed. Reclaiming it destroys the undelivered reply, which is the right trade: the close
 * never completed, so that reply was never committed, and the remote was not reading it anyway.
 *
 * `opts.closeBudgetMs` exists so a test need not spend the full default per case; there is no
 * production caller that overrides it.
 */
export async function registerRpcHandler(
	node: Libp2p,
	protocol: string,
	serve: (stream: Stream, connection: Connection) => Promise<void>,
	opts: { closeBudgetMs?: number } = {}
): Promise<void> {
	const closeBudgetMs = opts.closeBudgetMs ?? RPC_TIMEOUT_MS;
	await node.handle(protocol, async (stream: Stream, connection: Connection) => {
		try {
			await serve(stream, connection);
			const d = deadline(closeBudgetMs);
			try {
				await stream.close({ signal: d.signal });
			} finally {
				// Mandatory: an uncleared timer fails the repo's mocha exit watchdog.
				d.cancel();
			}
		} catch (err) {
			log.error('%s handler error - %e', protocol, err);
			if (stream.status === 'open' && stream.writeStatus !== 'closed') {
				try { stream.abort(err instanceof Error ? err : new Error(String(err))); } catch { /* best effort */ }
			}
		}
	});
}

/**
 * Encode a message as UTF-8 JSON.
 *
 * NOTE: three values do not survive the round trip, and each is pinned as today's contract by
 * `test/rpc.codec-properties.spec.ts` rather than worked around here — a codec that preserved
 * them would have to stop being JSON:
 *   - `-0` arrives as `0`. No FRET field distinguishes them (relevance, latency and estimates are
 *     all magnitudes); revisit only if a field ever needs signed zero.
 *   - `NaN` / `±Infinity` arrive as `null`. Unreachable from routing logic, which rejects a
 *     non-finite `ttl` / `want_k` / `min_sigs` / `timestamp` in `validateRouteAndMaybeAct`.
 *   - An own property whose value is `undefined` is dropped, so `undefined` can only ever mean
 *     "absent" on the wire. `null` is the value that round-trips.
 * Everything else the wire formats admit is lossless, lone surrogates included (`JSON.stringify`
 * is well-formed since ES2019, so an unpaired code unit is escaped rather than mangled by UTF-8).
 */
export async function encodeJson(obj: unknown): Promise<Uint8Array> {
	const text = JSON.stringify(obj);
	return new TextEncoder().encode(text);
}

export async function decodeJson<T = unknown>(bytes: Uint8Array): Promise<T> {
	// guard against binary frames or empty buffers
	if (bytes.byteLength === 0) throw new Error('empty response');
	// Interop-defensive trim: with length-prefix framing the reader hands over exactly the
	// counted body, so padding can only come from a sender that framed it INSIDE the count
	// (e.g. `JSON + "\n"`) — no longer from a padding muxer.
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

/**
 * Write one length-prefixed message: a varint byte count, then exactly that many body bytes.
 * The receiver (`readFramed`) reads the count and hands over exactly that body, so end-of-message
 * is carried in-band rather than inferred from stream close.
 *
 * Single `send` on purpose — the prefix and body go out as one `Uint8ArrayList` — and write
 * backpressure is deliberately out of scope here (owned by the follow-up write-backpressure
 * ticket); the boolean is `stream.send`'s own "queue has room" result, passed through.
 */
export function sendFramed(stream: Stream, body: Uint8Array): boolean {
	return stream.send(lp.encode.single(body));
}

/**
 * Thrown when the source ends before one whole framed message arrived — including the case where
 * the varint prefix was consumed and the remote then closed cleanly without sending the body
 * (which the decoder itself completes silently on). Stable `name` for cross-realm matching.
 */
export class FrameTruncationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FrameTruncationError';
	}
}

/**
 * True for {@link FrameTruncationError}, or for `it-length-prefixed`'s `UnexpectedEOFError`
 * (a partial varint or partial body still buffered at EOF). The library's error classes are not
 * importable — its `exports` map exposes only `decode`/`encode` — so this matches by `err.name`,
 * the same style as {@link isUnsupportedProtocolError}.
 */
export function isFrameTruncationError(err: unknown): boolean {
	if (err == null || typeof err !== 'object') return false;
	const name = (err as { name?: unknown }).name;
	return name === 'FrameTruncationError' || name === 'UnexpectedEOFError';
}

/** Race sentinel — distinct from a real `IteratorResult`, so a poll tick is never read as EOF. */
const POLL_TICK = Symbol('readFramed.poll');

/**
 * Race sentinel for the caller's abort signal. The abort arm **resolves** with this rather than
 * rejecting, so an abort that loses the race can never surface as an unhandled rejection; the
 * reader turns the sentinel into a throw itself.
 */
const ABORTED = Symbol('readFramed.aborted');

/**
 * How often to re-check the stream's own end-of-read state; see {@link remoteFinishedWriting}.
 *
 * NOTE: this adds up to one poll interval to every RPC that hits the lost-event case, which is a
 * floor under the measured ping RTT that feeds peer health scoring. The durable fix is to
 * subscribe to the stream before writing, so the event is never missed at all (iterator priming);
 * revisit this constant if RTT-derived scoring ever needs finer resolution than this floor allows.
 */
const EOF_POLL_MS = 20;

/**
 * The subset of libp2p's `MessageStream`/`Stream` state we consult to recognise an end-of-stream
 * whose event we never received. Every field is optional because `readFramed` also accepts plain
 * async iterables (tests, non-libp2p sources), which carry none of them.
 */
interface ReadEndState {
	readBufferLength?: number;
	remoteWriteStatus?: string;
	readStatus?: string;
}

/**
 * True when the remote has closed its writing end AND everything it sent has been drained — so no
 * further byte can arrive, and a frame still incomplete at this point never completes.
 *
 * libp2p's async-iterator adaptor ends its iteration off the one-shot `remoteCloseWrite` / `close`
 * events, which it subscribes to when iteration *starts*. Every FRET RPC opens a stream, writes,
 * and only then begins reading, so a fast responder routinely closes before that subscription
 * exists and the event is lost. The buffered bytes are still delivered (message dispatch is
 * deferred until a listener attaches), but the adaptor then marks the read closed *silently* — no
 * second event — so the iterator never yields `done` and the read runs to its full deadline.
 * Polling the stream's own state recovers that case without ever guessing: a stream that is merely
 * slow reports neither a closed remote nor an empty-and-final buffer, so it keeps being read.
 *
 * Returns false for a plain async iterable (no state to consult), leaving those callers on
 * ordinary iterator EOF.
 */
function remoteFinishedWriting(stream: unknown): boolean {
	const s = stream as ReadEndState | null;
	if (typeof s?.readBufferLength !== 'number') return false;
	if (s.readBufferLength > 0) return false;
	return s.remoteWriteStatus === 'closed' || s.readStatus === 'closed';
}

/**
 * Read exactly one length-prefixed message, bounded by `maxBytes` and a single overall
 * `timeoutMs` deadline.
 *
 * The declared-length cap is enforced in the decoder's `onLength` hook — which fires the moment
 * the varint prefix is consumed, before any body byte is pulled — rather than via the library's
 * own `maxDataLength` check, which throws *before* the prefix is consumed and so cannot report
 * the declared length. Either way an over-declared message costs the receiver the prefix, never
 * the body.
 *
 * There is deliberately no *idle* timer — a gap between chunks means a slow link, not
 * end-of-stream — and only the overall deadline bounds a peer that stalls mid-payload.
 *
 * End-of-*message* is carried in the length prefix, so the reader never waits on end-of-stream to
 * delimit a message. End-of-*stream* still has to be recognised, though, or a truncated reply is
 * indistinguishable from a slow one: the read is therefore a poll loop that re-checks
 * {@link remoteFinishedWriting} every {@link EOF_POLL_MS}, and turns a confirmed end into
 * {@link FrameTruncationError} rather than sitting out the deadline. The check is race-free
 * because the poll fires on a macrotask at least one interval after any message dispatch, so every
 * microtask behind it (stream iterator → `lp.decode` → the pending read) has already drained: if
 * the stream reports its read closed — which it does only once the read buffer is fully dispatched
 * *and* the remote's write end is closed — while the pending read is still unresolved, the bytes
 * delivered could not complete a frame. The deadline is enforced at the top of each pass and the
 * poll interval is capped at whatever remains, so the loop overshoots it by no more than one tick.
 *
 * NOTE: an inbound handler holds a stalled stream for the full `timeoutMs` (5s default) rather
 * than failing fast, bounded by the per-profile inbound stream caps. If slow-loris pressure ever
 * shows up, give handlers a shorter read deadline — do not reintroduce an idle timer.
 *
 * `opts.signal` cancels the read from outside, on exactly the same contract as the deadline.
 *
 * `timeoutMs === Infinity` means "no independent clock — bounded by `opts.signal` alone", and
 * `opts.signal` is then **required**: an unbounded read with nothing to end it is a caller bug
 * that presents as a hang, so it throws at entry instead. Every other part of the loop already
 * copes — `remaining` is `Infinity`, so it is never `<= 0`, the poll interval still comes out at
 * {@link EOF_POLL_MS}, and the `read timed out` throw below is simply unreachable. This exists so
 * a caller that already arms a `deadline()` around the whole RPC can hand that deadline's signal
 * down as the *only* clock: arming a second timer from the same `timeoutMs` makes which error
 * surfaces (and which release arm runs) a race between two timers that expire a tick apart.
 * The default stays {@link RPC_TIMEOUT_MS} for direct users of this pinned public export.
 *
 * @throws {FrameTruncationError} when the source ends before a whole framed message arrived —
 * including a clean close right after the prefix, which the decoder completes silently on.
 * @throws if the deadline expires, `opts.signal` aborts, or the declared length exceeds
 * `maxBytes` — a partial read is an error, never a short-but-valid result. An empty frame
 * (prefix `0x00`) is *not* an error here: it returns an empty buffer, and `decodeJson`'s own
 * `empty response` rejection covers it downstream.
 */
export async function readFramed(
	stream: AsyncIterable<Uint8Array | Uint8ArrayList>,
	maxBytes: number,
	timeoutMs = RPC_TIMEOUT_MS,
	opts: { signal?: AbortSignal } = {}
): Promise<Uint8Array> {
	const signal = opts.signal;
	if (timeoutMs === Infinity && signal == null) {
		throw new Error('readFramed: timeoutMs of Infinity requires opts.signal — an unbounded read never ends');
	}
	if (signal?.aborted === true) throw abortReasonError(signal);

	const source = lp.decode(stream, {
		maxDataLength: Number.MAX_SAFE_INTEGER,
		onLength: (declared) => {
			if (declared > maxBytes) {
				throw new Error(`payload too large: ${declared} exceeds ${maxBytes} byte limit`);
			}
		},
	});
	const iter = source[Symbol.asyncIterator]();

	let onAbort: (() => void) | undefined;
	const abortWait = signal == null
		? undefined
		: new Promise<typeof ABORTED>((resolve) => {
			onAbort = () => resolve(ABORTED);
			signal.addEventListener('abort', onAbort, { once: true });
		});

	const deadlineAt = Date.now() + timeoutMs;
	// Issued once and held across poll ticks: re-calling `iter.next()` would queue a second read
	// and silently drop whichever bytes the abandoned one consumes.
	const pending = iter.next();
	// Belt-and-braces against an unhandled rejection when a sentinel wins and `pending` is
	// abandoned. NOTE: not load-bearing today — the `Promise.race` below attaches its own
	// reject reaction to `pending` — but it stops mattering only for as long as the read
	// promise is raced; keep it if that race is ever restructured.
	pending.catch(() => {});
	type RaceResult = IteratorResult<Uint8ArrayList> | typeof POLL_TICK | typeof ABORTED;

	try {
		while (true) {
			const remaining = deadlineAt - Date.now();
			if (remaining <= 0) throw new Error(`read timed out after ${timeoutMs}ms`);

			let timer: ReturnType<typeof setTimeout> | undefined;
			const poll = new Promise<typeof POLL_TICK>((resolve) => {
				timer = setTimeout(() => resolve(POLL_TICK), Math.min(remaining, EOF_POLL_MS));
			});
			const racers: Array<Promise<RaceResult>> = [pending, poll];
			if (abortWait != null) racers.push(abortWait);
			let result: RaceResult;
			try {
				result = await Promise.race<RaceResult>(racers);
			} catch (err) {
				// Defensive: an 8-byte varint declaring past 2^53 trips the library's own check before
				// `onLength` can see the length; report it as the same over-cap failure.
				if ((err as { name?: unknown } | null)?.name === 'InvalidDataLengthError') {
					throw new Error(`payload too large: declared length exceeds ${maxBytes} byte limit`);
				}
				// Everything else — UnexpectedEOFError, InvalidDataLengthLengthError, the `onLength`
				// cap above, source/reset errors — propagates unchanged.
				throw err;
			} finally {
				clearTimeout(timer);
			}

			if (result === ABORTED) throw abortReasonError(signal!);
			if (result === POLL_TICK) {
				if (remoteFinishedWriting(stream)) {
					throw new FrameTruncationError('stream ended before a whole framed message arrived');
				}
				continue; // still open — keep waiting on `pending`, bounded only by the deadline
			}
			if (result.done === true) {
				throw new FrameTruncationError('stream ended before a framed message arrived');
			}
			return result.value.subarray();
		}
	} finally {
		// One listener per read; without this a long-lived run signal accumulates one per RPC.
		if (onAbort != null && signal != null) signal.removeEventListener('abort', onAbort);
	}
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
 *
 * `negotiateFully: false` is not optional here, and it is the one caveat for a consumer using
 * this from the package root: it saves a round trip but defers an unsupported-protocol failure
 * from stream-open to the first read, so a *fire-and-forget* send that never reads is a silent
 * no-op against a peer lacking the protocol. Every FRET sender reads a reply, so the deferred
 * failure always surfaces; a caller that does not read must treat "opened" as "not yet
 * negotiated". Pair every successful open with {@link releaseRpcStream}, which is exported
 * alongside this function — `close()` alone is unbounded against a stalled remote.
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
 * The close on the un-aborted path is itself bounded by `signal`. `Stream.close()` resolves only
 * once pending data has reached the transport, so a peer that accepts a stream and then stops
 * reading holds this call open with no budget of its own — worst case on the shutdown path, where
 * the leave fan-out's entire reason for a budget is a bounded `stop()`. Passing the signal costs
 * nothing and is only meaningful because of an **ordering** every caller must preserve: release
 * runs from a `finally` *before* `d.cancel()`, so the deadline is still live at this point. Cancel
 * first and the signal handed here can never fire, and the bound is silently gone.
 *
 * A bounded close that rejects (the signal fired mid-close, or the transport failed it) has not
 * released the stream — bounding the wait would otherwise free the *caller* and leak the stream
 * slot, which is the ceiling above by another route. So that arm falls through to the same
 * `abort()` the already-aborted path uses.
 *
 * All arms are best-effort: this runs from a `finally` on an already-failing path, where a
 * second throw would mask the real error.
 */
export async function releaseRpcStream(stream: Stream | undefined, signal: AbortSignal): Promise<void> {
	if (stream == null) return;
	if (signal.aborted) {
		try { stream.abort(abortReasonError(signal)); } catch { /* best effort */ }
		return;
	}
	try {
		await stream.close({ signal });
	} catch (err) {
		const reason = signal.aborted
			? abortReasonError(signal)
			: (err instanceof Error ? err : new Error(String(err)));
		try { stream.abort(reason); } catch { /* best effort */ }
	}
}
