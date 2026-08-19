import { after, before, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { Connection, PeerId, Stream } from '@libp2p/interface'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { openRpcStream, isLimitedConnection, releaseRpcStream, readFramed } from '../src/rpc/protocols.js'
import { abortReasonError, DeadlineExpiredError } from '../src/utils/deadline.js'
import { registerPing, sendPing } from '../src/rpc/ping.js'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { announceNeighbors, fetchNeighbors } from '../src/rpc/neighbors.js'
import { sendMaybeAct } from '../src/rpc/maybe-act.js'
import { sendLeave } from '../src/rpc/leave.js'
import type { NeighborSnapshotV1, RouteAndMaybeActV1 } from '../src/index.js'
import * as lp from 'it-length-prefixed'

// Minimal recording stubs. openRpcStream only touches `node.getConnections`,
// `node.dialProtocol`, and per-connection `{ status, limits, remoteAddr,
// newStream }`, so no real transport / relay is needed.

interface StreamOpts {
	runOnLimitedConnection?: unknown
	negotiateFully?: unknown
	signal?: AbortSignal
}

interface StubConnection {
	status: string
	limits?: unknown
	remoteAddr?: { toString(): string }
	newStream?: (protocols: string[], opts: StreamOpts) => Promise<Stream>
	// recording spy: every newStream call is appended here
	calls: Array<{ protocols: string[]; opts: StreamOpts }>
}

function makeConnection(opts: {
	status?: string
	limited?: boolean
	remoteAddr?: string | null
	hasNewStream?: boolean
}): StubConnection {
	const calls: StubConnection['calls'] = []
	const conn: StubConnection = {
		status: opts.status ?? 'open',
		limits: opts.limited ? { bytes: 1024 } : undefined,
		remoteAddr: opts.remoteAddr === null
			? undefined
			: { toString: () => opts.remoteAddr ?? '/ip4/1.2.3.4/tcp/4001' },
		calls,
	}
	if (opts.hasNewStream !== false) {
		conn.newStream = async (protocols, streamOpts) => {
			calls.push({ protocols, opts: streamOpts })
			return { id: 'stub-stream' } as unknown as Stream
		}
	}
	return conn
}

function makeNode(connections: StubConnection[]): {
	node: Libp2p
	dialCalls: Array<{ protocols: string[]; opts: StreamOpts }>
} {
	const dialCalls: Array<{ protocols: string[]; opts: StreamOpts }> = []
	const node = {
		getConnections: (_pid?: PeerId) => connections as unknown as Connection[],
		dialProtocol: async (_pid: PeerId, protocols: string[], opts: StreamOpts) => {
			dialCalls.push({ protocols, opts })
			return { id: 'dialed-stream' } as unknown as Stream
		},
	}
	return { node: node as unknown as Libp2p, dialCalls }
}

const PID = { toString: () => 'stub-peer' } as unknown as PeerId
const PROTOCOLS = ['/optimystic/test/fret/1.0.0/ping']

// asserts on the runOnLimitedConnection key specifically rather than deep-equal
// on the whole opts object, so an unrelated future stream option won't break this
function expectRunsOnLimited(opts: StreamOpts, ctx: string): void {
	expect(opts.runOnLimitedConnection, `${ctx}: runOnLimitedConnection`).to.be.ok
}

describe('openRpcStream', () => {
	it('opens on a limited-only connection with runOnLimitedConnection (headline regression guard)', async () => {
		const limited = makeConnection({ limited: true })
		const { node, dialCalls } = makeNode([limited])

		const stream = await openRpcStream(node, PID, PROTOCOLS)

		expect(stream, 'stream').to.exist
		expect(limited.calls.length, 'limited newStream calls').to.equal(1)
		expect(limited.calls[0].protocols).to.deep.equal(PROTOCOLS)
		expectRunsOnLimited(limited.calls[0].opts, 'limited-only')
		// the limited connection must be REUSED, not re-dialed
		expect(dialCalls.length, 'dialProtocol calls').to.equal(0)
	})

	it('prefers the direct connection when both direct and limited are open', async () => {
		const direct = makeConnection({ limited: false })
		const limited = makeConnection({ limited: true })
		const { node } = makeNode([limited, direct]) // limited listed first on purpose

		await openRpcStream(node, PID, PROTOCOLS)

		expect(direct.calls.length, 'direct newStream calls').to.equal(1)
		expect(limited.calls.length, 'limited newStream calls').to.equal(0)
		expectRunsOnLimited(direct.calls[0].opts, 'direct-preferred')
	})

	it('ignores closed connections, opening on the open-limited one', async () => {
		const closedDirect = makeConnection({ status: 'closed', limited: false })
		const openLimited = makeConnection({ limited: true })
		const { node } = makeNode([closedDirect, openLimited])

		await openRpcStream(node, PID, PROTOCOLS)

		expect(closedDirect.calls.length, 'closed-direct newStream calls').to.equal(0)
		expect(openLimited.calls.length, 'open-limited newStream calls').to.equal(1)
	})

	it('ignores a connection with no newStream, opening on the open-limited one', async () => {
		const noStreamDirect = makeConnection({ limited: false, hasNewStream: false })
		const openLimited = makeConnection({ limited: true })
		const { node } = makeNode([noStreamDirect, openLimited])

		await openRpcStream(node, PID, PROTOCOLS)

		expect(openLimited.calls.length, 'open-limited newStream calls').to.equal(1)
	})

	it('returns undefined without dialing when requireExisting and no connection', async () => {
		const { node, dialCalls } = makeNode([])

		const stream = await openRpcStream(node, PID, PROTOCOLS, { requireExisting: true })

		expect(stream, 'stream').to.equal(undefined)
		expect(dialCalls.length, 'dialProtocol calls').to.equal(0)
	})

	it('falls through to dialProtocol (with runOnLimitedConnection) when no connection and not requireExisting', async () => {
		const { node, dialCalls } = makeNode([])

		await openRpcStream(node, PID, PROTOCOLS)

		expect(dialCalls.length, 'dialProtocol calls').to.equal(1)
		expect(dialCalls[0].protocols).to.deep.equal(PROTOCOLS)
		expectRunsOnLimited(dialCalls[0].opts, 'dial fallback')
	})

	// The open itself is what used to have no budget: both `newStream` and `dialProtocol` take
	// `NewStreamOptions extends AbortOptions`, and the signal only bounds the open if it is
	// actually handed to them. Identity (`.to.equal`) rather than mere presence, so a future
	// refactor that substitutes some other signal fails here.
	it('forwards the caller signal into newStream (connection path)', async () => {
		const direct = makeConnection({ limited: false })
		const { node } = makeNode([direct])
		const ac = new AbortController()

		await openRpcStream(node, PID, PROTOCOLS, { signal: ac.signal })

		expect(direct.calls.length, 'newStream calls').to.equal(1)
		expect(direct.calls[0].opts.signal, 'newStream signal').to.equal(ac.signal)
	})

	it('forwards the caller signal into dialProtocol (dial-fallback path)', async () => {
		const { node, dialCalls } = makeNode([])
		const ac = new AbortController()

		await openRpcStream(node, PID, PROTOCOLS, { signal: ac.signal })

		expect(dialCalls.length, 'dialProtocol calls').to.equal(1)
		expect(dialCalls[0].opts.signal, 'dialProtocol signal').to.equal(ac.signal)
	})

	it('throws on an already-aborted signal without dialing', async () => {
		const { node, dialCalls } = makeNode([])
		const ac = new AbortController()
		ac.abort(new Error('caller gave up'))

		let thrown: unknown
		try {
			await openRpcStream(node, PID, PROTOCOLS, { signal: ac.signal })
		} catch (err) {
			thrown = err
		}

		expect(thrown, 'thrown').to.be.instanceOf(Error)
		expect((thrown as Error).message, 'abort reason surfaces').to.equal('caller gave up')
		// The point of the pre-dial check: a `stop()` racing a maintenance tick must not still
		// put dials on the wire.
		expect(dialCalls.length, 'dialProtocol calls').to.equal(0)
	})

	it('throws on an already-aborted signal without opening a stream on an existing connection', async () => {
		const direct = makeConnection({ limited: false })
		const { node } = makeNode([direct])
		const ac = new AbortController()
		ac.abort(new Error('caller gave up'))

		let thrown: unknown
		try {
			await openRpcStream(node, PID, PROTOCOLS, { signal: ac.signal })
		} catch (err) {
			thrown = err
		}

		expect(thrown, 'thrown').to.be.instanceOf(Error)
		expect(direct.calls.length, 'newStream calls').to.equal(0)
	})
})

describe('releaseRpcStream', () => {
	function makeReleasable(): { stream: Stream; calls: string[] } {
		const calls: string[] = []
		const stream = {
			abort: (_err: Error) => { calls.push('abort') },
			close: async () => { calls.push('close') },
		}
		return { stream: stream as unknown as Stream, calls }
	}

	it('closes the stream on the un-aborted path', async () => {
		const { stream, calls } = makeReleasable()

		await releaseRpcStream(stream, new AbortController().signal)

		expect(calls, 'release calls').to.deep.equal(['close'])
	})

	it('aborts (never closes) the stream when the signal aborted', async () => {
		const { stream, calls } = makeReleasable()
		const ac = new AbortController()
		ac.abort(new Error('caller gave up'))

		await releaseRpcStream(stream, ac.signal)

		// `close()` on a stream whose remote has stalled is itself unbounded, so cleaning up a
		// timed-out read with it would hang *after* the read's own deadline already fired.
		expect(calls, 'release calls').to.deep.equal(['abort'])
	})

	// A `close()` that never resolves on its own — libp2p's contract is that it settles once the
	// pending data reached the transport, so a peer that accepts the stream and stops reading
	// produces exactly this. Honours `AbortOptions`, which is what the bound relies on.
	function makeStallingClose(): { stream: Stream; calls: string[] } {
		const calls: string[] = []
		const stream = {
			abort: (_err: Error) => { calls.push('abort') },
			close: async (o?: { signal?: AbortSignal }) => {
				calls.push('close')
				return await new Promise<void>((_res, rej) => {
					const s = o?.signal
					if (s == null) return // never settles — the pre-bound behavior this test rules out
					s.addEventListener('abort', () => { rej(abortReasonError(s)) }, { once: true })
				})
			},
		}
		return { stream: stream as unknown as Stream, calls }
	}

	it('bounds a close that never resolves, and still releases the stream', async () => {
		const { stream, calls } = makeStallingClose()
		const ac = new AbortController()
		const timer = setTimeout(() => { ac.abort(new Error('budget expired')) }, 100)

		const t0 = Date.now()
		try {
			// Callers release from a `finally` BEFORE `d.cancel()`, so the deadline is still live
			// here — that ordering is the whole reason passing its signal bounds anything.
			await releaseRpcStream(stream, ac.signal)
		} finally {
			clearTimeout(timer)
		}
		const elapsed = Date.now() - t0

		// The close was attempted (not skipped), then the failed close fell through to abort —
		// without which bounding the wait would free the caller and leak the stream slot.
		expect(calls, 'release calls').to.deep.equal(['close', 'abort'])
		expect(elapsed, `elapsed ${elapsed}ms must be bounded by the signal`).to.be.at.most(2000)
	})

	it('aborts when a close rejects for a reason other than the signal', async () => {
		const calls: string[] = []
		const stream = {
			abort: (_err: Error) => { calls.push('abort') },
			close: async () => { calls.push('close'); throw new Error('transport gone') },
		} as unknown as Stream

		await releaseRpcStream(stream, new AbortController().signal)

		expect(calls, 'release calls').to.deep.equal(['close', 'abort'])
	})

	it('swallows a stream carrying neither close nor abort', async () => {
		const bare = { id: 'stub-stream' } as unknown as Stream
		const ac = new AbortController()
		ac.abort(new Error('caller gave up'))

		// Relied on by the timeout tests below, whose stub streams are bare objects: release runs
		// from a `finally` on an already-failing path, where a second throw would mask the real error.
		await releaseRpcStream(bare, ac.signal)
		await releaseRpcStream(undefined, ac.signal)
	})
})

/**
 * A stream open that never completes on its own and settles only when the caller's signal
 * aborts — which is libp2p's `AbortOptions` contract for both `dialProtocol` and `newStream`,
 * and therefore the only thing that can end a stalled open. Given no signal it hangs forever,
 * which is precisely the pre-deadline behavior these tests exist to rule out: before the signal
 * was threaded through, every one of the assertions below would have been a mocha timeout.
 */
function hangsUntilAbort(opts: StreamOpts): Promise<Stream> {
	return new Promise<Stream>((_resolve, reject) => {
		const signal = opts.signal
		if (signal == null) return
		if (signal.aborted) { reject(abortReasonError(signal)); return }
		signal.addEventListener('abort', () => { reject(abortReasonError(signal)) }, { once: true })
	})
}

/** A node with no connections whose dial hangs — models an unresponsive / half-open transport. */
function makeHangingDialNode(): Libp2p {
	return {
		getConnections: () => [],
		dialProtocol: (_pid: PeerId, _protocols: string[], opts: StreamOpts) => hangsUntilAbort(opts),
	} as unknown as Libp2p
}

/** A node with an open connection whose `newStream` hangs — models a peer that stops muxing. */
function makeHangingStreamNode(): Libp2p {
	const conn = {
		status: 'open',
		remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/4001' },
		newStream: (_protocols: string[], opts: StreamOpts) => hangsUntilAbort(opts),
	}
	return {
		getConnections: () => [conn] as unknown as Connection[],
		dialProtocol: async () => { throw new Error('must not dial: a connection exists') },
	} as unknown as Libp2p
}

/** A node whose stream opens fine and then never yields a chunk — a peer that accepted and went quiet. */
function makeSilentStreamNode(): Libp2p {
	const stream = {
		id: 'silent-stream',
		send: () => true,
		[Symbol.asyncIterator]: () => ({
			next: () => new Promise<IteratorResult<Uint8Array>>(() => { /* never settles */ }),
		}),
	}
	return {
		getConnections: () => [],
		dialProtocol: async () => stream as unknown as Stream,
	} as unknown as Libp2p
}

/**
 * The headline behavior of the deadline work: an outbound RPC is bounded end-to-end — dial,
 * stream open and read — so a peer that never answers costs a budget rather than the caller.
 *
 * These assert **elapsed wall time**, not merely that the call settled: "it rejected" would pass
 * against a call that rejected after ten minutes, which is the bug. The bounds are deliberately
 * loose (a 100 ms budget checked against 80–1000 ms) because the property under test is "bounded
 * at all", not scheduler precision.
 *
 * NOTE: these are the wall-clock-sensitive assertions in this file (the deadline-fires test in
 * `deadline.spec.ts` carries the only other one, a lower bound on a 50ms budget). If they ever
 * flake on a loaded box, raise `MAX_MS` — but mocha's own 2s per-test default is the harder
 * ceiling, so anything past ~1.5s needs a `this.timeout()` too. Do not swap the elapsed-time
 * assertion for a bare "it rejected": that is exactly the assertion the bug would have passed.
 */
describe('RPC deadlines', () => {
	const TIMEOUT_MS = 100
	const MIN_MS = 80
	const MAX_MS = 1000
	// Real Ed25519 id: every sender runs `peerIdFromString` on its target before doing anything.
	let peer: string

	before(async () => {
		peer = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
	})

	function expectBounded(elapsed: number): void {
		expect(elapsed, `elapsed ${elapsed}ms must not be far under the ${TIMEOUT_MS}ms budget`).to.be.at.least(MIN_MS)
		expect(elapsed, `elapsed ${elapsed}ms must be bounded by roughly the ${TIMEOUT_MS}ms budget`).to.be.at.most(MAX_MS)
	}

	it('sendPing gives up on a dial that never resolves', async () => {
		const t0 = Date.now()
		let thrown: unknown
		try {
			await sendPing(makeHangingDialNode(), peer, PROTOCOLS[0], { timeoutMs: TIMEOUT_MS })
		} catch (err) {
			thrown = err
		}
		const elapsed = Date.now() - t0

		// The deadline specifically, not some incidental failure: this is what ended the dial.
		expect(thrown, 'sendPing must reject rather than hang').to.be.instanceOf(DeadlineExpiredError)
		expectBounded(elapsed)
	})

	it('sendPing gives up on a stream that opens but never yields a chunk', async () => {
		const t0 = Date.now()
		let thrown: unknown
		try {
			await sendPing(makeSilentStreamNode(), peer, PROTOCOLS[0], { timeoutMs: TIMEOUT_MS })
		} catch (err) {
			thrown = err
		}
		const elapsed = Date.now() - t0

		expect(thrown, 'sendPing must reject rather than hang').to.be.instanceOf(Error)
		expectBounded(elapsed)
	})

	// The other half of the contract: `opts.signal` is the caller's own cancellation (a `stop()`,
	// or a budget imposed from above) and the sender's deadline is a child of it, so cancelling
	// must end the RPC well before its own `timeoutMs`.
	it('sendPing rejects immediately on an already-aborted caller signal, without dialing', async () => {
		let dialed = false
		const node = {
			getConnections: () => [],
			dialProtocol: async () => { dialed = true; throw new Error('must not dial') },
		} as unknown as Libp2p
		const ac = new AbortController()
		ac.abort(new Error('service stopped'))

		const t0 = Date.now()
		let thrown: unknown
		try {
			await sendPing(node, peer, PROTOCOLS[0], { signal: ac.signal, timeoutMs: 60_000 })
		} catch (err) {
			thrown = err
		}

		expect((thrown as Error)?.message, 'caller reason surfaces').to.equal('service stopped')
		expect(dialed, 'dialProtocol called').to.equal(false)
		expect(Date.now() - t0, 'must not wait out its own budget').to.be.at.most(MAX_MS)
	})

	it('sendPing rejects promptly when the caller signal aborts mid-flight', async () => {
		const ac = new AbortController()
		const timer = setTimeout(() => { ac.abort(new Error('service stopped')) }, TIMEOUT_MS)

		const t0 = Date.now()
		let thrown: unknown
		try {
			// A budget far past the abort, so only the parent signal can end this.
			await sendPing(makeHangingDialNode(), peer, PROTOCOLS[0], { signal: ac.signal, timeoutMs: 60_000 })
		} catch (err) {
			thrown = err
		} finally {
			clearTimeout(timer)
		}

		expect((thrown as Error)?.message, 'caller reason surfaces').to.equal('service stopped')
		expectBounded(Date.now() - t0)
	})

	it('readFramed rejects when its signal aborts mid-read', async () => {
		const silent = {
			[Symbol.asyncIterator]: () => ({
				next: () => new Promise<IteratorResult<Uint8Array>>(() => { /* never settles */ }),
			}),
		}
		const ac = new AbortController()
		const timer = setTimeout(() => { ac.abort(new Error('caller gave up')) }, TIMEOUT_MS)

		const t0 = Date.now()
		let thrown: unknown
		try {
			// A read deadline far past the abort, so the abort arm — not the deadline — is what ends it.
			await readFramed(silent, 1024, 60_000, { signal: ac.signal })
		} catch (err) {
			thrown = err
		} finally {
			clearTimeout(timer)
		}

		expect((thrown as Error)?.message, 'abort reason surfaces').to.equal('caller gave up')
		expectBounded(Date.now() - t0)
	})

	it('readFramed with an Infinity budget still returns a completed frame', async () => {
		const body = new TextEncoder().encode('{"ok":true}')
		const frame = lp.encode.single(body).subarray()
		const source = (async function* () { yield frame })()

		const out = await readFramed(source, 1024, Infinity, { signal: new AbortController().signal })

		// The read loop needs no `Infinity` special-casing: `remaining` is never `<= 0` and the
		// poll interval still comes out at EOF_POLL_MS, so the ordinary path is untouched.
		expect(new TextDecoder().decode(out), 'frame body').to.equal('{"ok":true}')
	})

	it('readFramed refuses an Infinity budget with no signal, before touching the stream', async () => {
		let pulls = 0
		const counted = {
			[Symbol.asyncIterator]: () => ({
				next: () => { pulls++; return new Promise<IteratorResult<Uint8Array>>(() => { /* never settles */ }) },
			}),
		}

		let thrown: unknown
		try {
			await readFramed(counted, 1024, Infinity)
		} catch (err) {
			thrown = err
		}

		// An unbounded read with nothing to end it is a caller bug that presents as a hang, so it
		// is refused at entry — no clock, no signal, and provably no byte pulled.
		expect((thrown as Error)?.message, 'entry throw').to.contain('requires opts.signal')
		expect(pulls, 'stream never read').to.equal(0)
	})

	it('readFramed refuses a non-positive or NaN budget, before touching the stream', async () => {
		let pulls = 0
		const counted = {
			[Symbol.asyncIterator]: () => ({
				next: () => { pulls++; return new Promise<IteratorResult<Uint8Array>>(() => { /* never settles */ }) },
			}),
		}

		// `NaN` was the worst of these: `Math.min(NaN, EOF_POLL_MS)` is `NaN`, `setTimeout` clamps
		// that to zero, and the poll loop spun once per event-loop turn for as long as the stream
		// stayed open. `0` and negatives fired `remaining <= 0` at once. All three are now refused
		// at entry, and the guard is written `!(timeoutMs > 0)` so `NaN` is caught alongside them.
		for (const bad of [Number.NaN, 0, -1]) {
			let thrown: unknown
			try {
				await readFramed(counted, 1024, bad, { signal: new AbortController().signal })
			} catch (err) {
				thrown = err
			}
			expect((thrown as Error)?.message, `entry throw for ${bad}`).to.contain('must be a positive number or Infinity')
		}
		expect(pulls, 'stream never read').to.equal(0)

		// `Infinity` is the one non-finite value that still passes, since it means "bounded by the
		// signal alone" rather than "no budget at all".
		const frame = lp.encode.single(new TextEncoder().encode('{"ok":true}')).subarray()
		const out = await readFramed((async function* () { yield frame })(), 1024, Infinity, { signal: new AbortController().signal })
		expect(new TextDecoder().decode(out), 'Infinity still passes').to.equal('{"ok":true}')
	})

	it('readFramed with an Infinity budget is ended by its signal alone, never by a timer', async () => {
		const silent = {
			[Symbol.asyncIterator]: () => ({
				next: () => new Promise<IteratorResult<Uint8Array>>(() => { /* never settles */ }),
			}),
		}
		const ac = new AbortController()
		const timer = setTimeout(() => { ac.abort(new Error('caller gave up')) }, TIMEOUT_MS)

		const t0 = Date.now()
		let thrown: unknown
		try {
			await readFramed(silent, 1024, Infinity, { signal: ac.signal })
		} catch (err) {
			thrown = err
		} finally {
			clearTimeout(timer)
		}

		// The abort reason surfaces verbatim: with no second clock there is no `read timed out`
		// error to race it, so which error a caller sees is deterministic rather than a coin flip.
		expect((thrown as Error)?.message, 'abort reason surfaces').to.equal('caller gave up')
		expect((thrown as Error)?.message, 'no read-timeout path').to.not.contain('read timed out')
		expectBounded(Date.now() - t0)
	})

	it('fetchNeighbors gives up on a newStream that never resolves, returning its fabricated empty snapshot', async () => {
		const t0 = Date.now()
		// NOTE: `fetchNeighbors` swallows every failure — timeout included — into a fabricated
		// empty snapshot, so the caller cannot tell "no neighbors" from "never answered". That is
		// pre-existing (tracked as `8-rpc-shared-helper`'s "fetchNeighbors fabricates success"
		// arm), so this asserts on the fabrication plus elapsed time rather than on a rejection.
		const snap = await fetchNeighbors(makeHangingStreamNode(), peer, PROTOCOLS[0], { timeoutMs: TIMEOUT_MS })
		const elapsed = Date.now() - t0

		expect(snap.successors, 'successors').to.deep.equal([])
		expect(snap.predecessors, 'predecessors').to.deep.equal([])
		expectBounded(elapsed)
	})

	// The remaining three senders. Each was previously argued correct only from sharing the
	// `deadline()` + `openRpcStream` + `releaseRpcStream` shape with the two above — but a shape is
	// not an assertion, and the shapes are not in fact identical: these three also `close()` the
	// stream, and `close()` is the one await in the sequence that never receives the deadline
	// signal (tracked as `8-rpc-shared-helper`'s "close() escapes the deadline" arm). What is
	// common, and what these pin, is that a hanging *open* costs a budget rather than the caller.

	it('sendMaybeAct gives up on a dial that never resolves', async () => {
		const msg: RouteAndMaybeActV1 = {
			v: 1, key: 'AAAA', want_k: 4, ttl: 4, min_sigs: 3,
			correlation_id: 'test-correlation', timestamp: Date.now(), signature: '',
		}
		const t0 = Date.now()
		let thrown: unknown
		try {
			await sendMaybeAct(makeHangingDialNode(), peer, msg, PROTOCOLS[0], { timeoutMs: TIMEOUT_MS })
		} catch (err) {
			thrown = err
		}

		expect(thrown, 'sendMaybeAct must reject rather than hang').to.be.instanceOf(DeadlineExpiredError)
		expectBounded(Date.now() - t0)
	})

	it('sendLeave gives up on a dial that never resolves', async () => {
		const t0 = Date.now()
		let thrown: unknown
		try {
			await sendLeave(
				makeHangingDialNode(), peer,
				{ v: 1, from: peer, timestamp: Date.now() },
				PROTOCOLS[0], { timeoutMs: TIMEOUT_MS }
			)
		} catch (err) {
			thrown = err
		}

		// This one runs inside `stop()`, so an unbounded open would hold shutdown open per departed
		// peer — the reason the leave fan-out gets a budget at all.
		expect(thrown, 'sendLeave must reject rather than hang').to.be.instanceOf(DeadlineExpiredError)
		expectBounded(Date.now() - t0)
	})

	it('announceNeighbors gives up on a dial that never resolves, swallowing the timeout', async () => {
		const snapshot: NeighborSnapshotV1 = {
			v: 1, from: peer, timestamp: Date.now(), successors: [], predecessors: [], sig: '',
		}
		const t0 = Date.now()
		// `dial: true` because the default is connection-only, which would return immediately
		// against a node with no connections and never reach the open at all.
		await announceNeighbors(
			makeHangingDialNode(), peer, snapshot, PROTOCOLS[0],
			{ dial: true, timeoutMs: TIMEOUT_MS }
		)

		// Announce is fire-and-forget: it logs and resolves rather than throwing, so elapsed time is
		// the whole assertion here — without the deadline this call never returns.
		expectBounded(Date.now() - t0)
	})
})

describe('isLimitedConnection', () => {
	function asConn(c: StubConnection): Connection {
		return c as unknown as Connection
	}

	it('is true when limits is set (primary signal)', () => {
		expect(isLimitedConnection(asConn(makeConnection({ limited: true })))).to.equal(true)
	})

	it('is true when remoteAddr contains /p2p-circuit (multiaddr fallback)', () => {
		const c = makeConnection({ limited: false, remoteAddr: '/ip4/1.2.3.4/tcp/4001/p2p-circuit' })
		expect(isLimitedConnection(asConn(c))).to.equal(true)
	})

	it('is false for a plain non-circuit remoteAddr with no limits', () => {
		const c = makeConnection({ limited: false, remoteAddr: '/ip4/1.2.3.4/tcp/4001' })
		expect(isLimitedConnection(asConn(c))).to.equal(false)
	})

	it('is false (no throw) when remoteAddr is absent and limits is null', () => {
		const c = makeConnection({ limited: false, remoteAddr: null })
		expect(isLimitedConnection(asConn(c))).to.equal(false)
	})
})

// The headline symptom of the framing change, measured for real: `readAllBounded` polled for EOF
// every 20 ms, so every ping — however fast the responder — paid at least one poll interval.
// `readFramed` returns the moment the frame completes, so on the in-memory transport the fastest
// of a few pings lands well under 10 ms (Windows `Date.now()` granularity is ~15 ms, so a
// measured 0 ms is routine). Real nodes rather than the stubs above, hence its own teardown.
describe('ping RTT floor', () => {
	let a: Libp2p
	let b: Libp2p

	before(async () => {
		a = await createMemNode()
		b = await createMemNode()
		await a.start()
		await b.start()
		await registerPing(b, PROTOCOLS[0])
		await a.dial(b.getMultiaddrs()[0]!)
	})

	after(async () => {
		await stopAll([a, b])
	})

	it('measures a sub-10ms RTT against a fast responder on the in-memory transport', async () => {
		const rtts: number[] = []
		for (let i = 0; i < 5; i++) {
			const res = await sendPing(a, b.peerId.toString(), PROTOCOLS[0])
			expect(res.ok, `ping ${i} succeeded`).to.equal(true)
			rtts.push(res.rttMs)
		}
		expect(Math.min(...rtts), `min of ${JSON.stringify(rtts)}`).to.be.lessThan(10)
	})
})
