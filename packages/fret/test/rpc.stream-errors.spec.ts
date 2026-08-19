import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { Connection, PeerId, Stream } from '@libp2p/interface'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import * as lp from 'it-length-prefixed'
import { createMemNode, createMemoryNode, stopAll } from './helpers/libp2p.js'
import { ringOffset } from './helpers/ring.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { PROTOCOL_NEIGHBORS, PROTOCOL_PING, RPC_TIMEOUT_MS } from '../src/rpc/protocols.js'
import type { RpcOutcome } from '../src/rpc/outcome.js'
import { sendPing } from '../src/rpc/ping.js'
import { announceNeighbors, fetchNeighbors } from '../src/rpc/neighbors.js'
import { sendMaybeAct } from '../src/rpc/maybe-act.js'
import { sendLeave } from '../src/rpc/leave.js'
import { coordToBase64url, hashKey, hashPeerId } from '../src/ring/hash.js'
import type { DigitreeStore } from '../src/store/digitree-store.js'
import type { NeighborSnapshotV1, RouteAndMaybeActV1 } from '../src/index.js'

// What each outbound RPC returns when the reply fails *partway through*, and what the service
// records about the peer as a result. The read primitive itself is covered elsewhere
// (`payload-bounds-ttl.spec.ts` pins the declared-length cap, the mid-stream stall and
// deadline-over-truncation; `rpc.request.spec.ts` pins `rpcRequest` — the shared
// open/write/read/release sequence — against every failure shape in isolation). Three failure
// shapes this file drives through the *senders*:
//
//   1. **Reset mid-stream** — the reply iterator *throws* after some bytes (connection reset, muxer
//      error, remote abort).
//   2. **Clean EOF mid-payload** — the peer closes tidily after half a framed message. Not a
//      timeout: the frame never completes, so `readFramed` raises a truncation error
//      (`UnexpectedEOFError` for a partial body still buffered) before any decode runs.
//   3. **Partial then stall** — bytes arrive, then nothing.
//
// Since the sender migration (`15.2-rpc-sender-migration`) every sender runs on `rpcRequest` and
// returns an `RpcOutcome<T>`, so the senders share one contract:
//
//   - A network failure is an *outcome*, never a throw: a reset is `unreachable`, a truncated or
//     undecodable reply is `decode-error`, a stall is `timeout`, the caller's own abort is
//     `cancelled`. Only a caller bug throws.
//   - A partial payload is never parsed as a whole message — and no value field exists on a
//     non-`ok` outcome, so "nothing salvaged" is structural rather than asserted per field.
//   - The stream is released exactly once, and the arm is deterministic: `rpcRequest` reads on a
//     single clock (`readFramed` in `Infinity` mode, bounded by the RPC deadline alone), so on a
//     timeout the deadline signal has always fired before the `finally` and release is the
//     synchronous `abort()`; every other read failure releases by `close()`.
//   - No unhandled rejection escapes — including from wire bytes queued after the first frame,
//     which a single-frame read never pulls.
//   - Our own cancellation is never evidence about the peer: no contact strike, no backoff, no
//     relevance decay.
//   - A reset mid-stream is a failed contact; an answered-but-undecodable reply proves the peer
//     alive, so it books relevance decay only and never demotes the peer to `foreign`.

const enc = new TextEncoder()

/** A complete, decodable ping reply (body bytes; frame with `frame()` before serving). */
const PING_OK = enc.encode(JSON.stringify({ ok: true, ts: 1, size_estimate: 42, confidence: 0.5 }))
/**
 * A complete neighbor snapshot. The ids are spelled `ghost-*` so any partial parse of a truncated
 * frame is visible by substring rather than only by a shape assertion.
 */
const FULL_SNAPSHOT = enc.encode(JSON.stringify({
	v: 1, from: 'ghost-from', timestamp: 1, successors: ['ghost-succ'],
	predecessors: ['ghost-pred'], sample: [{ id: 'ghost-sample', coord: 'AAAA', relevance: 1 }], sig: '',
}))
/** A complete NearAnchor reply — what a `maybeAct` forward would be reading. */
const FULL_NEAR_ANCHOR = enc.encode(JSON.stringify({
	v: 1, anchors: ['ghost-anchor'], cohort_hint: ['ghost-hint'], estimated_cluster_size: 1, confidence: 0.5,
}))

/** One whole framed message: varint length prefix + body. */
function frame(body: Uint8Array): Uint8Array {
	return lp.encode.single(body).subarray()
}

/**
 * Frame `full` and truncate mid-BODY: the prefix (and half the body, ghost strings included) is
 * on the wire, so the frame can never complete and a lenient partial parse would still have the
 * ghost bytes to surface.
 */
function framedPartial(full: Uint8Array): Uint8Array {
	const framed = frame(full)
	const prefixLen = framed.length - full.length
	return framed.subarray(0, prefixLen + Math.floor(full.length / 2))
}

/** Framed partials — a clean EOF after any of these is a truncated frame, not a short message. */
const HALF_PING = framedPartial(PING_OK)
const HALF_SNAPSHOT = framedPartial(FULL_SNAPSHOT)
const HALF_NEAR_ANCHOR = framedPartial(FULL_NEAR_ANCHOR)

const PROTOCOL = '/optimystic/net-test/fret/1.0.0/ping'

const TIMEOUT_MS = 100
const MIN_MS = 80
// Deliberately loose, exactly as `rpc.protocols.spec.ts`'s deadline block: the property under test
// is "bounded at all", not scheduler precision.
const MAX_MS = 1000

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

/** The error a muxer/transport surfaces when the peer's connection dies mid-reply. */
function reset(): Error {
	return new Error('connection reset by peer')
}

// ---------------------------------------------------------------------------------------------
// Stub streams
//
// `rpc.protocols.spec.ts` splits these concerns across two stub families: a bare `close`/`abort`
// recorder with no read side (`makeReleasable`, for `releaseRpcStream` alone) and read-side stubs
// with no release side at all. A failure *partway through a read* needs both at once — the shape of
// the read is what decides which release happens — so these implement the read script and the
// release counters in one stub. A single scripted factory covers all three failure shapes so the
// shapes stay comparable.
// ---------------------------------------------------------------------------------------------

type ReadStep =
	| { kind: 'chunk'; bytes: Uint8Array }
	| { kind: 'eof' }
	| { kind: 'reject'; error: Error; afterMs?: number }
	| { kind: 'stall' }

interface StubStream {
	stream: Stream
	/** `close()` calls. `sendMaybeAct` half-closes before its read *and* releases from its `finally`. */
	closes: number
	/** `abort()` calls — the release `releaseRpcStream` picks once a signal has aborted. */
	aborts: number
	/** `send()` calls; the write-only RPCs are asserted on this. */
	sends: number
	/** Chunks the reader actually consumed. */
	delivered: number
}

interface StubStreamOpts {
	/** Make `send()` throw — the write-side reset for the two write-only RPCs. */
	sendThrows?: Error
	/** Fires at the *start* of each `iter.next()`, 1-based — the hook the cancellation cases use. */
	onNext?: (call: number) => void
}

function makeStubStream(steps: ReadStep[], opts: StubStreamOpts = {}): StubStream {
	const rec: StubStream = {
		stream: undefined as unknown as Stream,
		closes: 0, aborts: 0, sends: 0, delivered: 0,
	}
	let step = 0
	let calls = 0
	const stream = {
		id: 'stub-stream',
		send: (_bytes: Uint8Array): boolean => {
			rec.sends++
			if (opts.sendThrows) throw opts.sendThrows
			return true
		},
		close: async (): Promise<void> => { rec.closes++ },
		abort: (_err: Error): void => { rec.aborts++ },
		[Symbol.asyncIterator]: () => ({
			next: async (): Promise<IteratorResult<Uint8Array>> => {
				opts.onNext?.(++calls)
				const s = steps[step++]
				if (s === undefined || s.kind === 'eof') return { done: true, value: undefined }
				if (s.kind === 'stall') return new Promise<IteratorResult<Uint8Array>>(() => { /* never settles */ })
				if (s.kind === 'reject') {
					if (s.afterMs !== undefined) await sleep(s.afterMs)
					throw s.error
				}
				rec.delivered++
				return { done: false, value: s.bytes }
			},
		}),
	}
	rec.stream = stream as unknown as Stream
	return rec
}

/** Reset after `bytes`; with no bytes, the reset lands before anything was buffered. */
function resetsAfter(bytes?: Uint8Array): StubStream {
	const steps: ReadStep[] = bytes === undefined ? [] : [{ kind: 'chunk', bytes }]
	steps.push({ kind: 'reject', error: reset() })
	return makeStubStream(steps)
}

/** A tidy close halfway through a JSON document — a short-but-complete buffer, not a timeout. */
function halfThenEof(bytes: Uint8Array): StubStream {
	return makeStubStream([{ kind: 'chunk', bytes }, { kind: 'eof' }])
}

/** Bytes, then silence. Only the RPC's own budget (or the caller's signal) can end this. */
function partialThenStall(bytes: Uint8Array, opts: StubStreamOpts = {}): StubStream {
	return makeStubStream([{ kind: 'chunk', bytes }, { kind: 'stall' }], opts)
}

/** A node whose every RPC — dialed or over an existing connection — lands on `stream`. */
function nodeServing(stream: Stream): Libp2p {
	const conn = {
		status: 'open',
		remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/4001' },
		newStream: async () => stream,
	}
	return {
		getConnections: (_pid?: PeerId) => [conn] as unknown as Connection[],
		dialProtocol: async () => stream,
	} as unknown as Libp2p
}

/** Release counters as one value, so a test states both halves of "exactly once" in one assertion. */
function release(s: StubStream): { closes: number; aborts: number } {
	return { closes: s.closes, aborts: s.aborts }
}

/**
 * Narrow an outcome to an expected kind, failing with the outcome's own error message when it
 * carries one. Generic over `T` so an `ok` narrowing types `value` at the call site.
 */
function expectKind<T, K extends RpcOutcome<T>['kind']>(
	outcome: RpcOutcome<T>,
	kind: K
): Extract<RpcOutcome<T>, { kind: K }> {
	const detail = 'error' in outcome && outcome.error instanceof Error ? ` (${outcome.error.message})` : ''
	expect(outcome.kind, `expected outcome '${kind}', got '${outcome.kind}'${detail}`).to.equal(kind)
	return outcome as Extract<RpcOutcome<T>, { kind: K }>
}

function elapsedBounded(elapsed: number): void {
	expect(elapsed, `elapsed ${elapsed}ms must not be far under the ${TIMEOUT_MS}ms budget`).to.be.at.least(MIN_MS)
	expect(elapsed, `elapsed ${elapsed}ms must be bounded by roughly the ${TIMEOUT_MS}ms budget`).to.be.at.most(MAX_MS)
}

/** Poll `predicate` until true, or fail after `limitMs`. */
async function waitUntil(predicate: () => boolean, limitMs: number, what: string): Promise<void> {
	const until = Date.now() + limitMs
	while (!predicate() && Date.now() < until) await sleep(10)
	expect(predicate(), `${what} within ${limitMs}ms`).to.equal(true)
}

describe('RPC stream failures', function () {
	// Two TCP nodes start in the real-transport case, and the stall cases spend their budgets.
	this.timeout(20000)

	/**
	 * Invariant guard: no unhandled rejection escapes any case in this file.
	 *
	 * The repo's exit watchdog (`test/mocha-exit-watchdog.ts`) catches leaked *handles*, not leaked
	 * rejections, and the poll loop deliberately holds an abandoned `iter.next()` past the end of the
	 * read. Without this hook such a rejection would surface as Node's default
	 * `--unhandled-rejections=throw` killing the run rather than as a named test failing — and only
	 * when the rejection happened to land inside the run at all.
	 *
	 * NOTE: no case here currently *arms* it — `readFramed` races every read promise it creates, so
	 * an abandoned read is already "handled", and the trailing-bytes case never pulls its reject
	 * step at all. It is kept as a cheap net over every case in the file (a future restructuring of
	 * that race could re-introduce an unraced promise), not as coverage of a specific line.
	 *
	 * Registered on this describe rather than at file top level: a top-level mocha hook is a *root*
	 * hook and would run against every test in the whole suite run.
	 */
	const unhandled: unknown[] = []
	const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }

	before(() => { process.on('unhandledRejection', onUnhandled) })
	after(() => { process.off('unhandledRejection', onUnhandled) })

	afterEach(async () => {
		// Detection is a tick behind the rejection, so give it one.
		await sleep(20)
		const seen = unhandled.splice(0).map((r) => (r instanceof Error ? r.message : String(r)))
		expect(seen, 'unhandled rejection escaped').to.deep.equal([])
	})

	// Real Ed25519 ids: every sender runs `peerIdFromString` on its target before anything else —
	// a malformed id is a caller bug and the one thing that still throws — so a synthetic string
	// would fail for the wrong reason.
	let peer: string

	before(async () => {
		peer = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
	})

	describe('reset mid-stream', () => {
		it('sendPing returns unreachable and releases the stream exactly once', async () => {
			const s = resetsAfter(HALF_PING)

			const res = await sendPing(nodeServing(s.stream), peer, PROTOCOL, { timeoutMs: TIMEOUT_MS })

			const u = expectKind(res, 'unreachable')
			expect(u.error.message, 'the reset is preserved on the outcome').to.equal('connection reset by peer')
			// Invariant: released exactly once, and via `close()` because nothing aborted — the read
			// failed on its own rather than being cancelled or timed out.
			expect(release(s), 'released once, by close').to.deep.equal({ closes: 1, aborts: 0 })
		})

		// A reset before any bytes and one mid-frame take different paths through `readFramed`
		// (no length prefix yet vs a partially-read frame), and only the second has partial
		// data that *could* be mis-returned.
		it('sendPing returns unreachable for a reset that lands before any bytes', async () => {
			const s = resetsAfter()

			const res = await sendPing(nodeServing(s.stream), peer, PROTOCOL, { timeoutMs: TIMEOUT_MS })

			const u = expectKind(res, 'unreachable')
			expect(u.error.message).to.equal('connection reset by peer')
			expect(release(s)).to.deep.equal({ closes: 1, aborts: 0 })
		})

		// The contrast that makes the cases above meaningful: the discriminator is still how the
		// read ended, not how much arrived — a reset is `unreachable` (the read died under us),
		// while zero bytes plus a *clean* EOF is a truncated frame and lands as `decode-error`
		// (the peer answered, and answered nothing usable). The pre-migration `ok: false` collapse
		// is gone: an empty reply is no longer dressed up as an answer.
		it('sendPing returns decode-error for a peer that closes without sending', async () => {
			const s = makeStubStream([{ kind: 'eof' }])

			const res = await sendPing(nodeServing(s.stream), peer, PROTOCOL, { timeoutMs: TIMEOUT_MS })

			expectKind(res, 'decode-error')
			expect(release(s)).to.deep.equal({ closes: 1, aborts: 0 })
		})

		it('fetchNeighbors returns unreachable rather than fabricating an empty snapshot', async () => {
			const s = resetsAfter(HALF_SNAPSHOT)

			const res = await fetchNeighbors(nodeServing(s.stream), peer, PROTOCOL, { timeoutMs: TIMEOUT_MS })

			// Invariant: nothing from the truncated bytes reaches the caller. There is no fabricated
			// empty snapshot anywhere anymore — a reset is a distinguishable failure, not a peer that
			// "genuinely has no neighbors".
			const u = expectKind(res, 'unreachable')
			expect(u.error.message).to.equal('connection reset by peer')
			expect(JSON.stringify(res), 'no field parsed out of the partial document').to.not.include('ghost')
			expect(release(s)).to.deep.equal({ closes: 1, aborts: 0 })
		})

		it('sendMaybeAct returns unreachable, and the double close is harmless', async () => {
			const s = resetsAfter(HALF_NEAR_ANCHOR)

			const res = await sendMaybeAct(nodeServing(s.stream), peer, maybeActMsg('reset-mid-stream'), PROTOCOL, { timeoutMs: TIMEOUT_MS })

			const u = expectKind(res, 'unreachable')
			expect(u.error.message).to.equal('connection reset by peer')
			// `sendMaybeAct` half-closes before its read to flush the request (`halfCloseBeforeRead`)
			// and then `releaseRpcStream` closes again from the `finally`. Two `close()` calls, one
			// real release: the second neither throws nor leaks, which is why the exactly-once
			// invariant is stated as "closed or aborted, never leaked" rather than "close called once".
			expect(release(s), 'flush close + release close').to.deep.equal({ closes: 2, aborts: 0 })
			expect(s.sends, 'the request was written before the reply failed').to.equal(1)
		})
	})

	describe('clean EOF mid-payload', () => {
		it('sendPing returns decode-error for a half-received reply', async () => {
			const s = halfThenEof(HALF_PING)

			const res = await sendPing(nodeServing(s.stream), peer, PROTOCOL, { timeoutMs: TIMEOUT_MS })

			// Invariant: never a half-populated reply. The truncated frame's body bytes name
			// `size_estimate`, but a non-`ok` outcome carries no value field at all — "nothing
			// salvaged from the partial document" is structural now.
			expectKind(res, 'decode-error')
			expect(release(s)).to.deep.equal({ closes: 1, aborts: 0 })
		})

		it('fetchNeighbors returns decode-error, with nothing taken from the truncated bytes', async () => {
			const s = halfThenEof(HALF_SNAPSHOT)

			const res = await fetchNeighbors(nodeServing(s.stream), peer, PROTOCOL, { timeoutMs: TIMEOUT_MS })

			expectKind(res, 'decode-error')
			expect(JSON.stringify(res)).to.not.include('ghost')
			expect(release(s)).to.deep.equal({ closes: 1, aborts: 0 })
		})

		it('sendMaybeAct returns decode-error rather than a half-decoded NearAnchor', async () => {
			const s = halfThenEof(HALF_NEAR_ANCHOR)

			const res = await sendMaybeAct(nodeServing(s.stream), peer, maybeActMsg('half-json'), PROTOCOL, { timeoutMs: TIMEOUT_MS })

			// Invariant: the truncated document is never handed back as an answer. Under framing the
			// read itself refuses the incomplete frame — no decode ever runs on partial bytes — and
			// the read's own error is preserved on the outcome.
			const d = expectKind(res, 'decode-error')
			expect(
				['FrameTruncationError', 'UnexpectedEOFError'],
				'the framed read is what failed'
			).to.include(d.error.name)
			expect(release(s)).to.deep.equal({ closes: 2, aborts: 0 })
		})

		// The headline of the sender migration (`15.2-rpc-sender-migration`): one piece of
		// evidence, ONE answer. Before `rpcRequest`, the three senders reported an undecodable
		// reply three different ways — ping collapsed it into `ok: false`, fetchNeighbors
		// fabricated an empty snapshot, sendMaybeAct threw — and the service consequently booked a
		// contact strike on the maybeAct path and none on the ping path for identical evidence.
		// All three now return `decode-error`; the converged service consequence is pinned end to
		// end further down.
		it('reports one undecodable reply the same way across all three senders', async () => {
			const pingRes = await sendPing(
				nodeServing(halfThenEof(HALF_PING).stream), peer, PROTOCOL, { timeoutMs: TIMEOUT_MS }
			)
			const snapRes = await fetchNeighbors(
				nodeServing(halfThenEof(HALF_SNAPSHOT).stream), peer, PROTOCOL, { timeoutMs: TIMEOUT_MS }
			)
			const actRes = await sendMaybeAct(
				nodeServing(halfThenEof(HALF_NEAR_ANCHOR).stream), peer,
				maybeActMsg('convergence'), PROTOCOL, { timeoutMs: TIMEOUT_MS }
			)

			expect(pingRes.kind, 'ping').to.equal('decode-error')
			expect(snapRes.kind, 'neighbors').to.equal('decode-error')
			expect(actRes.kind, 'maybeAct').to.equal('decode-error')
		})
	})

	// These three end on the RPC's own budget — and unlike the pre-migration senders, which armed
	// two timers from the same `timeoutMs` and raced them, `rpcRequest` reads on the deadline alone.
	// So both the outcome (`timeout`) and the release arm are deterministic: the deadline signal has
	// fired before the `finally` runs, and `releaseRpcStream` provably takes the synchronous
	// `abort()` — a stalled remote is never cleaned up with the unbounded `close()`.
	describe('partial then stall', () => {
		it('sendPing times out within its budget and releases the stream by abort', async () => {
			const s = partialThenStall(HALF_PING)

			const t0 = Date.now()
			const res = await sendPing(nodeServing(s.stream), peer, PROTOCOL, { timeoutMs: TIMEOUT_MS })
			const elapsed = Date.now() - t0

			expectKind(res, 'timeout')
			// Bounded, not merely eventual: "it timed out" would pass at ten minutes.
			elapsedBounded(elapsed)
			expect(release(s), 'released once, by abort').to.deep.equal({ closes: 0, aborts: 1 })
		})

		it('fetchNeighbors times out within its budget and releases the stream by abort', async () => {
			const s = partialThenStall(HALF_SNAPSHOT)

			const t0 = Date.now()
			const res = await fetchNeighbors(nodeServing(s.stream), peer, PROTOCOL, { timeoutMs: TIMEOUT_MS })
			const elapsed = Date.now() - t0

			expectKind(res, 'timeout')
			expect(JSON.stringify(res)).to.not.include('ghost')
			elapsedBounded(elapsed)
			expect(release(s)).to.deep.equal({ closes: 0, aborts: 1 })
		})

		it('sendMaybeAct times out within its budget and releases by abort after its flush close', async () => {
			const s = partialThenStall(HALF_NEAR_ANCHOR)

			const t0 = Date.now()
			const res = await sendMaybeAct(nodeServing(s.stream), peer, maybeActMsg('stall'), PROTOCOL, { timeoutMs: TIMEOUT_MS })
			const elapsed = Date.now() - t0

			expectKind(res, 'timeout')
			elapsedBounded(elapsed)
			// The `close()` is the pre-read request flush; the release itself is the abort.
			expect(release(s), 'flush close + release abort').to.deep.equal({ closes: 1, aborts: 1 })
			expect(s.sends, 'the request was written before the reply stalled').to.equal(1)
		})
	})

	// The caller's signal is the *only* clock here — it is aborted well before the deliberately
	// huge deadline could fire — so the outcome is `cancelled` rather than `timeout`, and
	// `releaseRpcStream` provably takes its `abort()` arm: the signal has fired before the
	// `finally` runs. The `cancelled` variant carries no error — the kind IS the assertion; the
	// caller's own abort reason is not evidence about the peer and is not transported.
	describe('the caller cancels mid-stream', () => {
		/** Abort `ac` at the start of the read that follows the first chunk — bytes in, then a cancel. */
		function cancelAfterFirstChunk(ac: AbortController, bytes: Uint8Array): StubStream {
			return partialThenStall(bytes, {
				onNext: (call) => { if (call === 2) ac.abort(new Error('caller gave up')) },
			})
		}

		it('sendPing returns cancelled and releases by abort', async () => {
			const ac = new AbortController()
			const s = cancelAfterFirstChunk(ac, HALF_PING)

			const t0 = Date.now()
			// A budget far past the abort, so only the caller's signal can end this.
			const res = await sendPing(nodeServing(s.stream), peer, PROTOCOL, { signal: ac.signal, timeoutMs: 60_000 })

			expectKind(res, 'cancelled')
			expect(s.delivered, 'the cancel really landed mid-stream').to.equal(1)
			expect(release(s), 'released once, by abort').to.deep.equal({ closes: 0, aborts: 1 })
			expect(Date.now() - t0, 'must not wait out its own budget').to.be.at.most(MAX_MS)
		})

		it('sendMaybeAct returns cancelled and releases by abort', async () => {
			const ac = new AbortController()
			const s = cancelAfterFirstChunk(ac, HALF_NEAR_ANCHOR)

			const res = await sendMaybeAct(
				nodeServing(s.stream), peer, maybeActMsg('cancelled'), PROTOCOL,
				{ signal: ac.signal, timeoutMs: 60_000 }
			)

			expectKind(res, 'cancelled')
			expect(release(s), 'flush close + release abort').to.deep.equal({ closes: 1, aborts: 1 })
		})

		it('fetchNeighbors returns cancelled rather than dressing the abort up as an empty snapshot', async () => {
			const ac = new AbortController()
			const s = cancelAfterFirstChunk(ac, HALF_SNAPSHOT)

			const res = await fetchNeighbors(
				nodeServing(s.stream), peer, PROTOCOL, { signal: ac.signal, timeoutMs: 60_000 }
			)

			// Before the migration `fetchNeighbors` swallowed its own cancellation into a fabricated
			// empty snapshot — which is why `fetchAndMergeSnapshot` used to overcount
			// `snapshotsFetched` on a cancelled tick. The outcome switch ended both: a cancelled
			// fetch is `cancelled`, and the caller records nothing.
			expectKind(res, 'cancelled')
			expect(JSON.stringify(res)).to.not.include('ghost')
			expect(release(s)).to.deep.equal({ closes: 0, aborts: 1 })
		})
	})

	describe('trailing bytes after the first frame', () => {
		// A single-frame read ends the moment the counted body arrives, so whatever the peer queues
		// behind its reply — more bytes, a delayed reset — is never pulled. This pins that at the
		// sender level: the reject step scripted *after* the complete frame would surface as a read
		// failure (or an unhandled rejection) if anything ever asked for it; `delivered === 1` plus
		// the suite-wide `unhandledRejection` guard prove nothing did.
		it('answers from the first frame and never pulls the reset queued behind it', async () => {
			const s = makeStubStream([
				{ kind: 'chunk', bytes: frame(PING_OK) },
				{ kind: 'reject', error: new Error('muxer reset after the reply'), afterMs: 40 },
			])

			const res = await sendPing(nodeServing(s.stream), peer, PROTOCOL, { timeoutMs: 2000 })

			const ok = expectKind(res, 'ok')
			expect(ok.value.ok, 'the complete framed reply was the answer').to.equal(true)
			expect(ok.value.size_estimate).to.equal(42)
			expect(ok.rttMs, 'a real round trip was measured').to.be.a('number').and.to.be.at.least(0)
			expect(s.delivered, 'exactly one pull — the trailing step never ran').to.equal(1)
			expect(release(s)).to.deep.equal({ closes: 1, aborts: 0 })
			// Were the trailing step ever pulled, give its rejection time to land under the guard.
			await sleep(80)
		})
	})

	describe('a reset at the byte cap', () => {
		// Both failures are available in the same read: `sendPing`'s cap is 1024 bytes and the reset
		// is queued behind a frame whose prefix declares 2048. `readFramed` refuses at the prefix —
		// before any body byte — so the following `iter.next()` is never called and the cap wins
		// deterministically. An over-cap reply came from a peer that answered, so it classifies as
		// `decode-error` — an unusable answer — not `unreachable`.
		it('reports the payload cap, not the reset', async () => {
			const s = makeStubStream([
				{ kind: 'chunk', bytes: frame(new Uint8Array(2048)) },
				{ kind: 'reject', error: reset() },
			])

			const res = await sendPing(nodeServing(s.stream), peer, PROTOCOL, { timeoutMs: TIMEOUT_MS })

			const d = expectKind(res, 'decode-error')
			expect(d.error.message, 'the cap wins').to.include('payload too large')
			expect(d.error.message).to.not.include('connection reset')
			expect(release(s)).to.deep.equal({ closes: 1, aborts: 0 })
		})
	})

	// Announce and leave have no read to fail, so their arm is the write-side reset — and the point
	// is that they release the stream either way, since outbound stream caps are finite (libp2p's
	// default 64 per protocol per connection) and a leaked stream is a real ceiling. Both now
	// return an outcome: a failed write is `unreachable` — `sendLeave` no longer propagates it as a
	// throw, and `announceNeighbors` no longer swallows it silently.
	describe('the write-only RPCs', () => {
		const snapshot = (): NeighborSnapshotV1 => ({
			v: 1, from: peer, timestamp: Date.now(), successors: [], predecessors: [], sig: '',
		})

		it('announceNeighbors returns unreachable for a reset while writing and still releases the stream', async () => {
			const s = makeStubStream([], { sendThrows: reset() })

			// `dial: true`: the default is connection-only, and this stub node reports a connection
			// anyway, but stating it keeps the case aligned with the service's announce choke point.
			const res = await announceNeighbors(nodeServing(s.stream), peer, snapshot(), PROTOCOL, { dial: true, timeoutMs: TIMEOUT_MS })

			expectKind(res, 'unreachable')
			expect(s.sends, 'the write was attempted').to.equal(1)
			expect(release(s), 'released once despite the failed write').to.deep.equal({ closes: 1, aborts: 0 })
		})

		it('sendLeave returns unreachable for a reset while writing and still releases the stream', async () => {
			const s = makeStubStream([], { sendThrows: reset() })

			const res = await sendLeave(
				nodeServing(s.stream), peer, { v: 1, from: peer, timestamp: Date.now() },
				PROTOCOL, { timeoutMs: TIMEOUT_MS }
			)

			const u = expectKind(res, 'unreachable')
			expect(u.error.message, 'the reset is preserved on the outcome').to.equal('connection reset by peer')
			expect(s.sends).to.equal(1)
			expect(release(s)).to.deep.equal({ closes: 1, aborts: 0 })
		})
	})

	// ------------------------------------------------------------------------------------------
	// What the *service* records about a peer whose reply failed partway through. The sender-level
	// cases above pin the return shapes; these pin the evidence, which is the half that decides
	// whether a peer stays in the ring.
	// ------------------------------------------------------------------------------------------
	describe('what the service records', () => {
		let node: Libp2p
		let svc: CoreFretService
		let store: DigitreeStore
		let originalGetConnections: (pid?: PeerId) => Connection[]
		let served: Stream | undefined

		beforeEach(async () => {
			node = await createMemNode()
			await node.start()
			// Deliberately not started: a live stabilization loop would probe these peers on its own
			// schedule and make every count below non-deterministic.
			svc = new CoreFretService(node, { profile: 'core', networkName: 'net-test' })
			store = svc.getStore()
			served = undefined
			originalGetConnections = node.getConnections.bind(node) as (pid?: PeerId) => Connection[]
			// Every outbound RPC funnels through `openRpcStream`, which consults
			// `node.getConnections(pid)` before dialing — so one stub connection per peer is per-peer
			// control of every RPC in one place (the same device `test/helpers/maintenance-rig.ts` uses).
			;(node as unknown as { getConnections: (pid?: PeerId) => Connection[] }).getConnections =
				(pid?: PeerId): Connection[] => {
					if (pid == null || served == null) return []
					return [{
						status: 'open',
						remoteAddr: { toString: () => '/memory/stub' },
						newStream: async () => served!,
					}] as unknown as Connection[]
				}
		})

		afterEach(async () => {
			;(node as unknown as { getConnections: (pid?: PeerId) => Connection[] }).getConnections = originalGetConnections
			try { await svc.stop() } catch {}
			await stopAll([node])
		})

		function serve(s: StubStream): StubStream {
			served = s.stream
			return s
		}

		/**
		 * One live member sitting immediately clockwise of `keyBytes`'s coordinate — the only
		 * routing candidate, so `routeAct`'s forward hop is deterministic. Self is not in the store,
		 * so `neighborDistance` returns Infinity and the message must forward rather than act.
		 */
		async function seedHopBesideKey(keyBytes: Uint8Array): Promise<string> {
			const pid = peerIdFromPrivateKey(await generateKeyPair('Ed25519'))
			const id = pid.toString()
			store.upsert(id, ringOffset(await hashKey(keyBytes), 1))
			store.setMembership(id, 'member')
			;(svc as unknown as { setAddressKnown(id: string, known: boolean): void }).setAddressKnown(id, true)
			return id
		}

		/** A live member at its true ring coordinate, for the probe paths (which need no key). */
		async function seedMember(): Promise<string> {
			const pid = peerIdFromPrivateKey(await generateKeyPair('Ed25519'))
			const id = pid.toString()
			store.upsert(id, await hashPeerId(pid))
			store.setMembership(id, 'member')
			;(svc as unknown as { setAddressKnown(id: string, known: boolean): void }).setAddressKnown(id, true)
			return id
		}

		/** Stand in for the ≥500 ms spacing interval between independent contact observations. */
		function unspace(id: string): void {
			store.update(id, { lastContactFailureAt: 0 })
			;(svc as unknown as { clearBackoff(id: string): void }).clearBackoff(id)
		}

		it('books one contact strike — and no membership evidence — for a hop that resets mid-reply', async () => {
			const keyBytes = enc.encode('reset-forward-key')
			const hop = await seedHopBesideKey(keyBytes)
			serve(resetsAfter(HALF_NEAR_ANCHOR))

			const before = svc.getDiagnostics().maybeActForwarded
			const res = await svc.routeAct(maybeActMsg('reset-forward', keyBytes))

			// The counter increments just before the send, so it is what proves the forward path was
			// taken rather than the message being answered in-cluster.
			expect(svc.getDiagnostics().maybeActForwarded, 'forward path taken').to.equal(before + 1)
			expect(res, 'the honest "did not forward" answer').to.have.property('anchors')

			const e = store.getById(hop)!
			// Invariant: a reset mid-stream is a failed *contact* — the read died, so we never reached
			// the peer's answer — and is never membership evidence.
			expect(e.contactFailures, 'one failed contact').to.equal(1)
			expect(e.negotiateFailures, 'a reset says nothing about which network it serves').to.equal(0)
			expect(e.membership, 'not demoted').to.equal('member')
			expect(e.state, 'one strike is not a run').to.not.equal('dead')
		})

		it('marks a hop dead after three spaced resets', async () => {
			const keyBytes = enc.encode('reset-run-key')
			const hop = await seedHopBesideKey(keyBytes)

			for (let i = 0; i < 3; i++) {
				serve(resetsAfter(HALF_NEAR_ANCHOR)) // a fresh script per attempt
				await svc.routeAct(maybeActMsg(`reset-run-${i}`, keyBytes))
				if (i < 2) unspace(hop)
			}

			expect(store.getById(hop)?.contactFailures).to.equal(3)
			expect(store.getById(hop)?.state).to.equal('dead')
			expect(store.getById(hop)?.membership, 'liveness, not membership').to.equal('member')
		})

		it('books relevance decay — not a contact strike — for a hop that answers with a truncated reply', async () => {
			const keyBytes = enc.encode('half-json-forward-key')
			const hop = await seedHopBesideKey(keyBytes)
			serve(halfThenEof(HALF_NEAR_ANCHOR))

			await svc.routeAct(maybeActMsg('half-json-forward', keyBytes))

			const e = store.getById(hop)!
			// This peer accepted the stream, replied, and merely replied *badly*: it is demonstrably
			// alive. `sendMaybeAct` returns `decode-error`, and `noteRpcFailure` books that as
			// relevance decay alone — three such replies can no longer mark a live peer dead. (Before
			// the sender migration the truncation error propagated as a throw, every non-negotiate
			// throw was classified as unreachability, and this same case earned a contact strike.)
			expect(e.contactFailures, 'an answered-but-undecodable reply is not unreachability').to.equal(0)
			expect(e.failureCount, 'relevance decay is what is recorded').to.equal(1)
			// Invariant: an answered-but-undecodable reply is not negotiate-failure evidence either,
			// so it can never demote the peer to `foreign`.
			expect(e.negotiateFailures, 'no negotiate failure').to.equal(0)
			expect(e.membership, 'never demoted to foreign by a decode error').to.equal('member')
		})

		// The other half of the old divergence, now converged: identical evidence on the ping path
		// books the identical answer. `sendPing` returns `decode-error` (the `ok: false` collapse is
		// gone), and `probeNeighborLatency` records a failed ping plus relevance decay — never a
		// contact strike, because the peer demonstrably answered.
		it('books no strike for the same truncated reply on the ping path', async () => {
			const id = await seedMember()
			serve(halfThenEof(HALF_PING))

			await (svc as unknown as {
				probeNeighborLatency(id: string, signal: AbortSignal | undefined): Promise<void>
			}).probeNeighborLatency(id, undefined)

			const e = store.getById(id)!
			expect(e.contactFailures, 'the peer answered, so it is alive').to.equal(0)
			expect(e.failureCount, 'relevance decay is all that is recorded').to.equal(1)
			expect(e.state).to.not.equal('dead')
			expect(svc.getDiagnostics().pingsFail, 'counted as a failed ping, not a failed contact').to.equal(1)
		})

		it('records nothing about a peer when our own signal aborts mid-reply', async () => {
			const id = await seedMember()
			const ac = new AbortController()
			;(svc as unknown as { runAbort: AbortController }).runAbort = ac
			const s = serve(partialThenStall(HALF_PING, {
				onNext: (call) => { if (call === 2) ac.abort(new Error('service stopped')) },
			}))

			const before = { ...svc.getDiagnostics() }
			await (svc as unknown as {
				probeNeighborLatency(id: string, signal: AbortSignal | undefined): Promise<void>
			}).probeNeighborLatency(id, ac.signal)

			// Invariant: our own cancellation is never evidence about the peer — no contact strike, no
			// relevance decay, no backoff, no `pingsFail`, whether it lands before the dial or (as
			// here) with bytes already buffered. The `cancelled` outcome is what makes this explicit:
			// the probe switches on it and records nothing.
			expect(svc.getDiagnostics().pingsSent, 'no ping counted').to.equal(before.pingsSent)
			expect(svc.getDiagnostics().pingsFail, 'no ping failure counted').to.equal(before.pingsFail)
			const e = store.getById(id)!
			expect(e.contactFailures, 'no contact strike').to.equal(0)
			expect(e.failureCount, 'no relevance decay').to.equal(0)
			expect(e.negotiateFailures, 'no membership evidence').to.equal(0)
			expect(e.membership, 'not demoted').to.equal('member')
			expect(e.state, 'not marked dead').to.not.equal('dead')
			expect((svc as unknown as { backoffMap: Map<string, unknown> }).backoffMap.get(id), 'no backoff').to.equal(undefined)
			expect(s.delivered, 'the cancel really landed mid-stream').to.equal(1)
			expect(release(s), 'released once, by abort').to.deep.equal({ closes: 0, aborts: 1 })
		})

		// Non-vacuity for the case above: the same peer, the same probe, a live run — a reset instead
		// of a cancellation, so the failure is genuinely about the peer and is scored exactly once.
		it('still strikes once from the same probe when the run is live', async () => {
			const id = await seedMember()
			;(svc as unknown as { runAbort: AbortController }).runAbort = new AbortController()
			serve(resetsAfter(HALF_PING))

			await (svc as unknown as {
				probeNeighborLatency(id: string, signal: AbortSignal | undefined): Promise<void>
			}).probeNeighborLatency(id, (svc as unknown as { runSignal: AbortSignal | undefined }).runSignal)

			expect(store.getById(id)?.contactFailures, 'one strike').to.equal(1)
			expect(svc.getDiagnostics().pingsFail).to.equal(1)
		})
	})

	// The stub shapes above are only worth what they share with the real transport. The old read
	// primitive's missed-EOF bug is the precedent: a stub-only suite agreed with itself and not
	// with libp2p. Both stub-only shapes that a live peer *can* be made to produce are re-driven here
	// over TCP + noise + yamux: a clean EOF mid-frame, and a reset mid-reply (the responder calls
	// `Stream.abort()` after a partial write — what a handler that throws mid-reply does now that
	// `registerRpcHandler` releases handler streams on error). The stall shape has no
	// real-transport counterpart worth the wall time: it is a responder doing nothing, and asserting
	// it means spending a full RPC budget per case. One live-muxer nuance the stubs cannot show: a
	// reset may or may not deliver the buffered bytes before failing the read, so the reset cases
	// accept either failure outcome (`unreachable` when the read died, `decode-error` when the
	// truncated frame arrived first); a clean half-close always delivers its bytes, so that arm is
	// pinned exactly.
	describe('over a real transport', () => {
		let a: Libp2p
		let b: Libp2p

		beforeEach(async () => {
			a = await createMemoryNode(); await a.start()
			b = await createMemoryNode(); await b.start()
		})

		afterEach(async () => { await stopAll([a, b]) })

		/** Register `reply` on `a` for `protocol`, then connect `b` to it. */
		async function serving(protocol: string, reply: (stream: Stream) => void | Promise<void>): Promise<string> {
			await a.handle(protocol, reply)
			await b.dial(a.getMultiaddrs()[0]!)
			return a.peerId.toString()
		}

		/** Half a reply, then a tidy half-close. */
		const halfThenClose = (bytes: Uint8Array) => async (stream: Stream): Promise<void> => {
			stream.send(bytes)
			await stream.close()
		}

		/** Half a reply, then a muxer-level reset — the live analogue of `resetsAfter`. */
		const halfThenReset = (bytes: Uint8Array) => (stream: Stream): void => {
			stream.send(bytes)
			stream.abort(new Error('handler failed mid-reply'))
		}

		/** The outbound stream must be released rather than held until the muxer times it out. */
		async function expectStreamReleased(protocol: string): Promise<void> {
			const conn = b.getConnections(a.peerId)[0]!
			await waitUntil(
				() => conn.streams.every((s) => s.protocol !== protocol),
				1000, `the outbound ${protocol} stream is released`
			)
		}

		/**
		 * Neither shape is a stall, so neither may run to the RPC budget — and the bound is set an
		 * order of magnitude under it, because that is what measures the property the deleted 20 ms
		 * EOF poll used to provide: a stream that genuinely ends without a whole frame must fail
		 * *promptly*, which the replacement gets for free by failing at the stream's own layer. Half
		 * the budget would not measure that — half a budget is what a *slow* answer looks like, not
		 * what a prompt failure looks like. A ratio rather than a tight millisecond bound because the
		 * property is "nowhere near the deadline", not scheduler precision, and a tight bound would
		 * flake on CI. Safe at every call site: each measures over an already-established loopback
		 * connection, since the dial happens in `serving`, outside the timed window.
		 */
		function expectPrompt(elapsed: number): void {
			expect(elapsed, `took ${elapsed}ms of a ${RPC_TIMEOUT_MS}ms budget`).to.be.lessThan(RPC_TIMEOUT_MS / 10)
		}

		it('fetchNeighbors answers decode-error, promptly, for a peer that writes half a snapshot and closes', async () => {
			const id = await serving(PROTOCOL_NEIGHBORS, halfThenClose(HALF_SNAPSHOT))

			const t0 = Date.now()
			const res = await fetchNeighbors(b, id, PROTOCOL_NEIGHBORS)

			expectKind(res, 'decode-error')
			expect(JSON.stringify(res), 'nothing parsed out of the truncated document').to.not.include('ghost')
			expectPrompt(Date.now() - t0)
			await expectStreamReleased(PROTOCOL_NEIGHBORS)
		})

		// The reset shape otherwise rests entirely on stubs, which is exactly the arrangement the
		// missed-EOF bug got wrong. Over a live muxer the reset may surface as a read failure
		// (`unreachable`) or, if the buffered bytes are delivered first, as a truncated frame
		// (`decode-error`) — either way a failure outcome, never an answer.
		it('fetchNeighbors answers a failure outcome, promptly, for a peer that resets mid-reply', async () => {
			const id = await serving(PROTOCOL_NEIGHBORS, halfThenReset(HALF_SNAPSHOT))

			const t0 = Date.now()
			const res = await fetchNeighbors(b, id, PROTOCOL_NEIGHBORS)

			expect(['unreachable', 'decode-error'], 'a failure outcome, never a snapshot').to.include(res.kind)
			expect(JSON.stringify(res), 'no field parsed out of the partial document').to.not.include('ghost')
			expectPrompt(Date.now() - t0)
			await expectStreamReleased(PROTOCOL_NEIGHBORS)
		})

		// Ping is the other sender a live peer can be driven against. Before the migration it had a
		// res/thrown split here — a truncated reply collapsed into `ok: false` while a reset threw —
		// and the case had to accept whichever arm the muxer produced. Outcomes collapse the split:
		// nothing throws, a truncated reply is `decode-error`, and the reset arm is one of the two
		// failure kinds depending on whether the buffered bytes arrived first.
		it('sendPing answers decode-error for a real half-reply, and a failure outcome for a real reset', async () => {
			const halfId = await serving(PROTOCOL_PING, halfThenClose(HALF_PING))
			const half = await sendPing(b, halfId, PROTOCOL_PING)

			expectKind(half, 'decode-error')
			await expectStreamReleased(PROTOCOL_PING)

			await a.unhandle(PROTOCOL_PING)
			await a.handle(PROTOCOL_PING, halfThenReset(HALF_PING))

			const t0 = Date.now()
			const res = await sendPing(b, halfId, PROTOCOL_PING)
			expectPrompt(Date.now() - t0)

			expect(['unreachable', 'decode-error'], 'reset: a failure outcome, never an answer').to.include(res.kind)
			await expectStreamReleased(PROTOCOL_PING)
		})
	})
})

/** A minimal well-formed `RouteAndMaybeAct`; `keyBytes` defaults to a constant the senders ignore. */
function maybeActMsg(correlationId: string, keyBytes = new Uint8Array([1, 2, 3])): RouteAndMaybeActV1 {
	return {
		v: 1,
		key: coordToBase64url(keyBytes),
		// `want_k: 2` floors the in-cluster window at 2, matching `inClusterWindow`'s own floor, so
		// the service-level cases forward through exactly one seeded hop.
		want_k: 2,
		ttl: 4,
		min_sigs: 1,
		correlation_id: correlationId,
		timestamp: Date.now(),
		signature: '',
	}
}
