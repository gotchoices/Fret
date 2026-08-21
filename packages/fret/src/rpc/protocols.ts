import type { Libp2p } from 'libp2p';
import type { Connection, NewStreamOptions, PeerId, Stream } from '@libp2p/interface';
import * as lp from 'it-length-prefixed';
import { byteStream } from '@libp2p/utils';
import { decode as decodeVarint } from 'uint8-varint';
import type { Uint8ArrayList } from 'uint8arraylist';
import type { Deadline } from '../utils/deadline.js';
import { abortReasonError, deadline } from '../utils/deadline.js';
import { createLogger } from '../logger.js';
// Type-only: `protocols` -> `validate` -> `leave` -> `protocols` is a compile-time cycle that
// must not become a runtime one (`validate.ts` imports `LeaveNoticeV1` type-only for the same
// reason).
import type { Parser } from './validate.js';

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

/** Network-namespaced protocol id set produced by {@link makeProtocols}. */
export type FretProtocols = ReturnType<typeof makeProtocols>;

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
 * Success path: the seam performs the close, and no FRET handler body closes for itself — a bare
 * `close()` in a handler is unbounded against a remote that accepts the reply and stops reading,
 * which would pre-empt the budget below and leave the slow-loris hole this seam exists to shut.
 * An *external* consumer of this exported seam may still close for itself; `close()` early-returns
 * once our write end is closing/closed, so the budgeted close is then a no-op rather than a second
 * release. `status` cannot stand in for that test: a half-closed stream stays `'open'` until the
 * *remote* also closes its write end, which for every FRET sender happens only after it has read
 * the reply — the write-end status is the load-bearing one, and it is what the error arm reads.
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
 * A close that expires its budget and a handler body that threw both land in the same catch arm,
 * but they call for opposite operator responses — "the peer accepted our reply and stopped
 * reading" is a remote-behavior signal, while "the handler threw" is ours — so they log
 * distinctly. The discriminator is the budget's own signal rather than the error's identity:
 * libp2p's `close()` rejects with whatever its internal `pEvent` turns the abort into, so
 * matching on {@link DeadlineExpiredError} would depend on a wrapping detail we do not own.
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
		let closeBudget: Deadline | undefined;
		try {
			await serve(stream, connection);
			// NOTE: this arms an AbortController + setTimeout for every inbound message on every
			// protocol. It is load-bearing (no handler body closes for itself any more), but it is
			// still a per-message allocation; if inbound cost ever shows up in a profile, measure
			// the timer churn before the handler bodies and consider one shared timer wheel.
			closeBudget = deadline(closeBudgetMs);
			try {
				await stream.close({ signal: closeBudget.signal });
			} finally {
				// Mandatory: an uncleared timer fails the repo's mocha exit watchdog.
				closeBudget.cancel();
			}
		} catch (err) {
			if (closeBudget?.signal.aborted === true) {
				log.error('%s reply close exceeded %dms budget - remote stopped reading, aborting stream', protocol, closeBudgetMs);
			} else {
				log.error('%s handler error - %e', protocol, err);
			}
			if (stream.status === 'open' && stream.writeStatus !== 'closed') {
				try { stream.abort(err instanceof Error ? err : new Error(String(err))); } catch { /* best effort */ }
			}
		}
	});
}

/**
 * Options for a JSON protocol that reads a request body: decode it, run it through a parser from
 * `src/rpc/validate.ts`, then answer (or drop).
 */
export interface JsonRequestHandlerOpts<Req, Res> {
	/** Per-message byte cap, enforced by {@link readFramed} at the length prefix. */
	maxBytes: number;
	parse: Parser<Req>;
	/** Return `undefined` to drop without replying (the identity-mismatch case). */
	serve: (msg: Req, connection: Connection) => Promise<Res | undefined> | Res | undefined;
	/** Counter hook for a body-level drop; the service wires it to `diag.rejected.malformed`. */
	onMalformed?: (reason: 'decode' | 'parse') => void;
	/** Test-only pass-through to {@link registerRpcHandler}; no production caller sets it. */
	closeBudgetMs?: number;
}

/** Options for a JSON protocol that reads no request body at all — it only answers. */
export interface JsonReplyOnlyHandlerOpts<Res> {
	serve: (connection: Connection) => Promise<Res> | Res;
	closeBudgetMs?: number;
}

/**
 * Register an inbound handler for a JSON protocol: read the framed body, decode it, hand it to a
 * parser, and frame the reply — one seam, stacked on top of {@link registerRpcHandler}, which
 * still owns the budgeted success close and the synchronous error `abort()`.
 *
 * **The drop/abort rule, stated once here instead of per handler.**
 * - *Frame-level failure aborts.* Truncation, {@link PayloadTooLargeError}, a reset — the stream
 *   is already broken, or the remote is misbehaving at the framing layer. These propagate out of
 *   this seam into `registerRpcHandler`'s error arm, which aborts, exactly as before.
 * - *Body-level failure closes.* Undecodable JSON, a non-object top level, a parser rejection, an
 *   identity mismatch (`serve` returning `undefined`). The peer framed correctly and is alive;
 *   the message is worthless. The handler returns normally without replying, so the seam's
 *   budgeted `close()` runs — and `onMalformed` has already counted the drop. This is the plan's
 *   "a validator failure must be a drop, never an abort", and it subsumes the pre-existing
 *   identity-mismatch behavior rather than adding a second path beside it.
 *
 * Two overloads, because two of the five FRET protocols read no request body (ping, and the
 * neighbors *request*): forcing a body-less protocol through a decode step would be worse than
 * the repetition it removes. `'parse' in opts` is the discriminator — the reply-only shape has no
 * `parse` key, so TypeScript narrows on it.
 *
 * maybeAct is deliberately **not** on this seam: its rate-limit bucket must be taken before any
 * per-message work, and this seam parses inside the handler body. See the `NOTE:` at its
 * registration in `FretService.registerRpcHandlers`.
 */
export function registerJsonHandler<Req, Res>(node: Libp2p, protocol: string, opts: JsonRequestHandlerOpts<Req, Res>): Promise<void>;
export function registerJsonHandler<Res>(node: Libp2p, protocol: string, opts: JsonReplyOnlyHandlerOpts<Res>): Promise<void>;
export function registerJsonHandler(
	node: Libp2p,
	protocol: string,
	opts: JsonRequestHandlerOpts<unknown, unknown> | JsonReplyOnlyHandlerOpts<unknown>
): Promise<void> {
	return registerRpcHandler(node, protocol, async (stream, connection) => {
		if (!('parse' in opts)) {
			// Reply-only: reads no body at all, so there is nothing to decode or parse.
			sendFramed(stream, await encodeJson(await opts.serve(connection)));
			return;
		}
		// Frame-level failures propagate — see the abort half of the rule above.
		const bytes = await readFramed(stream, opts.maxBytes);
		let decoded: unknown;
		try {
			decoded = await decodeJson(bytes);
		} catch (err) {
			opts.onMalformed?.('decode');
			log.error('%s: undecodable body - dropping - %e', protocol, err);
			return;
		}
		const msg = opts.parse(decoded);
		if (msg === undefined) {
			opts.onMalformed?.('parse');
			log.error('%s: body rejected by parser - dropping', protocol);
			return;
		}
		const res = await opts.serve(msg, connection);
		// Drop without replying; the seam still closes.
		if (res === undefined) return;
		sendFramed(stream, await encodeJson(res));
	}, { closeBudgetMs: opts.closeBudgetMs });
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
 *     non-finite `ttl` / `want_k` / `min_sigs` / `timestamp` in `parseRouteAndMaybeAct`.
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
 * Single `send` on purpose — the prefix and body go out as one `Uint8ArrayList`, so a frame is
 * never split across two writes. The returned boolean is `stream.send`'s own "queue has room"
 * result, passed through: `false` means the write was accepted but the transport's buffer is
 * now full. `rpcRequest` honors it (waiting for `'drain'`, bounded by the RPC deadline signal);
 * the legacy senders still ignore it until `15.2b-rpc-sender-migration` moves them onto the
 * helper.
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
 * Thrown when a frame's declared length exceeds the caller's `maxBytes` cap — raised at the length
 * prefix, before any body byte is pulled. Stable `name` for cross-realm matching, exactly like
 * {@link FrameTruncationError}: without an identity, the only way to recognise this condition was
 * to match the message text, and a classifier that matches on text is one remote-influenced
 * message away from misclassifying.
 */
export class PayloadTooLargeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PayloadTooLargeError';
	}
}

/** True for {@link PayloadTooLargeError}. Matches by `name`, as {@link isFrameTruncationError} does. */
export function isPayloadTooLargeError(err: unknown): boolean {
	if (err == null || typeof err !== 'object') return false;
	return (err as { name?: unknown }).name === 'PayloadTooLargeError';
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

/**
 * Race sentinel for the caller's abort signal. The abort arm **resolves** with this rather than
 * rejecting, so an abort that loses the race can never surface as an unhandled rejection; the
 * reader turns the sentinel into a throw itself.
 */
const ABORTED = Symbol('readFramed.aborted');

/**
 * True when `stream` carries the full libp2p message-stream surface `readFramed`'s stream path
 * needs: the five functions `@libp2p/utils`'s stream helpers validate (`addEventListener`,
 * `removeEventListener`, `send`, `push`, `log`) plus `closeRead`, which its EOF detection reads —
 * a stream passing the first five but lacking `closeRead` would make `byteStream.read` hang until
 * the signal fires rather than throw on EOF. Everything else (test stubs, plain async iterables)
 * takes the iterable path.
 */
function isMessageStream(
	stream: AsyncIterable<Uint8Array | Uint8ArrayList>
): stream is AsyncIterable<Uint8Array | Uint8ArrayList> & Stream {
	const s = stream as Partial<Record<'closeRead' | 'addEventListener' | 'removeEventListener' | 'send' | 'push' | 'log', unknown>> | null;
	return typeof s?.closeRead === 'function'
		&& typeof s.addEventListener === 'function'
		&& typeof s.removeEventListener === 'function'
		&& typeof s.send === 'function'
		&& typeof s.push === 'function'
		&& typeof s.log === 'function';
}

/**
 * Stream-path read: one varint length prefix, then exactly that many body bytes, via
 * `@libp2p/utils`'s `byteStream` — which reads at the same layer the stream's own EOF state
 * lives at, so a frame the remote actually wrote is never reported as truncated (the invariant
 * the old poll loop violated; see {@link readFramed}).
 *
 * The prefix is read one byte at a time and decoded after each: `uint8-varint`'s `decode` throws
 * `RangeError` on a partial varint, so the loop stops at the first successful decode with the
 * buffer holding exactly the varint — no over-read to hand back. Nine prefix bytes without a
 * successful decode declare a length of at least 2^56, over every FRET cap, so the cap failure
 * is raised without waiting for more. The cap is still enforced at the prefix, before any body
 * byte is pulled.
 */
/**
 * NOTE: this hand-rolls the varint prefix loop that `@libp2p/utils`'s `lpStream` also implements,
 * and that duplication is deliberate. Three reasons, in order of weight: (1) the over-cap error
 * text is pinned by tests and names the *declared* length, which `lpStream` discards — it raises
 * `InvalidDataLengthError` carrying only its own wording, so using it means a `lengthDecoder` hook
 * to capture the length plus a catch-and-rewrite of its error; (2) `lpStream`'s prefix loop breaks
 * out on a null read leaving `dataLength` at −1 and then reads −1 bytes, so its clean-EOF-at-the-
 * prefix path is not one we want to depend on, where ours raises {@link FrameTruncationError}
 * there explicitly; (3) the 9-byte prefix short-circuit below is ours. Revisit if `lpStream` ever
 * surfaces the declared length on its error.
 *
 * NOTE: the prefix is read one byte per `await`, up to 9 awaits per frame. Unmeasured, and
 * `lpStream` reads the prefix the same way, so it is the library's shape too — the cost is
 * microtask turns against a network round trip. Revisit only if a profile shows framed reads
 * themselves as hot.
 */
async function readFramedFromStream(stream: Stream, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
	const bs = byteStream(stream);
	try {
		const prefix = new Uint8Array(9);
		let length = 0;
		let declared: number | undefined;
		while (declared === undefined) {
			let byte: Uint8ArrayList;
			try {
				byte = await bs.read({ bytes: 1, signal });
			} catch (err) {
				if ((err as { name?: unknown } | null)?.name === 'UnexpectedEOFError') {
					throw new FrameTruncationError(length === 0
						? 'stream ended before a framed message arrived'
						: 'stream ended before a whole framed message arrived');
				}
				throw err;
			}
			prefix[length++] = byte.get(0);
			try {
				declared = decodeVarint(prefix.subarray(0, length));
			} catch (err) {
				if (!(err instanceof RangeError)) throw err;
				// Partial varint — keep reading. At 9 bytes the declared length is >= 2^56 whatever
				// the remaining bytes say, so it can only ever fail the cap below.
				if (length >= 9) {
					throw new PayloadTooLargeError(`payload too large: declared length exceeds ${maxBytes} byte limit`);
				}
			}
		}
		if (declared > maxBytes) {
			throw new PayloadTooLargeError(`payload too large: ${declared} exceeds ${maxBytes} byte limit`);
		}
		// An empty frame is valid here; `decodeJson`'s `empty response` rejection covers it downstream.
		if (declared === 0) return new Uint8Array(0);
		// A body that ends early throws `UnexpectedEOFError`, which propagates unchanged —
		// `isFrameTruncationError` already matches that name.
		return (await bs.read({ bytes: declared, signal })).subarray();
	} finally {
		// `unwrap()` pushes unread trailing bytes back via `stream.push()`, which throws
		// `StreamStateError` when the read side is already closed — listeners are removed before
		// the push, so swallowing is safe.
		try { bs.unwrap(); } catch { /* stream already closed; nothing to hand back */ }
	}
}

/**
 * Iterable-path read for plain async iterables (tests, non-libp2p sources): `lp.decode` with the
 * cap enforced in its `onLength` hook, one read issued and held, raced against the abort signal.
 * No stream state exists to consult, so the read ends on iterator EOF alone.
 */
async function readFramedFromIterable(
	stream: AsyncIterable<Uint8Array | Uint8ArrayList>,
	maxBytes: number,
	signal: AbortSignal
): Promise<Uint8Array> {
	const source = lp.decode(stream, {
		maxDataLength: Number.MAX_SAFE_INTEGER,
		onLength: (declared) => {
			if (declared > maxBytes) {
				throw new PayloadTooLargeError(`payload too large: ${declared} exceeds ${maxBytes} byte limit`);
			}
		},
	});
	const iter = source[Symbol.asyncIterator]();

	let onAbort: (() => void) | undefined;
	const abortWait = new Promise<typeof ABORTED>((resolve) => {
		onAbort = () => resolve(ABORTED);
		signal.addEventListener('abort', onAbort, { once: true });
	});

	// Issued once and held: re-calling `iter.next()` would queue a second read and silently drop
	// whichever bytes the abandoned one consumes.
	const pending = iter.next();
	// Belt-and-braces against an unhandled rejection when the abort sentinel wins and `pending`
	// is abandoned. NOTE: not load-bearing today — the `Promise.race` below attaches its own
	// reject reaction — but it stops mattering only for as long as the read promise is raced;
	// keep it if that race is ever restructured.
	pending.catch(() => {});

	try {
		let result: IteratorResult<Uint8ArrayList> | typeof ABORTED;
		try {
			result = await Promise.race([pending, abortWait]);
		} catch (err) {
			// Defensive: an 8-byte varint declaring past 2^53 trips the library's own check before
			// `onLength` can see the length; report it as the same over-cap failure.
			if ((err as { name?: unknown } | null)?.name === 'InvalidDataLengthError') {
				throw new PayloadTooLargeError(`payload too large: declared length exceeds ${maxBytes} byte limit`);
			}
			// Everything else — UnexpectedEOFError, InvalidDataLengthLengthError, the `onLength`
			// cap above, source/reset errors — propagates unchanged.
			throw err;
		}
		if (result === ABORTED) throw abortReasonError(signal);
		if (result.done === true) {
			throw new FrameTruncationError('stream ended before a framed message arrived');
		}
		return result.value.subarray();
	} finally {
		// One listener per read; without this a long-lived run signal accumulates one per RPC.
		if (onAbort != null) signal.removeEventListener('abort', onAbort);
	}
}

/** Fresh read of `s?.aborted` behind a call boundary, so flow narrowing cannot pin its value. */
function signalFired(s: AbortSignal | undefined): boolean {
	return s?.aborted === true;
}

/**
 * Read exactly one length-prefixed message, bounded by `maxBytes` and a single overall
 * `timeoutMs` deadline.
 *
 * **Invariant: a frame the remote actually wrote is never reported as truncated.** Two
 * implementations behind this one signature uphold it, dispatched on what `stream` is
 * ({@link isMessageStream}):
 *
 * - A **libp2p stream** is read through `@libp2p/utils`'s `byteStream`, which reads frames at the
 *   same layer as the stream's own EOF state — one buffer, no timer, no blind spot.
 *   `read({ bytes })` either returns the requested bytes or throws `UnexpectedEOFError` on a
 *   genuine end-of-stream, so end-of-stream is recognised by the reader itself rather than
 *   cross-checked from outside. (The previous implementation polled stream-level EOF state every
 *   20 ms while delivered bytes could still sit in two buffers *below* that state — libp2p's
 *   stream-iterator queue and `lp.decode`'s accumulator — so it could raise
 *   {@link FrameTruncationError} on a healthy connection carrying a complete reply.)
 * - A **plain async iterable** (test stubs, non-libp2p sources) keeps the `lp.decode` path and
 *   ends on iterator EOF alone — no stream state exists to consult, and none is.
 *
 * On both paths the declared-length cap is enforced at the length prefix, before any body byte
 * is pulled: an over-declared message costs the receiver the prefix, never the body.
 *
 * There is deliberately no *idle* timer — a gap between chunks means a slow link, not
 * end-of-stream — and only the overall deadline bounds a peer that stalls mid-payload.
 *
 * NOTE: an inbound handler holds a stalled stream for the full `timeoutMs` (5s default) rather
 * than failing fast, bounded by the per-profile inbound stream caps. If slow-loris pressure ever
 * shows up, give handlers a shorter read deadline — do not reintroduce an idle timer.
 *
 * `opts.signal` cancels the read from outside, on exactly the same contract as the deadline.
 *
 * `timeoutMs === Infinity` means "no independent clock — bounded by `opts.signal` alone", and
 * `opts.signal` is then **required**: an unbounded read with nothing to end it is a caller bug
 * that presents as a hang, so it throws at entry instead. This exists so a caller that already
 * arms a `deadline()` around the whole RPC can hand that deadline's signal down as the *only*
 * clock: arming a second timer from the same `timeoutMs` makes which error surfaces (and which
 * release arm runs) a race between two timers that expire a tick apart. The default stays
 * {@link RPC_TIMEOUT_MS} for direct users of this pinned public export.
 *
 * @throws {FrameTruncationError} when the source genuinely ends before a whole framed message
 * arrived — including a clean close right after the prefix.
 * @throws at entry if `timeoutMs` is not a positive number or `Infinity` — `NaN`, `0` and
 * negatives are not budgets, and this is an exported entry point a consumer can compute a
 * timeout for.
 * @throws {PayloadTooLargeError} when the declared length exceeds `maxBytes`, raised at the
 * prefix before any body byte is pulled.
 * @throws if the deadline expires or `opts.signal` aborts — a partial read is an error, never a
 * short-but-valid result. An empty frame (prefix `0x00`) is *not* an error here: it returns an
 * empty buffer, and `decodeJson`'s own `empty response` rejection covers it downstream.
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
	// `!(x > 0)` rather than `x <= 0`, so it also catches NaN. Infinity passes, which is the mode
	// documented above.
	if (!(timeoutMs > 0)) {
		throw new Error(`readFramed: timeoutMs must be a positive number or Infinity, got ${timeoutMs}`);
	}
	if (signal?.aborted === true) throw abortReasonError(signal);

	// Finite mode arms one deadline (a child of the caller's signal); Infinity mode reads under
	// the caller's signal alone. Either way exactly one clock bounds the read.
	const d = timeoutMs === Infinity ? undefined : deadline(timeoutMs, signal);
	const readSignal = d?.signal ?? signal!;
	try {
		return isMessageStream(stream)
			? await readFramedFromStream(stream, maxBytes, readSignal)
			: await readFramedFromIterable(stream, maxBytes, readSignal);
	} catch (err) {
		// The caller's own signal wins the attribution; only the deadline's solo expiry is a
		// read timeout. Read through a call so TS does not carry the entry check's narrowing of
		// the readonly `aborted` here — it flips mid-read, which flow analysis cannot see.
		// NOTE: this rewrites *every* error, `PayloadTooLargeError` and `FrameTruncationError`
		// included, when a signal has fired. Reaching that needs the abort to land between the
		// throw and this catch — a window spanning microtasks only, while a signal fires from a
		// macrotask (timer or external abort), so a read that is decoding a prefix cannot be
		// interrupted there; a signal firing while a read is genuinely pending rejects that read
		// instead, and lands here as an abort with nothing to overwrite. Where it is reachable at
		// all, cancellation-wins is the intended semantic: a cancelled caller does not care what
		// size the frame declared. Revisit if a signal is ever aborted from inside this call's
		// own microtask chain.
		if (signalFired(signal)) throw abortReasonError(signal!);
		if (signalFired(d?.signal)) throw new Error(`read timed out after ${timeoutMs}ms`);
		throw err;
	} finally {
		d?.cancel();
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
// NOTE: the release-before-cancel ordering above is a prose rule, not an enforced one — a sender
// that calls `d.cancel()` first still compiles, still passes, and silently loses the bound on the
// close (the signal handed here can no longer fire). All five senders get it right today; if a
// sixth is added, or one is reordered, consider taking the `Deadline` itself here so the cancel
// cannot precede the release.
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
