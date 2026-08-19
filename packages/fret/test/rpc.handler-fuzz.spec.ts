import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { Connection, PeerId, Stream } from '@libp2p/interface'
import { createIdentifyNode, createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { decodeJson, encodeJson, isFrameTruncationError, makeProtocols, readFramed, registerRpcHandler, sendFramed } from '../src/rpc/protocols.js'
import { registerMaybeAct } from '../src/rpc/maybe-act.js'
import { parseRouteAndMaybeAct } from '../src/rpc/validate.js'
import { registerLeave } from '../src/rpc/leave.js'
import { registerPing } from '../src/rpc/ping.js'
import { registerNeighbors } from '../src/rpc/neighbors.js'
import { coordToBase64url, hashKey } from '../src/ring/hash.js'
import type { LeaveNoticeV1 } from '../src/rpc/leave.js'
import type { NearAnchorV1, NeighborSnapshotV1 } from '../src/index.js'
import * as lp from 'it-length-prefixed'
import { toString as u8ToString } from 'uint8arrays/to-string'
import type { Uint8ArrayList } from 'uint8arraylist'

// Fault isolation for the *receive* side of every FRET protocol. Before `registerRpcHandler`
// (`src/rpc/protocols.ts`), each inbound handler's catch logged and returned without releasing
// its stream — and ping's reply tail sat outside any try at all. libp2p counts inbound streams
// per protocol per connection (default cap 32, since FRET passes no `maxInboundStreams`), so
// every message a handler threw on permanently consumed one slot: 32 unparseable messages over
// one connection and that peer could never use that protocol on that connection again.
//
// Three tiers:
//   1. Unit — `registerRpcHandler`'s release accounting on stub streams: exactly one release
//      per stream, `close()` for completed replies and normal drops, `abort()` for errors,
//      nothing for a stream the remote already reset.
//   2. Service — `handleMaybeAct`'s structural validator: metered by the token bucket, rejects
//      statically, never caches, counts `diag.rejected.malformed`.
//   3. Wire — the malformed matrix (the shapes that each leaked a stream, measured) over the
//      memory transport, plus the headline batch-then-recover case over TCP + noise + yamux,
//      matching how `rpc.stream-errors.spec.ts` splits transport coverage.
//
// Oversized payloads and rate-limit *enforcement* tiers belong to `7.5-rpc-codec-property-tests`.

const enc = new TextEncoder()
const dec = new TextDecoder()

const NETWORK = 'fuzz-test'
const P = makeProtocols(NETWORK)

/**
 * A parseable Ed25519 peer id string built from `seed`: an identity multihash (0x00, len 0x24)
 * over a protobuf-encoded public key (0x08 0x01 0x12 0x20 + 32 key bytes), base58btc-encoded.
 * The bytes need not be a real curve point — `peerIdFromString` parses, it does not verify —
 * but they must be *shaped* like a peer id, because the wire-shape parsers reject a `from`
 * that will not parse before any handler-level identity check runs.
 */
function peerIdStr(seed: number): string {
	const mh = new Uint8Array(38)
	mh.set([0x00, 0x24, 0x08, 0x01, 0x12, 0x20], 0)
	mh.fill(seed, 6)
	return u8ToString(mh, 'base58btc')
}

/** Two distinct, parseable peer ids: 'who the message claims' vs 'who the transport says'. */
const PEER_CLAIMED = peerIdStr(1)
const PEER_ACTUAL = peerIdStr(2)

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

/** Poll `predicate` until true, or fail after `limitMs`. */
async function waitUntil(predicate: () => boolean, limitMs: number, what: string): Promise<void> {
	const until = Date.now() + limitMs
	while (!predicate() && Date.now() < until) await sleep(10)
	expect(predicate(), `${what} within ${limitMs}ms`).to.equal(true)
}

let seq = 0

/** A structurally valid `RouteAndMaybeAct` as a plain record, so rows can corrupt any field. */
function baseMsg(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		v: 1,
		key: coordToBase64url(enc.encode(`fuzz-key-${seq}`)),
		want_k: 2,
		ttl: 4,
		min_sigs: 1,
		correlation_id: `fuzz-${++seq}`,
		timestamp: Date.now(),
		signature: '',
		...over,
	}
}

function withoutKey(): Record<string, unknown> {
	const m = baseMsg()
	delete m.key
	return m
}

// ---------------------------------------------------------------------------------------------
// Unit tier: stub streams with libp2p's status lifecycle, so release-exactly-once is countable.
// ---------------------------------------------------------------------------------------------

interface InboundStub {
	stream: Stream
	closes: number
	aborts: number
	sends: number
	/** `close()` calls that hung rather than completing (only when `closeHangs`). */
	closeAttempts: number
	/** Reply frames the handler wrote (empty when `sendThrows`). `sendFramed` passes a `Uint8ArrayList`. */
	replies: Array<Uint8Array | Uint8ArrayList>
	status: () => string
}

interface InboundStubOpts {
	/** Make `send()` throw — the shape ping's unguarded tail used to die on. */
	sendThrows?: Error
	/** First read throws and flips status to `reset` — the remote tore the stream down. */
	resetOnRead?: boolean
	/** `close()` never resolves on its own — the remote accepted the reply and stopped reading. */
	closeHangs?: boolean
}

function inboundStub(chunks: Uint8Array[], opts: InboundStubOpts = {}): InboundStub {
	let status = 'open'
	// Modelled on libp2p's own lifecycle, which the wrapper's release accounting reads: `close()`
	// closes the *write* end only and early-returns once it has, while `status` stays 'open' until
	// the remote closes its write end too — which for a FRET sender happens only after it has read
	// the reply. A stub that flipped `status` to 'closed' on close would let the wrapper pass its
	// assertions here for a reason production never supplies.
	let writeStatus = 'writable'
	let i = 0
	const rec: InboundStub = {
		stream: undefined as unknown as Stream,
		closes: 0, aborts: 0, sends: 0, closeAttempts: 0, replies: [],
		status: () => status,
	}
	const stream = {
		id: 'stub-inbound',
		get status() { return status },
		get writeStatus() { return writeStatus },
		send: (b: Uint8Array | Uint8ArrayList): boolean => {
			rec.sends++
			if (opts.sendThrows) throw opts.sendThrows
			rec.replies.push(b)
			return true
		},
		close: async (o?: { signal?: AbortSignal }): Promise<void> => {
			if (writeStatus === 'closed') return
			// A remote that accepted the reply and stopped reading: `close()` resolves only once
			// pending data reached the transport, so it hangs until the caller's budget fires.
			// `writeStatus` sits at 'closing' meanwhile, which is what leaves the wrapper's abort
			// arm eligible when the budget does fire.
			if (opts.closeHangs) {
				rec.closeAttempts++
				writeStatus = 'closing'
				return await new Promise<void>((_res, rej) => {
					const s = o?.signal
					if (s == null) return // never settles — the unbudgeted behavior under test
					s.addEventListener('abort', () => { rej(new Error('close aborted')) }, { once: true })
				})
			}
			rec.closes++
			writeStatus = 'closed'
		},
		abort: (_e: Error): void => {
			rec.aborts++
			status = 'aborted'
			writeStatus = 'closed'
		},
		[Symbol.asyncIterator]: () => ({
			next: async (): Promise<IteratorResult<Uint8Array>> => {
				if (opts.resetOnRead) {
					status = 'reset'
					writeStatus = 'closed'
					throw new Error('stream reset by remote')
				}
				return i < chunks.length
					? { done: false, value: chunks[i++]! }
					: { done: true, value: undefined }
			},
		}),
	}
	rec.stream = stream as unknown as Stream
	return rec
}

type InboundHandler = (stream: Stream, connection: Connection) => Promise<void>

/** A node that only records handlers, so a registered handler can be invoked directly. */
function fakeNode(): { node: Libp2p; invoke: (protocol: string, stream: Stream, remote: string) => Promise<void> } {
	const handlers = new Map<string, InboundHandler>()
	const node = {
		handle: async (protocol: string, h: InboundHandler): Promise<void> => { handlers.set(protocol, h) },
	} as unknown as Libp2p
	const invoke = async (protocol: string, stream: Stream, remote: string): Promise<void> => {
		const h = handlers.get(protocol)
		expect(h, `a handler is registered for ${protocol}`).to.not.equal(undefined)
		await h!(stream, { remotePeer: { toString: () => remote } } as unknown as Connection)
	}
	return { node, invoke }
}

/** One length-prefixed frame carrying `text`, as the framed handlers now read. */
function framed(text: string): Uint8Array {
	return lp.encode.single(enc.encode(text)).subarray()
}

function json(obj: unknown): Uint8Array {
	return framed(JSON.stringify(obj))
}

/** Unframe and decode a handler reply — handlers reply framed via `sendFramed`. */
async function decodeFramed<T>(frame: Uint8Array | Uint8ArrayList): Promise<T> {
	const source = (async function* () { yield frame })()
	return await decodeJson<T>(await readFramed(source, 1024 * 1024, 1000))
}

describe('RPC handler fault isolation', function () {
	this.timeout(30000)

	// No case in this file may leak a rejection — ping's old unguarded reply tail was exactly
	// that shape. Registered on this describe, not at file top level (a top-level hook is a
	// *root* hook and would run against the whole suite).
	const unhandled: unknown[] = []
	const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }

	before(() => { process.on('unhandledRejection', onUnhandled) })
	after(() => { process.off('unhandledRejection', onUnhandled) })

	afterEach(async () => {
		await sleep(20) // detection is a tick behind the rejection
		const seen = unhandled.splice(0).map((r) => (r instanceof Error ? r.message : String(r)))
		expect(seen, 'unhandled rejection escaped').to.deep.equal([])
	})

	describe('registerRpcHandler release accounting', () => {
		it('closes a completed ping reply exactly once, from the seam', async () => {
			const { node, invoke } = fakeNode()
			await registerPing(node, P.PROTOCOL_PING)
			const s = inboundStub([])

			await invoke(P.PROTOCOL_PING, s.stream, 'peer-a')

			// The close comes from the seam — no FRET handler body closes for itself — and it is
			// the only release: a completed reply is never turned into an abort.
			expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 1, aborts: 0 })
			const pong = await decodeFramed<{ ok: boolean }>(s.replies[0]!)
			expect(pong.ok).to.equal(true)
		})

		it('closes a stream the handler returned without releasing', async () => {
			const { node, invoke } = fakeNode()
			await registerRpcHandler(node, '/test/forgot-to-close', async () => { /* no release */ })
			const s = inboundStub([])

			await invoke('/test/forgot-to-close', s.stream, 'peer-a')

			expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 1, aborts: 0 })
		})

		it('aborts exactly once when the handler throws, and the handler promise resolves', async () => {
			const { node, invoke } = fakeNode()
			await registerRpcHandler(node, '/test/throws', async () => { throw new Error('handler blew up') })
			const s = inboundStub([])

			await invoke('/test/throws', s.stream, 'peer-a') // must not reject

			expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 0, aborts: 1 })
		})

		it('does not abort a stream the handler closed before throwing', async () => {
			const { node, invoke } = fakeNode()
			await registerRpcHandler(node, '/test/close-then-throw', async (stream) => {
				await stream.close()
				throw new Error('failed after replying')
			})
			const s = inboundStub([])

			await invoke('/test/close-then-throw', s.stream, 'peer-a')

			// Release stays exactly-once: the completed close stands, no abort follows it. The
			// stream is still `status: 'open'` here (half-closed, remote's write end alive), so
			// the write end is what tells the wrapper the reply was already committed.
			expect(s.status(), 'half-closed, not fully closed').to.equal('open')
			expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 1, aborts: 0 })
		})

		it('bounds a real handler\'s success-path close against a remote that stops reading, releasing via abort', async () => {
			const { node, invoke } = fakeNode()
			// `registerPing`'s handler body, verbatim, with its two optional collaborators absent:
			// reply and return, no close of its own. Registered directly rather than through
			// `registerPing` because the budget must be injected (so the case does not spend the
			// 5s production default) and `registerPing` takes no handler opts — threading a
			// `closeBudgetMs` through the `register*` helpers would change production signatures
			// to serve a test. What is under test is the *seam* against a real body's shape.
			await registerRpcHandler(node, '/test/stalled-reader', async (stream) => {
				sendFramed(stream, await encodeJson({ ok: true, ts: Date.now() }))
			}, { closeBudgetMs: 100 })
			const s = inboundStub([], { closeHangs: true })

			const t0 = Date.now()
			await invoke('/test/stalled-reader', s.stream, 'peer-a') // must settle, not hang
			const elapsed = Date.now() - t0

			// The reply was written, then the close was attempted and never completed; the budget
			// expiry rejects it into the catch arm, where `writeStatus === 'closing'` (not
			// 'closed') leaves the abort eligible — so the stream slot is reclaimed rather than
			// held forever, at the cost of the undelivered reply the remote was not reading.
			expect(s.sends, 'reply written').to.equal(1)
			expect(s.closeAttempts, 'close attempted').to.equal(1)
			expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 0, aborts: 1 })
			expect(s.status(), 'released').to.equal('aborted')
			expect(elapsed, `elapsed ${elapsed}ms must be bounded by the injected budget`).to.be.at.most(3000)
		})

		it('lets an external seam consumer close for itself without a second release', async () => {
			const { node, invoke } = fakeNode()
			await registerRpcHandler(node, '/test/handler-closed', async (stream) => { await stream.close() }, { closeBudgetMs: 100 })
			const s = inboundStub([])

			await invoke('/test/handler-closed', s.stream, 'peer-a')

			// No FRET handler is this shape any more — the seam closes for all five — but
			// `registerRpcHandler` is exported from the package root, so a consumer wrapping its
			// own protocol may still close in its body. `close()` early-returns once the write end
			// is closed, so the budgeted close is a no-op and the committed reply is never turned
			// into a second release.
			expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 1, aborts: 0 })
		})

		it('leaves a stream alone that the remote already reset', async () => {
			const { node, invoke } = fakeNode()
			await registerMaybeAct(node, async () => { throw new Error('unreached') }, P.PROTOCOL_MAYBE_ACT)
			const s = inboundStub([], { resetOnRead: true })

			await invoke(P.PROTOCOL_MAYBE_ACT, s.stream, 'peer-a')

			// The read's throw came from the reset itself; the stream has already left `open`, so
			// releasing it again would be a second release of a dead stream.
			expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 0, aborts: 0 })
			expect(s.status()).to.equal('reset')
		})

		it('aborts once when the maybeAct body is not JSON', async () => {
			const { node, invoke } = fakeNode()
			await registerMaybeAct(node, async () => { throw new Error('handle must not run') }, P.PROTOCOL_MAYBE_ACT)
			const s = inboundStub([framed('{ not: json }')])

			await invoke(P.PROTOCOL_MAYBE_ACT, s.stream, 'peer-a')

			expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 0, aborts: 1 })
			expect(s.sends, 'no reply attempted').to.equal(0)
		})

		it('aborts once when the maybeAct body decodes to a non-object', async () => {
			const { node, invoke } = fakeNode()
			await registerMaybeAct(node, async () => { throw new Error('handle must not run') }, P.PROTOCOL_MAYBE_ACT)
			const s = inboundStub([framed('null')])

			await invoke(P.PROTOCOL_MAYBE_ACT, s.stream, 'peer-a')

			expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 0, aborts: 1 })
		})

		it('aborts once when the service callback itself throws', async () => {
			const { node, invoke } = fakeNode()
			await registerMaybeAct(node, async () => { throw new Error('service exploded') }, P.PROTOCOL_MAYBE_ACT)
			const s = inboundStub([json(baseMsg())])

			await invoke(P.PROTOCOL_MAYBE_ACT, s.stream, 'peer-a')

			expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 0, aborts: 1 })
		})

		it('closes — never aborts — the leave identity-mismatch drop', async () => {
			const { node, invoke } = fakeNode()
			let leaveCalls = 0
			let mismatches = 0
			await registerLeave(node, () => { leaveCalls++ }, P.PROTOCOL_LEAVE, () => { mismatches++ })
			const s = inboundStub([json({ v: 1, from: PEER_CLAIMED, timestamp: Date.now() })])

			await invoke(P.PROTOCOL_LEAVE, s.stream, PEER_ACTUAL)

			// The drop is a normal outcome, not a failure.
			expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 1, aborts: 0 })
			expect(s.sends, 'no reply for a dropped notice').to.equal(0)
			expect(leaveCalls, 'onLeave never ran').to.equal(0)
			expect(mismatches).to.equal(1)
		})

		it('answers a leave whose replacements field is a number, treating it as absent', async () => {
			const { node, invoke } = fakeNode()
			let notice: LeaveNoticeV1 | undefined
			await registerLeave(node, (n) => { notice = n }, P.PROTOCOL_LEAVE)
			const s = inboundStub([json({ v: 1, from: PEER_ACTUAL, replacements: 5, timestamp: Date.now() })])

			await invoke(P.PROTOCOL_LEAVE, s.stream, PEER_ACTUAL)

			// `sanitizeReplacements` used to reach `.slice` on the number and throw out of the
			// handler; now a non-array is simply not a replacement list.
			expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 1, aborts: 0 })
			expect(notice?.replacements).to.equal(undefined)
			const reply = await decodeFramed<{ ok: boolean }>(s.replies[0]!)
			expect(reply.ok).to.equal(true)
		})

		it('closes — never aborts — a non-JSON leave body', async () => {
			const { node, invoke } = fakeNode()
			let leaveCalls = 0
			await registerLeave(node, () => { leaveCalls++ }, P.PROTOCOL_LEAVE)
			const s = inboundStub([framed('!!! definitely not json !!!')])

			await invoke(P.PROTOCOL_LEAVE, s.stream, PEER_ACTUAL)

			// The body arrived as one well-formed *frame*, so this is a body-level failure, not a
			// frame-level one: `registerJsonHandler` drops it and lets the seam close. Framing
			// failures (truncation, over-cap) still abort — see the truncation cases above.
			expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 1, aborts: 0 })
			expect(s.sends, 'no reply for a dropped notice').to.equal(0)
			expect(leaveCalls).to.equal(0)
		})

		it('closes — never aborts — the announce identity-mismatch drop', async () => {
			const { node, invoke } = fakeNode()
			let announces = 0
			let mismatches = 0
			await registerNeighbors(
				node,
				() => ({ v: 1, from: 'self', timestamp: Date.now(), successors: [], predecessors: [], sig: '' } as NeighborSnapshotV1),
				() => { announces++ },
				{ PROTOCOL_NEIGHBORS: P.PROTOCOL_NEIGHBORS, PROTOCOL_NEIGHBORS_ANNOUNCE: P.PROTOCOL_NEIGHBORS_ANNOUNCE },
				128 * 1024,
				() => { mismatches++ }
			)
			const snap = { v: 1, from: PEER_CLAIMED, timestamp: Date.now(), successors: [], predecessors: [], sig: '' }
			const s = inboundStub([json(snap)])

			await invoke(P.PROTOCOL_NEIGHBORS_ANNOUNCE, s.stream, PEER_ACTUAL)

			expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 1, aborts: 0 })
			expect(announces, 'onAnnounce never ran').to.equal(0)
			expect(mismatches).to.equal(1)
		})

		it('still answers ping when the size-estimate provider throws', async () => {
			const { node, invoke } = fakeNode()
			await registerPing(node, P.PROTOCOL_PING, () => { throw new Error('estimator down') })
			const s = inboundStub([])

			await invoke(P.PROTOCOL_PING, s.stream, 'peer-a')

			expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 1, aborts: 0 })
			const pong = await decodeFramed<{ ok: boolean; size_estimate?: number }>(s.replies[0]!)
			expect(pong.ok).to.equal(true)
			expect(pong.size_estimate).to.equal(undefined)
		})

		it('contains a ping reply tail that throws — the previously unguarded path', async () => {
			const { node, invoke } = fakeNode()
			await registerPing(node, P.PROTOCOL_PING)
			const s = inboundStub([], { sendThrows: new Error('stream went away mid-reply') })

			await invoke(P.PROTOCOL_PING, s.stream, 'peer-a') // used to reject the handler promise

			expect(s.sends, 'the reply was attempted').to.equal(1)
			expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 0, aborts: 1 })
		})
	})

	describe('decodeJson top-level shape', () => {
		const rejects = [
			{ name: 'the literal null', text: 'null' },
			{ name: 'an array', text: '[1,2,3]' },
			{ name: 'a number', text: '42' },
			{ name: 'a string', text: '"hello"' },
			{ name: 'a boolean', text: 'true' },
		]
		for (const { name, text } of rejects) {
			it(`rejects ${name}`, async () => {
				let thrown: unknown
				try { await decodeJson(enc.encode(text)) } catch (err) { thrown = err }
				expect((thrown as Error)?.message).to.include('non-object')
			})
		}

		it('still accepts a JSON object', async () => {
			expect(await decodeJson(enc.encode('{"a":1}'))).to.deep.equal({ a: 1 })
		})
	})

	describe('parseRouteAndMaybeAct', () => {
		it('accepts a well-formed message, with and without the optional fields', () => {
			expect(parseRouteAndMaybeAct(baseMsg())).to.not.equal(undefined)
			expect(parseRouteAndMaybeAct(baseMsg({
				wants: 2,
				breadcrumbs: ['peer-a', 'peer-b'],
				activity: 'YWN0',
				digest: 'ZGln',
			}))).to.not.equal(undefined)
		})

		const bad: Array<{ name: string; msg: () => unknown }> = [
			{ name: 'the literal null', msg: () => null },
			{ name: 'an array', msg: () => [1, 2, 3] },
			{ name: 'a string', msg: () => 'hello' },
			{ name: 'an undecodable key', msg: () => baseMsg({ key: '!!!bad!!!' }) },
			{ name: 'an absent key', msg: () => withoutKey() },
			{ name: 'a non-string key', msg: () => baseMsg({ key: 7 }) },
			{ name: 'an oversized key', msg: () => baseMsg({ key: 'A'.repeat(2000) }) },
			{ name: 'a numeric breadcrumbs field', msg: () => baseMsg({ breadcrumbs: 5 }) },
			{ name: 'non-string breadcrumb entries', msg: () => baseMsg({ breadcrumbs: [1, 2] }) },
			{ name: 'an oversized breadcrumb trail', msg: () => baseMsg({ breadcrumbs: Array.from({ length: 100 }, (_, i) => `p${i}`) }) },
			{ name: 'a string want_k', msg: () => baseMsg({ want_k: 'abc' }) },
			{ name: 'a string ttl', msg: () => baseMsg({ ttl: '5' }) },
			{ name: 'a string wants', msg: () => baseMsg({ wants: '3' }) },
			{ name: 'a non-finite timestamp', msg: () => baseMsg({ timestamp: 'now' }) },
			{ name: 'a string min_sigs', msg: () => baseMsg({ min_sigs: 'one' }) },
			{ name: 'a missing correlation_id', msg: () => { const m = baseMsg(); delete m.correlation_id; return m } },
			{ name: 'an oversized correlation_id', msg: () => baseMsg({ correlation_id: 'x'.repeat(300) }) },
			{ name: 'a numeric activity', msg: () => baseMsg({ activity: 5 }) },
			{ name: 'a numeric digest', msg: () => baseMsg({ digest: 5 }) },
			{ name: 'an oversized digest', msg: () => baseMsg({ digest: 'd'.repeat(5000) }) },
		]
		for (const { name, msg } of bad) {
			it(`rejects ${name}`, () => {
				expect(parseRouteAndMaybeAct(msg())).to.equal(undefined)
			})
		}

		// `want_k: "abc"` used to slip through: `inClusterWindow` returned NaN and
		// `neighborDistance(...) < NaN` was always false, so the node silently believed it was
		// never in-cluster for that message instead of rejecting it.
		it('rejects the NaN-window shape rather than disabling the membership test', () => {
			expect(parseRouteAndMaybeAct(baseMsg({ want_k: 'abc', wants: 'def' }))).to.equal(undefined)
		})
	})

	// -----------------------------------------------------------------------------------------
	// Service tier: the validator's position and consequences inside `handleMaybeAct`, driven
	// directly on unstarted services (no stabilization loops, fully deterministic — the same
	// arrangement as `in-cluster-width.spec.ts`).
	// -----------------------------------------------------------------------------------------
	describe('handleMaybeAct validator consequences', () => {
		type Reply = NearAnchorV1 | { busy: true; retry_after_ms: number } | { commitCertificate: string }
		interface DrivableService {
			handleMaybeAct(msg: unknown): Promise<Reply>
			dedupCache: { get(key: string): unknown }
		}

		let node: Libp2p
		let svc: CoreFretService

		beforeEach(async () => {
			node = await createMemNode()
			await node.start()
			svc = new CoreFretService(node, { profile: 'core', networkName: NETWORK })
		})

		afterEach(async () => {
			await stopAll([node])
		})

		const drive = (s: CoreFretService, msg: unknown): Promise<Reply> =>
			(s as unknown as DrivableService).handleMaybeAct(msg)

		const staticRejectShape = (res: Reply): void => {
			const anchor = res as NearAnchorV1
			expect(anchor.anchors, 'no anchors computed').to.deep.equal([])
			expect(anchor.cohort_hint, 'no cohort walked').to.deep.equal([])
			expect(anchor.estimated_cluster_size, 'no estimate computed').to.equal(0)
			expect(anchor.confidence).to.equal(0)
		}

		it('rejects a malformed message statically and counts it', async () => {
			const before = svc.getDiagnostics().rejected.malformed

			const res = await drive(svc, baseMsg({ breadcrumbs: 5 }))

			staticRejectShape(res)
			expect(svc.getDiagnostics().rejected.malformed).to.equal(before + 1)
		})

		it('stays static even when the store is full of members', async () => {
			const store = svc.getStore()
			for (let i = 0; i < 6; i++) {
				const id = `member-${i}`
				store.upsert(id, await hashKey(enc.encode(`coord-${i}`)))
				store.setMembership(id, 'member')
			}

			const res = await drive(svc, baseMsg({ key: '!!!bad!!!' }))

			// Exactly like the TTL and timestamp rejections: no ring walk, no hints, even though
			// the store could supply plenty.
			staticRejectShape(res)
		})

		it('never caches the rejection, so a later well-formed message with the same correlation_id gets a real answer', async () => {
			const correlationId = 'shared-corr-id'

			await drive(svc, baseMsg({ correlation_id: correlationId, want_k: 'abc' }))

			const cache = (svc as unknown as DrivableService).dedupCache
			expect(cache.get(`${correlationId}|digest`), 'guard rejection not cached').to.equal(undefined)

			const res = await drive(svc, baseMsg({ correlation_id: correlationId })) as NearAnchorV1
			// The genuine answer reports a real (k-floored) estimate; the static reject reports 0.
			expect(res.estimated_cluster_size, 'answered fresh, not from the reject').to.be.greaterThan(0)
		})

		it('spends a token per malformed message — the validator is not an unmetered pre-filter', async () => {
			// Edge profile: maybeAct bucket burst 8, refill 4/s — so a short malformed flood must
			// visibly drain it.
			const edge = new CoreFretService(node, { profile: 'edge', networkName: `${NETWORK}-edge` })
			const before = { ...edge.getDiagnostics().rejected }

			const replies: Reply[] = []
			for (let i = 0; i < 12; i++) replies.push(await drive(edge, baseMsg({ ttl: 'not-a-number' })))

			const after = edge.getDiagnostics().rejected
			const malformed = after.malformed - before.malformed
			const rateLimited = after.rateLimited - before.rateLimited
			expect(malformed + rateLimited, 'every message hit exactly one of the two').to.equal(12)
			expect(malformed, 'the burst got through the bucket and was rejected as malformed').to.be.at.least(8)
			expect(rateLimited, 'the bucket then emptied — malformed messages are metered').to.be.at.least(1)
			expect(replies.some((r) => 'busy' in r && r.busy === true), 'busy replies observed').to.equal(true)
		})
	})

	// -----------------------------------------------------------------------------------------
	// Wire tier: the measured malformed matrix over a real transport. Each row used to leave one
	// more inbound stream permanently open on the receiving connection.
	// -----------------------------------------------------------------------------------------

	/** Open inbound streams for `protocol` on the receiver's side of its connection to `sender`. */
	function openStreams(receiver: Libp2p, sender: Libp2p, protocol: string): number {
		return receiver.getConnections(sender.peerId)
			.flatMap((c) => c.streams)
			.filter((s) => s.protocol === protocol && s.status === 'open')
			.length
	}

	/**
	 * Write `payload` as one frame, half-close, read one framed reply. Discriminates the three
	 * receiver outcomes: `reply` (a frame arrived), `eof` (clean close with no frame — the
	 * identity-mismatch drop; the stream is already fully closed, so no release is needed),
	 * `abort` (the wrapper's error arm reset the stream, so the read fails with something other
	 * than a truncation shape).
	 */
	type RawResult = { kind: 'reply'; bytes: Uint8Array } | { kind: 'eof' } | { kind: 'abort' }

	async function sendRaw(sender: Libp2p, target: PeerId, protocol: string, payload: string | Uint8Array): Promise<RawResult> {
		const bytes = typeof payload === 'string' ? enc.encode(payload) : payload
		const stream = await sender.dialProtocol(target, [protocol])
		stream.send(lp.encode.single(bytes))
		// Start the read *before* the half-close, then await both. Order matters in both
		// directions: `readFramed` subscribes to the stream's one-shot close events when its
		// iteration starts, so closing first can lose a reply from a handler that reads no
		// request body (ping, the neighbors request) and therefore answers a few ticks later;
		// while not closing at all strands the receiver, whose own budgeted close waits on our
		// write end. FRET framing carries the body length in-band, so the close is never what
		// delimits a message.
		const reading = readFramed(stream, 1024 * 1024, 3000)
		const closing = stream.close().catch(() => { /* the read outcome is what this reports */ })
		try {
			const reply = await reading
			await closing
			return { kind: 'reply', bytes: reply }
		} catch (err) {
			await closing
			if (isFrameTruncationError(err)) return { kind: 'eof' }
			try { stream.abort(new Error('sendRaw: receiver aborted')) } catch { /* already gone */ }
			return { kind: 'abort' }
		}
	}

	/** Assert `res` carried a reply frame and narrow to its bytes. */
	function replyBytes(res: RawResult, label: string): Uint8Array {
		if (res.kind !== 'reply') throw new Error(`${label}: expected a reply frame, got ${res.kind}`)
		return res.bytes
	}

	type RowExpect = 'reject' | 'abort' | 'drop' | 'ok'

	interface MatrixRow {
		name: string
		protocol: string
		payload: (senderId: string) => string
		/**
		 * reject — answered with the static reject (validator);
		 * abort — stream aborted (decode/handler threw): the sender's read fails non-truncation;
		 * drop — silently closed with no reply frame (identity mismatch): the sender sees EOF;
		 * ok — answered normally.
		 */
		expect: RowExpect
	}

	/** The measured defect matrix from the ticket, plus the decoder's non-object shapes. */
	function malformedMatrix(): MatrixRow[] {
		return [
			{ name: 'maybeAct: invalid JSON', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => '{ not: json }', expect: 'abort' },
			{ name: 'maybeAct: truncated JSON', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => '{"v":1,"key":"', expect: 'abort' },
			{ name: 'maybeAct: null top level', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => 'null', expect: 'abort' },
			{ name: 'maybeAct: array top level', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => '[1,2,3]', expect: 'abort' },
			{ name: 'maybeAct: bad base64url key', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => JSON.stringify(baseMsg({ key: '!!!bad!!!' })), expect: 'reject' },
			{ name: 'maybeAct: absent key', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => JSON.stringify(withoutKey()), expect: 'reject' },
			{ name: 'maybeAct: numeric breadcrumbs', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => JSON.stringify(baseMsg({ breadcrumbs: 5 })), expect: 'reject' },
			{ name: 'maybeAct: string want_k', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => JSON.stringify(baseMsg({ want_k: 'abc' })), expect: 'reject' },
			{ name: 'maybeAct: numeric activity', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => JSON.stringify(baseMsg({ activity: 5 })), expect: 'reject' },
			// A well-formed frame whose *body* will not decode is a body-level failure under
			// `registerJsonHandler`, so it drops (close, no reply) rather than aborting. Framing
			// failures still abort — see the maybeAct rows above, which are not on that seam.
			{ name: 'leave: non-JSON', protocol: P.PROTOCOL_LEAVE, payload: () => 'total garbage', expect: 'drop' },
			{ name: 'leave: numeric replacements', protocol: P.PROTOCOL_LEAVE, payload: (senderId) => JSON.stringify({ v: 1, from: senderId, replacements: 5, timestamp: Date.now() }), expect: 'ok' },
			// A *parseable* peer id that is not the sender: the wire-shape parser refuses an
			// unparseable `from` before the handler's identity check ever runs, so a placeholder
			// here would count as `malformed` and never reach the mismatch path it is testing.
			{ name: 'leave: from mismatch', protocol: P.PROTOCOL_LEAVE, payload: () => JSON.stringify({ v: 1, from: PEER_CLAIMED, timestamp: Date.now() }), expect: 'drop' },
			{ name: 'leave: from absent', protocol: P.PROTOCOL_LEAVE, payload: () => JSON.stringify({ v: 1, timestamp: Date.now() }), expect: 'drop' },
			// Same body-level rule as the leave rows: a decodable frame carrying an undecodable
			// body drops rather than aborting.
			{ name: 'announce: null top level', protocol: P.PROTOCOL_NEIGHBORS_ANNOUNCE, payload: () => 'null', expect: 'drop' },
			{ name: 'announce: from mismatch', protocol: P.PROTOCOL_NEIGHBORS_ANNOUNCE, payload: () => JSON.stringify({ v: 1, from: PEER_CLAIMED, timestamp: Date.now(), successors: [], predecessors: [], sig: '' }), expect: 'drop' },
			{ name: 'neighbors: garbage body ignored', protocol: P.PROTOCOL_NEIGHBORS, payload: () => 'garbage the request handler never reads', expect: 'ok' },
			{ name: 'ping: garbage body ignored', protocol: P.PROTOCOL_PING, payload: () => 'garbage the ping handler never reads', expect: 'ok' },
		]
	}

	interface WireRig {
		receiver: Libp2p
		sender: Libp2p
		svc: CoreFretService
	}

	async function wireRig(makeNode: () => Promise<Libp2p>): Promise<WireRig> {
		const receiver = await makeNode()
		const sender = await makeNode()
		await receiver.start()
		await sender.start()
		// Deliberately not started: the inbound handlers are registered directly, so no
		// stabilization loop dials anything and every count below is deterministic.
		const svc = new CoreFretService(receiver, { profile: 'core', networkName: NETWORK })
		await (svc as unknown as { registerRpcHandlers(): Promise<void> }).registerRpcHandlers()
		await sender.dial(receiver.getMultiaddrs()[0]!)
		return { receiver, sender, svc }
	}

	async function runMatrix(rig: WireRig): Promise<void> {
		const { receiver, sender, svc } = rig
		const senderId = sender.peerId.toString()
		const rows = malformedMatrix()
		const before = { ...svc.getDiagnostics().rejected }

		for (const row of rows) {
			const res = await sendRaw(sender, receiver.peerId, row.protocol, row.payload(senderId))

			switch (row.expect) {
				case 'reject': {
					const parsed = JSON.parse(dec.decode(replyBytes(res, row.name))) as NearAnchorV1
					expect(parsed.anchors, `${row.name}: static reject`).to.deep.equal([])
					expect(parsed.estimated_cluster_size, `${row.name}: static reject`).to.equal(0)
					break
				}
				case 'abort': {
					expect(res.kind, `${row.name}: no reply — aborted`).to.equal('abort')
					break
				}
				case 'drop': {
					// A clean close with no reply frame: `readFramed` throws its truncation shape,
					// which `sendRaw` maps to `eof` — distinct from the receiver aborting.
					expect(res.kind, `${row.name}: dropped without a reply`).to.equal('eof')
					break
				}
				case 'ok': {
					expect(replyBytes(res, row.name).byteLength, `${row.name}: answered`).to.be.greaterThan(0)
					break
				}
			}

			// The heart of the ticket: whatever the row did, the receiver's inbound stream for
			// that protocol must be released — before the fix every abort-shaped row here left
			// one more stream open forever.
			await waitUntil(
				() => openStreams(receiver, sender, row.protocol) === 0,
				2000,
				`${row.name}: inbound stream released`
			)
		}

		const after = svc.getDiagnostics().rejected
		const rejectRows = rows.filter((r) => r.expect === 'reject').length
		const dropRows = rows.filter((r) => r.expect === 'drop').length
		// Body-level drops split two ways now that leave/announce run on `registerJsonHandler`:
		// a body the parser refuses counts `malformed` (alongside the maybeAct validator rows),
		// while a well-formed body whose `from` is not the transport-authenticated sender still
		// counts `identityMismatch`. Naming the identity rows keeps both sides honest.
		const identityRows = rows.filter((r) => r.name.endsWith('from mismatch')).length
		const parserDropRows = dropRows - identityRows
		expect(after.malformed - before.malformed, 'every validator and parser rejection counted').to.equal(rejectRows + parserDropRows)
		expect(after.identityMismatch - before.identityMismatch, 'every identity drop counted').to.equal(identityRows)
	}

	describe('over the memory transport', () => {
		let rig: WireRig

		beforeEach(async () => { rig = await wireRig(createMemNode) })
		afterEach(async () => { await stopAll([rig.sender, rig.receiver]) })

		it('releases the inbound stream for every malformed shape in the matrix', async () => {
			await runMatrix(rig)
		})

		it('survives a concurrent malformed burst and still answers afterwards', async () => {
			// 16 concurrent, comfortably under the 32-stream inbound cap so transient concurrency
			// cannot trip it even while all 16 are open at once.
			await Promise.all(Array.from({ length: 16 }, () =>
				sendRaw(rig.sender, rig.receiver.peerId, P.PROTOCOL_MAYBE_ACT, '{ not: json }')
			))

			await waitUntil(
				() => openStreams(rig.receiver, rig.sender, P.PROTOCOL_MAYBE_ACT) === 0,
				2000,
				'all concurrent streams released'
			)

			const res = await sendRaw(rig.sender, rig.receiver.peerId, P.PROTOCOL_MAYBE_ACT, JSON.stringify(baseMsg()))
			const parsed = JSON.parse(dec.decode(replyBytes(res, 'well-formed message still answered'))) as NearAnchorV1
			expect(parsed.estimated_cluster_size, 'a real answer, not the static reject').to.be.greaterThan(0)
		})

		it('recovers after 40 malformed messages on one connection — every protocol still answers', async () => {
			const { receiver, sender } = rig
			const senderId = sender.peerId.toString()

			// Well past the 32-per-protocol-per-connection cap, all on maybeAct, alternating the
			// abort shape (handler throws) and the validator shape (static reject). Without the
			// release seam the 33rd inbound maybeAct stream on this connection is refused.
			for (let i = 0; i < 40; i++) {
				const payload = i % 2 === 0 ? '{ not: json }' : JSON.stringify(baseMsg({ key: '!!!bad!!!' }))
				await sendRaw(sender, receiver.peerId, P.PROTOCOL_MAYBE_ACT, payload)
			}

			await waitUntil(
				() => openStreams(receiver, sender, P.PROTOCOL_MAYBE_ACT) === 0,
				2000,
				'the batch left nothing open'
			)
			expect(receiver.getConnections(sender.peerId).length, 'still the one connection').to.equal(1)

			// The 20 validator rows each spent a maybeAct token (core burst 32, refill 16/s);
			// give the bucket a moment so the final well-formed message is answered, not busied.
			await sleep(1000)

			const act = replyBytes(await sendRaw(sender, receiver.peerId, P.PROTOCOL_MAYBE_ACT, JSON.stringify(baseMsg())), 'maybeAct answers')
			expect((JSON.parse(dec.decode(act)) as NearAnchorV1).estimated_cluster_size).to.be.greaterThan(0)

			const neighbors = replyBytes(await sendRaw(sender, receiver.peerId, P.PROTOCOL_NEIGHBORS, 'x'), 'neighbors answers')
			expect((JSON.parse(dec.decode(neighbors)) as NeighborSnapshotV1).from).to.equal(receiver.peerId.toString())

			const ping = replyBytes(await sendRaw(sender, receiver.peerId, P.PROTOCOL_PING, 'x'), 'ping answers')
			expect((JSON.parse(dec.decode(ping)) as { ok: boolean }).ok).to.equal(true)

			const leave = replyBytes(await sendRaw(sender, receiver.peerId, P.PROTOCOL_LEAVE, JSON.stringify({ v: 1, from: senderId, timestamp: Date.now() })), 'leave answers')
			expect((JSON.parse(dec.decode(leave)) as { ok: boolean }).ok).to.equal(true)

			const announce = replyBytes(await sendRaw(sender, receiver.peerId, P.PROTOCOL_NEIGHBORS_ANNOUNCE, JSON.stringify({
				v: 1, from: senderId, timestamp: Date.now(), successors: [], predecessors: [], sig: '',
			})), 'announce answers')
			expect((JSON.parse(dec.decode(announce)) as { ok: boolean }).ok).to.equal(true)
		})

		it('leaks nothing when the sender aborts a ping stream instead of closing it', async () => {
			// The shape ping's unguarded reply tail used to die on: the handler's `send` lands on
			// a stream the remote already reset. Whichever way the race falls, nothing may leak
			// and no rejection may escape (the describe-level guard checks that half).
			const stream = await rig.sender.dialProtocol(rig.receiver.peerId, [P.PROTOCOL_PING])
			stream.abort(new Error('sender bailed'))

			await waitUntil(
				() => openStreams(rig.receiver, rig.sender, P.PROTOCOL_PING) === 0,
				2000,
				'nothing left open'
			)
		})
	})

	// A muxer difference must not hide the leak: re-drive the headline case over the stack the
	// production nodes actually run (TCP + noise + yamux), as `rpc.stream-errors.spec.ts` does.
	describe('over TCP + noise + yamux', () => {
		let rig: WireRig

		beforeEach(async () => { rig = await wireRig(createIdentifyNode) })
		afterEach(async () => { await stopAll([rig.sender, rig.receiver]) })

		it('recovers after 40 malformed maybeAct messages on one connection', async () => {
			const { receiver, sender } = rig

			for (let i = 0; i < 40; i++) {
				const payload = i % 2 === 0 ? '{ not: json }' : JSON.stringify(baseMsg({ breadcrumbs: 5 }))
				await sendRaw(sender, receiver.peerId, P.PROTOCOL_MAYBE_ACT, payload)
			}

			await waitUntil(
				() => openStreams(receiver, sender, P.PROTOCOL_MAYBE_ACT) === 0,
				2000,
				'the batch left nothing open'
			)

			await sleep(1000) // bucket refill, as in the memory-transport case

			const reply = replyBytes(await sendRaw(sender, receiver.peerId, P.PROTOCOL_MAYBE_ACT, JSON.stringify(baseMsg())), 'well-formed message still answered')
			expect((JSON.parse(dec.decode(reply)) as NearAnchorV1).estimated_cluster_size).to.be.greaterThan(0)
		})
	})
})
