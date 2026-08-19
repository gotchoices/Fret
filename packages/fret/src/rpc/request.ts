import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import {
	RPC_TIMEOUT_MS,
	decodeJson,
	encodeJson,
	isFrameTruncationError,
	isPayloadTooLargeError,
	isUnsupportedProtocolError,
	openRpcStream,
	readFramed,
	releaseRpcStream,
	sendFramed,
} from './protocols.js';
import { abortReasonError, deadline } from '../utils/deadline.js';
import type { RpcOutcome } from './outcome.js';
import type { BusyResponseV1 } from '../index.js';

/**
 * Default declared-length cap for a reply when the caller passes none: 64 KiB, the smallest
 * production per-protocol cap (neighbors on the Edge profile). Real callers pass their
 * protocol's own cap; this default only protects a direct consumer who forgot one.
 */
const DEFAULT_MAX_BYTES = 64 * 1024;

export interface RpcRequestOptions<T> {
	/** Whole-RPC budget: dial + open + write + read + close. Defaults to {@link RPC_TIMEOUT_MS}. */
	timeoutMs?: number;
	/** Caller's cancellation. The helper's deadline is a child of it. */
	signal?: AbortSignal;
	/** When may we dial? Replaces the `requireExisting` boolean at the call site. Default `'always'`. */
	dial?: 'never' | 'if-addressed' | 'always';
	/** Required for `dial: 'if-addressed'`; returning false yields `{ kind: 'skipped' }` with no dial. */
	isDialable?: (peerIdStr: string) => boolean;
	/**
	 * Declared-length cap for the reply, per protocol. Real callers pass their protocol's own
	 * cap; the 64 KiB default (the smallest production cap — neighbors on Edge) only protects a
	 * direct consumer who forgot one.
	 */
	maxBytes?: number;
	/**
	 * Body to write. Omit for a read-only request (the neighbors fetch). Presence is tested
	 * with `!== undefined`, matching the wire contract — `undefined` cannot travel as a value.
	 */
	body?: unknown;
	/**
	 * Absent → write-only: no reply is read and `ok.value` is `undefined`.
	 *
	 * A write-only request can therefore never observe `foreign-protocol`. `openRpcStream` pins
	 * `negotiateFully: false` (see its own caveat), so an `UnsupportedProtocolError` is deferred
	 * from the stream open to the first read — and this path returns `ok` right after the write,
	 * without ever reading. Sending to a peer that does not serve this network's protocol yields
	 * `ok` and produces no membership evidence.
	 */
	decode?: (bytes: Uint8Array) => T | Promise<T>;
	/** Half-close our write end before reading (the maybeAct flush). Default false. */
	halfCloseBeforeRead?: boolean;
}

function toError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}

/**
 * One classifier shared by the open, write and read phases — deliberately not per-phase.
 * `openRpcStream` pins `negotiateFully: false`, so an `UnsupportedProtocolError` is *deferred
 * from open to the first read*; a per-phase mapping that checked for it only at open would
 * classify that deferred failure `unreachable` and book a contact strike for what is membership
 * evidence. The error identities are disjoint per phase (truncation cannot happen at open), so
 * folding the checks is safe.
 *
 * Order matters: the caller's signal is checked first, so a cancellation is never dressed as a
 * network outcome — see the `cancelled` variant's doc comment on {@link RpcOutcome}.
 */
function classify(
	err: unknown,
	callerSignal: AbortSignal | undefined,
	deadlineSignal: AbortSignal
): RpcOutcome<never> {
	if (callerSignal?.aborted === true) return { kind: 'cancelled' };
	if (isUnsupportedProtocolError(err)) return { kind: 'foreign-protocol', error: toError(err) };
	if (isFrameTruncationError(err)) return { kind: 'decode-error', error: toError(err) };
	if (isPayloadTooLargeError(err)) return { kind: 'decode-error', error: toError(err) };
	if (deadlineSignal.aborted === true || (err as { name?: unknown } | null)?.name === 'DeadlineExpiredError') {
		return { kind: 'timeout' };
	}
	return { kind: 'unreachable', error: toError(err) };
}

/** The busy shape test `sendPing` uses, applied to the parsed reply before `decode` runs. */
function isBusyShape(res: unknown): res is BusyResponseV1 {
	return typeof res === 'object' && res !== null && 'busy' in res && (res as { busy?: unknown }).busy === true;
}

function drainCapable(stream: Stream): boolean {
	const s = stream as { writableNeedsDrain?: unknown; addEventListener?: unknown };
	return typeof s.writableNeedsDrain === 'boolean' && typeof s.addEventListener === 'function';
}

/**
 * One `'drain'` event or an abort, whichever first. Both listeners are removed in both arms,
 * and the rejection is created inside the awaited promise, so it cannot escape as an unhandled
 * rejection.
 */
function onceDrain(stream: Stream, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onDrain = (): void => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		};
		const onAbort = (): void => {
			stream.removeEventListener('drain', onDrain);
			reject(abortReasonError(signal));
		};
		stream.addEventListener('drain', onDrain, { once: true });
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Bounded wait for write backpressure to clear. Skipped entirely for a stream that does not
 * expose the backpressure surface (plain test stubs); re-checks `writableNeedsDrain` after each
 * drain event rather than assuming one clears it.
 */
async function awaitDrain(stream: Stream, signal: AbortSignal): Promise<void> {
	if (!drainCapable(stream)) return;
	while (stream.writableNeedsDrain === true) {
		if (signal.aborted) throw abortReasonError(signal);
		await onceDrain(stream, signal);
	}
}

/**
 * Frame and send the body, honoring `stream.send`'s backpressure boolean with a drain wait
 * bounded by the deadline signal. Returns an outcome on failure, `undefined` on success.
 */
async function writeBody(
	stream: Stream,
	body: unknown,
	callerSignal: AbortSignal | undefined,
	deadlineSignal: AbortSignal
): Promise<RpcOutcome<never> | undefined> {
	try {
		const hasRoom = sendFramed(stream, await encodeJson(body));
		if (!hasRoom) await awaitDrain(stream, deadlineSignal);
		return undefined;
	} catch (err) {
		return classify(err, callerSignal, deadlineSignal);
	}
}

/**
 * Decode phase — separate from {@link classify} on purpose: a decode callback's own throw must
 * never classify as timeout or foreign-protocol. Caller-signal aborted → `cancelled`, anything
 * else → `decode-error`. The busy shape is tested on the parsed value *before* `decode` runs,
 * so a validator never sees a busy reply. The body is parsed twice (once here for the busy
 * check, once by `decode`) — accepted: these are small framed messages.
 */
async function decodeReply<T>(
	bytes: Uint8Array,
	decode: (bytes: Uint8Array) => T | Promise<T>,
	rttMs: number,
	callerSignal: AbortSignal | undefined
): Promise<RpcOutcome<T>> {
	let parsed: unknown;
	try {
		parsed = await decodeJson(bytes);
	} catch (err) {
		return decodeFailure(err, callerSignal);
	}
	if (isBusyShape(parsed)) {
		const retry = (parsed as { retry_after_ms?: unknown }).retry_after_ms;
		return { kind: 'busy', retryAfterMs: typeof retry === 'number' ? retry : undefined };
	}
	try {
		return { kind: 'ok', value: await decode(bytes), rttMs };
	} catch (err) {
		return decodeFailure(err, callerSignal);
	}
}

function decodeFailure(
	err: unknown,
	callerSignal: AbortSignal | undefined
): { kind: 'cancelled' } | { kind: 'decode-error'; error: Error } {
	if (callerSignal?.aborted === true) return { kind: 'cancelled' };
	return { kind: 'decode-error', error: toError(err) };
}

/**
 * The single owner of the open / write / read / close sequence for an outbound FRET RPC,
 * composing the four pinned primitives (`openRpcStream` / `sendFramed` / `readFramed` /
 * `releaseRpcStream`) under exactly one clock: the helper's deadline is a child of the caller's
 * signal, and `readFramed` runs in its `Infinity` mode with that deadline as the sole signal.
 *
 * **Never throws for a network outcome** — every failure mode is an {@link RpcOutcome} variant.
 * It may still throw for a caller bug (a malformed peer id, `dial: 'if-addressed'` with no
 * `isDialable`): those are programming errors, never dressed as `unreachable`.
 *
 * Two overloads rather than one signature with an optional `decode`, so a forgotten validator
 * cannot be *typed* as the reply. A single `rpcRequest<T = undefined>` accepted
 * `rpcRequest<Snapshot>(node, peer, proto, { body })` — an explicit type argument with no
 * `decode` — and returned `{ kind: 'ok', value: undefined as Snapshot }`, so the caller read a
 * property off `undefined` at runtime with nothing to see at compile time.
 *
 * This overload is the write-only one: no `decode`, and `T` pinned to `undefined` so an explicit
 * type argument cannot reach it.
 */
export function rpcRequest(
	node: Libp2p,
	peer: string,
	protocol: string,
	opts?: RpcRequestOptions<undefined>
): Promise<RpcOutcome<undefined>>;
/** With `decode` → the reply type comes from the validator. */
export function rpcRequest<T>(
	node: Libp2p,
	peer: string,
	protocol: string,
	opts: RpcRequestOptions<T> & { decode: (bytes: Uint8Array) => T | Promise<T> }
): Promise<RpcOutcome<T>>;
export async function rpcRequest<T = undefined>(
	node: Libp2p,
	peer: string,
	protocol: string,
	opts: RpcRequestOptions<T> = {}
): Promise<RpcOutcome<T>> {
	// Caller bugs throw — both checks sit BEFORE deadline() so a throw leaves no timer to cancel.
	const pid = peerIdFromString(peer);
	const dialMode = opts.dial ?? 'always';
	const isDialable = opts.isDialable;
	if (dialMode === 'if-addressed' && isDialable == null) {
		throw new Error("rpcRequest: dial mode 'if-addressed' requires opts.isDialable");
	}
	const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const d = deadline(timeoutMs, opts.signal);
	let stream: Stream | undefined;
	try {
		if (opts.signal?.aborted === true) return { kind: 'cancelled' }; // no dial issued
		// Dial-mode mapping onto `openRpcStream`'s `requireExisting` (its signature is a pinned
		// public export and stays unchanged): 'never' forbids the dial outright; 'if-addressed'
		// forbids it only when `isDialable` says no. An existing connection is still used either
		// way — reusing a live connection needs no dialability; "no dial attempt" is the
		// invariant. No connection under `requireExisting` → `undefined` → `skipped`.
		const requireExisting = dialMode === 'never'
			|| (dialMode === 'if-addressed' && isDialable?.(peer) === false);
		try {
			stream = await openRpcStream(node, pid, [protocol], { requireExisting, signal: d.signal });
		} catch (err) {
			return classify(err, opts.signal, d.signal);
		}
		if (stream == null) return { kind: 'skipped' };
		// RTT clock starts after the open: a dial is not round-trip time (matches `sendPing`).
		const start = Date.now();
		if (opts.body !== undefined) {
			const failed = await writeBody(stream, opts.body, opts.signal, d.signal);
			if (failed != null) return failed;
		}
		if (opts.halfCloseBeforeRead === true) {
			// Write-side flush the responder waits on (the maybeAct pattern), bounded by the deadline.
			try {
				await stream.close({ signal: d.signal });
			} catch (err) {
				return classify(err, opts.signal, d.signal);
			}
		}
		if (opts.decode == null) {
			// Write-only: `ok` proves the body reached the transport, nothing more — see the
			// variant's doc comment on RpcOutcome.
			return { kind: 'ok', value: undefined as T, rttMs: Math.max(0, Date.now() - start) };
		}
		let bytes: Uint8Array;
		try {
			bytes = await readFramed(stream, maxBytes, Infinity, { signal: d.signal });
		} catch (err) {
			return classify(err, opts.signal, d.signal);
		}
		return await decodeReply(bytes, opts.decode, Math.max(0, Date.now() - start), opts.signal);
	} finally {
		// Release BEFORE d.cancel(): the bounded close needs the deadline still live — see the
		// ordering NOTE on releaseRpcStream. `undefined` (the skipped path) is a no-op there.
		await releaseRpcStream(stream, d.signal);
		d.cancel();
	}
}
