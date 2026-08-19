import { after, afterEach, before, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { Connection, NewStreamOptions, PeerId, Stream } from '@libp2p/interface'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import * as lp from 'it-length-prefixed'
import { rpcRequest } from '../src/rpc/request.js'
import type { RpcOutcome } from '../src/rpc/outcome.js'
import { decodeJson } from '../src/rpc/protocols.js'
import { abortReasonError } from '../src/utils/deadline.js'

// `rpcRequest` is the single owner of the outbound open / write / read / release sequence
// (`src/rpc/request.ts`). Its whole contract is that a *network* outcome is never a throw: every
// failure mode is an `RpcOutcome` variant, and each variant is documented by what it proves about
// the peer — which is what the service will branch on once `15.2b` migrates the senders. So the
// three things this file pins are:
//
//   1. **Every failure shape maps to its stated variant.** A reset is `unreachable`; a truncated,
//      empty, non-object, over-cap or validator-rejected reply is `decode-error` (proof of life,
//      never a contact strike); a deferred negotiate failure is `foreign-protocol`, not
//      `unreachable`; our own budget is `timeout`.
//   2. **Cancellation is never mistaken for a peer failure.** The caller's signal is checked
//      before every other classification, so an abort before / during the open / during the read
//      is `cancelled` — and a pre-aborted call issues no dial at all.
//   3. **The stream is released exactly once on every path, with the arm deterministic.** Unlike
//      `rpc.stream-errors.spec.ts` — where two clocks (the whole-RPC deadline and `readFramed`'s
//      own timer) race and only the release *count* is an invariant — the helper reads in
//      `readFramed`'s `Infinity` mode, so the RPC deadline is the sole clock and the arm itself is
//      pinnable: aborted signal at release time -> `abort()`, otherwise `close()`.
//
// Every case drives stub streams rather than real transports: the failure shapes here (a reset
// mid-frame, an over-declared length, a write that reports backpressure and never drains) are not
// reproducible on demand over a real muxer.

const enc = new TextEncoder()

const PROTOCOL = '/optimystic/net-test/fret/1.0.0/ping'

const TIMEOUT_MS = 100
const MIN_MS = 80
// Deliberately loose, exactly as `rpc.stream-errors.spec.ts`: the property is "bounded at all",
// not scheduler precision.
const MAX_MS = 1000

interface PingReply { ok: boolean; ts: number }

/** A complete, decodable reply body (frame it with `frame()` before serving). */
const REPLY_OK = enc.encode(JSON.stringify({ ok: true, ts: 1 }))
/** `BusyResponseV1` (`src/index.ts`) — the shape `decodeReply` short-circuits on. */
const REPLY_BUSY = enc.encode(JSON.stringify({ v: 1, busy: true, retry_after_ms: 500 }))
/** A valid JSON document whose top level is not an object — `decodeJson` refuses it. */
const REPLY_ARRAY = enc.encode(JSON.stringify([1, 2, 3]))

/** One whole framed message: varint length prefix + body. */
function frame(body: Uint8Array): Uint8Array {
	return lp.encode.single(body).subarray()
}

/** Frame `full` and truncate mid-BODY, so the frame can never complete. */
function framedPartial(full: Uint8Array): Uint8Array {
	const framed = frame(full)
	const prefixLen = framed.length - full.length
	return framed.subarray(0, prefixLen + Math.floor(full.length / 2))
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

/** The error a muxer/transport surfaces when the peer's connection dies mid-reply. */
function reset(): Error {
	return new Error('connection reset by peer')
}

/** What libp2p throws when the remote does not serve the dialed protocol. */
function unsupported(): Error {
	const err = new Error('protocol selection failed')
	err.name = 'UnsupportedProtocolError'
	return err
}

async function decodePing(bytes: Uint8Array): Promise<PingReply> {
	return await decodeJson<PingReply>(bytes)
}

// ---------------------------------------------------------------------------------------------
// Stub streams
//
// Modelled on `rpc.stream-errors.spec.ts:117-215` (one scripted read + release counters in one
// stub), extended with the two surfaces this helper touches and that one does not: a `send()` that
// can report backpressure, and the `writableNeedsDrain` / `addEventListener` pair `awaitDrain`
// waits on. The event surface is only installed when asked for, because the helper's
// `drainCapable` guard deliberately skips the drain wait for a stream without it — that guard is
// what keeps old-style stubs (and any non-libp2p `Stream`) viable, so it needs a stub with no
// event surface to be tested against.
// ---------------------------------------------------------------------------------------------

type ReadStep =
	| { kind: 'chunk'; bytes: Uint8Array }
	| { kind: 'eof' }
	| { kind: 'reject'; error: Error }
	| { kind: 'stall' }

interface Listener { fn: () => void; once: boolean }

interface StubStreamOpts {
	/** Make `send()` throw — the write-side reset. */
	sendThrows?: Error
	/** `send()` reports "queue full" on its first call. */
	sendBackpressure?: boolean
	/** Expose `writableNeedsDrain` + listeners, i.e. pass the helper's `drainCapable` guard. */
	drainSurface?: boolean
	/** Fires at the *start* of each `iter.next()`, 1-based — the cancellation hook. */
	onNext?: (call: number) => void
}

interface StubStream {
	stream: Stream
	/** `close()` calls — the release arm on an un-aborted signal, plus any `halfCloseBeforeRead`. */
	closes: number
	/** `abort()` calls — the release arm once a signal has fired. */
	aborts: number
	/** `send()` calls. */
	sends: number
	/** Chunks the reader actually consumed. */
	delivered: number
	/** Flip `writableNeedsDrain` from the test's drain script. */
	needsDrain: (v: boolean) => void
	/** Fire an event at the helper's listeners; `once` entries are removed first. */
	dispatch: (type: string) => void
	/** Live listeners of `type` — the drain-wait hygiene probe. */
	listenerCount: (type: string) => number
}

function makeStub(steps: ReadStep[], opts: StubStreamOpts = {}): StubStream {
	const listeners = new Map<string, Listener[]>()
	let step = 0
	let calls = 0
	const rec: StubStream = {
		stream: undefined as unknown as Stream,
		closes: 0, aborts: 0, sends: 0, delivered: 0,
		needsDrain: (v: boolean): void => { stream.writableNeedsDrain = v },
		dispatch: (type: string): void => {
			const arr = listeners.get(type) ?? []
			listeners.set(type, arr.filter((l) => !l.once))
			for (const l of arr) l.fn()
		},
		listenerCount: (type: string): number => (listeners.get(type) ?? []).length,
	}
	const stream: Record<string, unknown> = {
		id: 'stub-stream',
		send: (_bytes: unknown): boolean => {
			rec.sends++
			if (opts.sendThrows) throw opts.sendThrows
			if (opts.sendBackpressure === true && rec.sends === 1) {
				if (opts.drainSurface === true) stream.writableNeedsDrain = true
				return false
			}
			return true
		},
		close: async (_o?: unknown): Promise<void> => { rec.closes++ },
		abort: (_e: Error): void => { rec.aborts++ },
		[Symbol.asyncIterator]: () => ({
			next: async (): Promise<IteratorResult<Uint8Array>> => {
				opts.onNext?.(++calls)
				const s = steps[step++]
				if (s === undefined || s.kind === 'eof') return { done: true, value: undefined }
				if (s.kind === 'stall') return new Promise<IteratorResult<Uint8Array>>(() => { /* never settles */ })
				if (s.kind === 'reject') throw s.error
				rec.delivered++
				return { done: false, value: s.bytes }
			},
		}),
	}
	if (opts.drainSurface === true) {
		stream.writableNeedsDrain = false
		stream.addEventListener = (type: string, fn: () => void, o?: { once?: boolean }): void => {
			const arr = listeners.get(type) ?? []
			arr.push({ fn, once: o?.once === true })
			listeners.set(type, arr)
		}
		stream.removeEventListener = (type: string, fn: () => void): void => {
			listeners.set(type, (listeners.get(type) ?? []).filter((l) => l.fn !== fn))
		}
	}
	rec.stream = stream as unknown as Stream
	return rec
}

/** A stub that serves one whole framed reply and then ends. */
function serves(body: Uint8Array, opts: StubStreamOpts = {}): StubStream {
	return makeStub([{ kind: 'chunk', bytes: frame(body) }, { kind: 'eof' }], opts)
}

// ---------------------------------------------------------------------------------------------
// Fake node
//
// `nodeServing` in `rpc.stream-errors.spec.ts` is enough to answer "what did the sender do with
// the reply". The dial-mode and cancellation cases here ask a different question — "was a dial
// issued at all" — so this variant counts each entry point and can be built with no connections.
// ---------------------------------------------------------------------------------------------

interface NodeCalls { getConnections: number; newStream: number; dialProtocol: number }

interface CountingNode { node: Libp2p; calls: NodeCalls }

interface CountingNodeOpts {
	/** false → `getConnections` returns []; the dial mode then decides whether a dial happens. */
	connected?: boolean
	/** Replaces "resolve with `stream`" for both `newStream` and `dialProtocol`. */
	open?: (o: NewStreamOptions) => Promise<Stream>
}

function countingNode(stream: Stream | undefined, opts: CountingNodeOpts = {}): CountingNode {
	const calls: NodeCalls = { getConnections: 0, newStream: 0, dialProtocol: 0 }
	const open = opts.open ?? (async (): Promise<Stream> => {
		if (stream == null) throw new Error('countingNode: no stream configured')
		return stream
	})
	const conn = {
		status: 'open',
		remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/4001' },
		newStream: async (_p: string[], o: NewStreamOptions): Promise<Stream> => {
			calls.newStream++
			return await open(o)
		},
	}
	const node = {
		getConnections: (_pid?: PeerId): Connection[] => {
			calls.getConnections++
			return (opts.connected === false ? [] : [conn]) as unknown as Connection[]
		},
		dialProtocol: async (_pid: PeerId, _p: string[], o: NewStreamOptions): Promise<Stream> => {
			calls.dialProtocol++
			return await open(o)
		},
	} as unknown as Libp2p
	return { node, calls }
}

/**
 * A `newStream` that never resolves until the signal it was handed fires. A stub that ignores the
 * signal hangs the open-cancellation and open-timeout cases instead of failing them.
 */
function hangsUntilAborted(o: NewStreamOptions): Promise<Stream> {
	return new Promise<Stream>((_resolve, reject) => {
		const signal = o.signal
		if (signal == null) return // nothing can end this — the test would time out, loudly
		if (signal.aborted) { reject(abortReasonError(signal)); return }
		signal.addEventListener('abort', () => { reject(abortReasonError(signal)) }, { once: true })
	})
}

// ---------------------------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------------------------

function expectKind<K extends RpcOutcome<unknown>['kind']>(
	outcome: RpcOutcome<unknown>,
	kind: K
): Extract<RpcOutcome<unknown>, { kind: K }> {
	const detail = 'error' in outcome && outcome.error instanceof Error ? ` (${outcome.error.message})` : ''
	expect(outcome.kind, `expected outcome '${kind}', got '${outcome.kind}'${detail}`).to.equal(kind)
	return outcome as Extract<RpcOutcome<unknown>, { kind: K }>
}

/**
 * Release accounting, with the arm pinned rather than only the count.
 *
 * `rpc.stream-errors.spec.ts` can only assert `closes + aborts === 1` on its budget-expiry cases,
 * because the legacy senders arm two timers from the same `timeoutMs` and either can win. The
 * helper reads with `readFramed(..., Infinity, { signal: d.signal })`, so the RPC deadline is the
 * only clock and the arm is a fact: `releaseRpcStream` aborts iff that signal has already fired.
 * That determinism is what lets `15.2b` collapse the two release-arm helpers in that file into one
 * expectation.
 */
function expectRelease(s: StubStream, expected: { closes: number; aborts: number }): void {
	expect({ closes: s.closes, aborts: s.aborts }, 'release arm and count').to.deep.equal(expected)
}

function elapsedBounded(elapsed: number): void {
	expect(elapsed, `elapsed ${elapsed}ms must not be far under the ${TIMEOUT_MS}ms budget`).to.be.at.least(MIN_MS)
	expect(elapsed, `elapsed ${elapsed}ms must be bounded by roughly the ${TIMEOUT_MS}ms budget`).to.be.at.most(MAX_MS)
}

describe('rpcRequest', function () {
	// The stall / drain cases each spend a whole budget.
	this.timeout(20000)

	/** Invariant guard: no unhandled rejection escapes any case in this file. */
	const unhandled: unknown[] = []
	const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }

	before(() => { process.on('unhandledRejection', onUnhandled) })
	after(() => { process.off('unhandledRejection', onUnhandled) })

	// Scheduled drain events. Tracked so a case that ends early cannot leave a timer behind — the
	// repo's exit watchdog fails the run on exactly that.
	const timers = new Set<ReturnType<typeof setTimeout>>()
	function later(ms: number, fn: () => void): void {
		const t = setTimeout(() => { timers.delete(t); fn() }, ms)
		timers.add(t)
	}

	afterEach(async () => {
		for (const t of timers) clearTimeout(t)
		timers.clear()
		// Detection is a tick behind the rejection, so give it one.
		await sleep(20)
		const seen = unhandled.splice(0).map((r) => (r instanceof Error ? r.message : String(r)))
		expect(seen, 'unhandled rejection escaped').to.deep.equal([])
	})

	// Real Ed25519 ids: `rpcRequest` runs `peerIdFromString` before anything else, so a synthetic
	// string would fail for the wrong reason.
	let peer: string

	before(async () => {
		peer = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
	})

	describe('failure shapes map to variants', () => {
		it('reset mid-stream is unreachable, and surfaces the error', async () => {
			const s = makeStub([
				{ kind: 'chunk', bytes: framedPartial(REPLY_OK) },
				{ kind: 'reject', error: reset() },
			])

			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { ping: 1 }, decode: decodePing,
			})

			expect(expectKind(out, 'unreachable').error.message).to.equal('connection reset by peer')
			expectRelease(s, { closes: 1, aborts: 0 })
		})

		it('a tidy close mid-JSON is decode-error, never a partial parse', async () => {
			const s = makeStub([
				{ kind: 'chunk', bytes: framedPartial(REPLY_OK) },
				{ kind: 'eof' },
			])

			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { ping: 1 }, decode: decodePing,
			})

			expectKind(out, 'decode-error')
			expectRelease(s, { closes: 1, aborts: 0 })
		})

		it('EOF before any bytes is decode-error — proof of life, not a strike', async () => {
			// The peer opened a stream and closed it cleanly. `sendPing` books no strike for this
			// today; `decode-error` is what generalizes that to every sender.
			const s = makeStub([{ kind: 'eof' }])

			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { ping: 1 }, decode: decodePing,
			})

			expectKind(out, 'decode-error')
			expectRelease(s, { closes: 1, aborts: 0 })
		})

		it('an empty frame is decode-error (decodeJson: empty response)', async () => {
			// Prefix `0x00` — `readFramed` returns an empty buffer rather than throwing, so the
			// refusal has to come from the decode phase.
			const s = serves(new Uint8Array(0))

			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { ping: 1 }, decode: decodePing,
			})

			expect(expectKind(out, 'decode-error').error.message).to.equal('empty response')
			expectRelease(s, { closes: 1, aborts: 0 })
		})

		it('a non-object JSON top level is decode-error', async () => {
			const s = serves(REPLY_ARRAY)

			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { ping: 1 }, decode: decodePing,
			})

			expect(expectKind(out, 'decode-error').error.message).to.equal('non-object JSON payload')
			expectRelease(s, { closes: 1, aborts: 0 })
		})

		it('an over-cap declared length is decode-error, refused at the prefix', async () => {
			const s = serves(REPLY_OK)

			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, maxBytes: 4, body: { ping: 1 }, decode: decodePing,
			})

			expect(expectKind(out, 'decode-error').error.message).to.match(/^payload too large/)
			expectRelease(s, { closes: 1, aborts: 0 })
		})

		// Every other case passes an explicit `maxBytes`, so the DEFAULT_MAX_BYTES fallback is only
		// ever proved *present*. Omitting it against a frame declaring 8193 bytes proves it is
		// wired to the cap the reader enforces, at the 8 KiB boundary itself.
		it('with maxBytes omitted the 8 KiB default is the cap that refuses the frame', async () => {
			const s = serves(new Uint8Array(8 * 1024 + 1))

			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { ping: 1 }, decode: decodePing,
			})

			expect(expectKind(out, 'decode-error').error.message)
				.to.equal('payload too large: 8193 exceeds 8192 byte limit')
			expectRelease(s, { closes: 1, aborts: 0 })
		})

		it('bytes then silence is timeout, bounded by the budget', async () => {
			const s = makeStub([
				{ kind: 'chunk', bytes: framedPartial(REPLY_OK) },
				{ kind: 'stall' },
			])

			const started = Date.now()
			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { ping: 1 }, decode: decodePing,
			})
			elapsedBounded(Date.now() - started)

			expectKind(out, 'timeout')
			// Single clock: the deadline signal is what ended the read, so it is aborted by the
			// time the `finally` releases — the abort arm is a fact here, not a race.
			expectRelease(s, { closes: 0, aborts: 1 })
		})

		it('an UnsupportedProtocolError at the open is foreign-protocol', async () => {
			const node = countingNode(undefined, {
				open: async (): Promise<Stream> => { throw unsupported() },
			})

			const out = await rpcRequest<PingReply>(node.node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { ping: 1 }, decode: decodePing,
			})

			expectKind(out, 'foreign-protocol')
		})

		it('an UnsupportedProtocolError deferred to the read is foreign-protocol, not unreachable', async () => {
			// `openRpcStream` pins `negotiateFully: false`, so a peer that does not serve this
			// protocol fails at the first read rather than at the open. A per-phase classifier that
			// only looked for it at the open would book a contact strike for membership evidence.
			const s = makeStub([{ kind: 'reject', error: unsupported() }])

			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { ping: 1 }, decode: decodePing,
			})

			expectKind(out, 'foreign-protocol')
			expectRelease(s, { closes: 1, aborts: 0 })
		})

		it('a busy reply short-circuits before decode and carries retry_after_ms', async () => {
			let decodeCalls = 0
			const s = serves(REPLY_BUSY)

			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS,
				body: { ping: 1 },
				decode: (): PingReply => {
					decodeCalls++
					throw new Error('decode must not run for a busy reply')
				},
			})

			expect(expectKind(out, 'busy').retryAfterMs).to.equal(500)
			expect(decodeCalls, 'busy is tested on the parsed value, before the validator').to.equal(0)
			expectRelease(s, { closes: 1, aborts: 0 })
		})

		// `retry_after_ms` is optional on the wire and `decodeReply` guards it with
		// `typeof retry === 'number'`. Both arms of that guard are `busy` with no hint — never a
		// decode-error, and never a non-number leaking out as `retryAfterMs`.
		for (const [label, body] of [
			['absent', { v: 1, busy: true }],
			['non-numeric', { v: 1, busy: true, retry_after_ms: 'soon' }],
		] as const) {
			it(`a busy reply with ${label} retry_after_ms is busy with no hint`, async () => {
				const s = serves(enc.encode(JSON.stringify(body)))

				const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
					timeoutMs: TIMEOUT_MS,
					body: { ping: 1 },
					decode: (): PingReply => { throw new Error('decode must not run for a busy reply') },
				})

				expect(expectKind(out, 'busy').retryAfterMs).to.equal(undefined)
				expectRelease(s, { closes: 1, aborts: 0 })
			})
		}

		it('a decode callback that throws on a good frame is decode-error, and the stream is released', async () => {
			const s = serves(REPLY_OK)

			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS,
				body: { ping: 1 },
				decode: (): PingReply => { throw new Error('validator rejected the reply') },
			})

			expect(expectKind(out, 'decode-error').error.message).to.equal('validator rejected the reply')
			expectRelease(s, { closes: 1, aborts: 0 })
		})

		it('a whole framed reply decodes to ok with a non-negative rtt', async () => {
			const s = serves(REPLY_OK)

			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { ping: 1 }, decode: decodePing,
			})

			const ok = expectKind(out, 'ok')
			expect(ok.value).to.deep.equal({ ok: true, ts: 1 })
			expect(ok.rttMs).to.be.at.least(0)
			expectRelease(s, { closes: 1, aborts: 0 })
		})

		it('halfCloseBeforeRead adds one flush close to the ok path', async () => {
			const s = serves(REPLY_OK)

			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { ping: 1 }, decode: decodePing, halfCloseBeforeRead: true,
			})

			expectKind(out, 'ok')
			expectRelease(s, { closes: 2, aborts: 0 })
		})
	})

	describe('cancellation is never a peer failure', () => {
		it('a signal aborted before the call is cancelled, and issues no dial', async () => {
			const s = serves(REPLY_OK)
			const node = countingNode(s.stream)
			const ac = new AbortController()
			ac.abort()

			const out = await rpcRequest<PingReply>(node.node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, signal: ac.signal, body: { ping: 1 }, decode: decodePing,
			})

			expectKind(out, 'cancelled')
			expect(node.calls, 'nothing was contacted').to.deep.equal({
				getConnections: 0, newStream: 0, dialProtocol: 0,
			})
			// Nothing was opened, so there is nothing to release — the `aborts: 1` row of the
			// release table applies only once a stream exists.
			expectRelease(s, { closes: 0, aborts: 0 })
		})

		it('an abort during the open is cancelled, with no stream to release', async () => {
			const node = countingNode(undefined, { open: hangsUntilAborted })
			const ac = new AbortController()
			later(20, () => { ac.abort() })

			const out = await rpcRequest<PingReply>(node.node, peer, PROTOCOL, {
				// Budget deliberately far past the abort, so `timeout` cannot masquerade as the answer.
				timeoutMs: 5000, signal: ac.signal, body: { ping: 1 }, decode: decodePing,
			})

			expectKind(out, 'cancelled')
			expect(node.calls.newStream, 'the open was attempted').to.equal(1)
		})

		it('an abort during the read is cancelled, and aborts the stream', async () => {
			// `onNext` call 2 is the pull that would block forever; abort there.
			const ac = new AbortController()
			const s = makeStub([
				{ kind: 'chunk', bytes: framedPartial(REPLY_OK) },
				{ kind: 'stall' },
			], { onNext: (call) => { if (call === 2) ac.abort() } })

			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: 5000, signal: ac.signal, body: { ping: 1 }, decode: decodePing,
			})

			expectKind(out, 'cancelled')
			expectRelease(s, { closes: 0, aborts: 1 })
		})

		it('budget expiry with a live caller signal is timeout, not cancelled', async () => {
			const s = makeStub([
				{ kind: 'chunk', bytes: framedPartial(REPLY_OK) },
				{ kind: 'stall' },
			])
			const ac = new AbortController()

			const started = Date.now()
			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, signal: ac.signal, body: { ping: 1 }, decode: decodePing,
			})
			elapsedBounded(Date.now() - started)

			expectKind(out, 'timeout')
			expect(ac.signal.aborted, 'the caller never cancelled').to.equal(false)
			expectRelease(s, { closes: 0, aborts: 1 })
		})

		it('an open that expires on the budget is timeout', async () => {
			const node = countingNode(undefined, { open: hangsUntilAborted })

			const started = Date.now()
			const out = await rpcRequest<PingReply>(node.node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { ping: 1 }, decode: decodePing,
			})
			elapsedBounded(Date.now() - started)

			expectKind(out, 'timeout')
		})
	})

	describe('dial modes', () => {
		it("'never' with no connection is skipped, and dials nothing", async () => {
			const node = countingNode(undefined, { connected: false })

			const out = await rpcRequest<PingReply>(node.node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, dial: 'never', body: { ping: 1 }, decode: decodePing,
			})

			expectKind(out, 'skipped')
			expect(node.calls.dialProtocol).to.equal(0)
			expect(node.calls.newStream).to.equal(0)
		})

		it("'if-addressed' with an undialable peer and no connection is skipped", async () => {
			const node = countingNode(undefined, { connected: false })
			const asked: string[] = []

			const out = await rpcRequest<PingReply>(node.node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS,
				dial: 'if-addressed',
				isDialable: (id) => { asked.push(id); return false },
				body: { ping: 1 },
				decode: decodePing,
			})

			expectKind(out, 'skipped')
			expect(asked, 'dialability is asked about the peer under call').to.deep.equal([peer])
			expect(node.calls.dialProtocol).to.equal(0)
		})

		it("'if-addressed' with an undialable peer but an existing connection proceeds", async () => {
			// Reusing a live connection needs no dialability — the invariant is "no dial attempt",
			// not "no contact".
			const s = serves(REPLY_OK)
			const node = countingNode(s.stream, { connected: true })

			const out = await rpcRequest<PingReply>(node.node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS,
				dial: 'if-addressed',
				isDialable: () => false,
				body: { ping: 1 },
				decode: decodePing,
			})

			expectKind(out, 'ok')
			expect(node.calls.newStream, 'the existing connection was used').to.equal(1)
			expect(node.calls.dialProtocol, 'and no dial was issued').to.equal(0)
		})

		it("'always' with no connection dials", async () => {
			const s = serves(REPLY_OK)
			const node = countingNode(s.stream, { connected: false })

			const out = await rpcRequest<PingReply>(node.node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, dial: 'always', body: { ping: 1 }, decode: decodePing,
			})

			expectKind(out, 'ok')
			expect(node.calls.dialProtocol).to.equal(1)
		})

		it("'if-addressed' without isDialable throws — a caller bug is never an outcome", async () => {
			const node = countingNode(undefined, { connected: false })

			let thrown: unknown
			try {
				await rpcRequest<PingReply>(node.node, peer, PROTOCOL, {
					timeoutMs: TIMEOUT_MS, dial: 'if-addressed', decode: decodePing,
				})
			} catch (err) { thrown = err }

			expect((thrown as Error)?.message).to.include('requires opts.isDialable')
			expect(node.calls.getConnections, 'the throw precedes any contact').to.equal(0)
		})

		it('a malformed peer id rejects rather than returning an outcome', async () => {
			const node = countingNode(undefined, { connected: false })

			let thrown: unknown
			try {
				await rpcRequest(node.node, 'not-a-peer-id', PROTOCOL, { timeoutMs: TIMEOUT_MS })
			} catch (err) { thrown = err }

			expect(thrown, 'peerIdFromString throws before any timer is armed').to.be.instanceOf(Error)
			expect(node.calls.getConnections).to.equal(0)
		})
	})

	describe('write backpressure', () => {
		it('a stream that never drains ends on the budget, not in a hang', async () => {
			const s = serves(REPLY_OK, { sendBackpressure: true, drainSurface: true })

			const started = Date.now()
			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { ping: 1 }, decode: decodePing,
			})
			elapsedBounded(Date.now() - started)

			// The drain wait rejects into `writeBody`'s catch and goes through the shared
			// classifier — deadline expiry is `timeout`, there is no drain-specific variant.
			expectKind(out, 'timeout')
			expectRelease(s, { closes: 0, aborts: 1 })
			expect(s.listenerCount('drain'), 'the drain listener is removed on the abort arm too').to.equal(0)
		})

		it('a drain that clears the flag lets the request proceed to ok', async () => {
			const s = serves(REPLY_OK, { sendBackpressure: true, drainSurface: true })
			later(20, () => { s.needsDrain(false); s.dispatch('drain') })

			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: 5000, body: { ping: 1 }, decode: decodePing,
			})

			expectKind(out, 'ok')
			expect(s.sends).to.equal(1)
			expectRelease(s, { closes: 1, aborts: 0 })
			expect(s.listenerCount('drain')).to.equal(0)
		})

		it('a drain that does not clear the flag re-arms the wait', async () => {
			// Pins the re-check loop: `awaitDrain` re-reads `writableNeedsDrain` after every drain
			// event rather than assuming the first one cleared it.
			const s = serves(REPLY_OK, { sendBackpressure: true, drainSurface: true })
			later(20, () => { s.dispatch('drain') })              // still needs drain
			later(50, () => { s.needsDrain(false); s.dispatch('drain') })

			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: 5000, body: { ping: 1 }, decode: decodePing,
			})

			expectKind(out, 'ok')
			expectRelease(s, { closes: 1, aborts: 0 })
			expect(s.listenerCount('drain')).to.equal(0)
		})

		it('a stub with no backpressure surface skips the drain wait entirely', async () => {
			// The `drainCapable` guard is what keeps old-style stubs (and any non-libp2p `Stream`)
			// viable: `send()` says false, but there is no `writableNeedsDrain` to wait on.
			const s = serves(REPLY_OK, { sendBackpressure: true })

			const started = Date.now()
			const out = await rpcRequest<PingReply>(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { ping: 1 }, decode: decodePing,
			})

			expectKind(out, 'ok')
			expect(Date.now() - started, 'no wait was entered').to.be.below(MIN_MS)
			expectRelease(s, { closes: 1, aborts: 0 })
		})
	})

	describe('write-only requests', () => {
		it('ok carries no value, and the body reached the transport', async () => {
			const s = makeStub([{ kind: 'stall' }])

			const out = await rpcRequest(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { leave: 1 },
			})

			const ok = expectKind(out, 'ok')
			expect(ok.value, 'no reply was read').to.equal(undefined)
			expect(s.sends, 'the body was written').to.equal(1)
			expect(s.delivered, 'and nothing was read back').to.equal(0)
			expectRelease(s, { closes: 1, aborts: 0 })
		})

		it('halfCloseBeforeRead still flushes on the write-only path', async () => {
			// The write-only return sits *after* the flush, so the flush is not read-path-specific.
			const s = makeStub([{ kind: 'stall' }])

			const out = await rpcRequest(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { leave: 1 }, halfCloseBeforeRead: true,
			})

			expectKind(out, 'ok')
			expectRelease(s, { closes: 2, aborts: 0 })
		})

		it('a send that throws is unreachable, released once', async () => {
			const s = makeStub([{ kind: 'stall' }], { sendThrows: reset() })

			const out = await rpcRequest(countingNode(s.stream).node, peer, PROTOCOL, {
				timeoutMs: TIMEOUT_MS, body: { leave: 1 },
			})

			expect(expectKind(out, 'unreachable').error.message).to.equal('connection reset by peer')
			expectRelease(s, { closes: 1, aborts: 0 })
		})
	})

	// `15.2b` puts five senders on one shared helper over one node. That is only safe because the
	// helper keeps no per-call state on the node — every clock, stream and counter is a local of
	// the call. Two overlapping calls over one node, each served its own stream, is the cheapest
	// statement of it: both decode their own reply and each releases its own stream exactly once.
	describe('concurrency', () => {
		it('two calls over one node do not share state', async () => {
			const a = serves(enc.encode(JSON.stringify({ ok: true, ts: 1 })))
			const b = serves(enc.encode(JSON.stringify({ ok: true, ts: 2 })))
			const streams = [a.stream, b.stream]
			let issued = 0
			const { node, calls } = countingNode(undefined, {
				open: async (): Promise<Stream> => streams[issued++]!,
			})

			const [outA, outB] = await Promise.all([
				rpcRequest<PingReply>(node, peer, PROTOCOL, {
					timeoutMs: TIMEOUT_MS, body: { ping: 1 }, decode: decodePing,
				}),
				rpcRequest<PingReply>(node, peer, PROTOCOL, {
					timeoutMs: TIMEOUT_MS, body: { ping: 2 }, decode: decodePing,
				}),
			])

			expect(expectKind(outA, 'ok').value).to.deep.equal({ ok: true, ts: 1 })
			expect(expectKind(outB, 'ok').value).to.deep.equal({ ok: true, ts: 2 })
			expect(calls.newStream, 'one stream per call').to.equal(2)
			expectRelease(a, { closes: 1, aborts: 0 })
			expectRelease(b, { closes: 1, aborts: 0 })
		})
	})
})
