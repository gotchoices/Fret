import { afterEach, after, before, beforeEach, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { PeerId } from '@libp2p/interface'
import { createIdentifyNode, createMemNode, stopAll } from './helpers/libp2p.js'
import { NETWORK, P, PEER_CLAIMED, baseMsg, json, sleep, withoutKey } from './helpers/rpc-fuzz.js'
import { waitFor } from './helpers/wait-for.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { isFrameTruncationError, readFramed } from '../src/rpc/protocols.js'
import type { NearAnchorV1, NeighborSnapshotV1 } from '../src/index.js'
import * as lp from 'it-length-prefixed'

// Wire tier of receive-side fault isolation: the measured malformed matrix driven over a real
// transport, plus the headline batch-then-recover case over TCP + noise + yamux. Extracted from
// `rpc.handler-fuzz.spec.ts`, which keeps the unit tier (`registerRpcHandler`'s release
// accounting on stub streams) and the service tier (`handleMaybeAct`'s structural validator);
// the snapshot merge caps live in `rpc.snapshot-merge-cap.spec.ts`. Fixtures shared with those
// files live in `test/helpers/rpc-fuzz.ts`.
//
// Every row here used to leave one more inbound stream permanently open on the receiving
// connection. libp2p counts inbound streams per protocol per connection (default cap 32, since
// FRET passes no `maxInboundStreams`), so 32 unparseable messages over one connection and that
// peer could never use that protocol on that connection again.

const enc = new TextEncoder()
const dec = new TextDecoder()

describe('RPC handler fault isolation over the wire', function () {
	this.timeout(30000)

	// No case in this file may leak a rejection. Registered on this describe, not at file top
	// level (a top-level hook is a *root* hook and would run against the whole suite). Its twins
	// in each sibling file are deliberately copies, not a shared import — a shared one would
	// have to be installed by a root hook to cover them all.
	const unhandled: unknown[] = []
	const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }

	before(() => { process.on('unhandledRejection', onUnhandled) })
	after(() => { process.off('unhandledRejection', onUnhandled) })

	afterEach(async () => {
		await sleep(20) // detection is a tick behind the rejection
		const seen = unhandled.splice(0).map((r) => (r instanceof Error ? r.message : String(r)))
		expect(seen, 'unhandled rejection escaped').to.deep.equal([])
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
		// Half-close first, then read. FRET framing carries the body length in-band, so the
		// reader is authoritative about when a message is complete and a close can never lose a
		// reply — including from a handler that reads no request body (ping, the neighbors
		// request) and so answers a few ticks later. Not closing at all strands the receiver,
		// whose own budgeted close waits on our write end.
		// NOTE: these two lines must stay synchronously adjacent. `readFramed` takes the stream path
		// and `byteStream` registers its `message` listener before the first `await` inside it, so no
		// transport dispatch can interleave with the close. Insert an `await` between them and a reply
		// arriving in that window is dropped, which reads as a flaky `eof`.
		const closing = stream.close().catch(() => { /* the read outcome is what this reports */ })
		const reading = readFramed(stream, 1024 * 1024, 3000)
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
		 * abort — stream aborted (a frame-level failure, or the handler threw): the sender's read
		 *   fails non-truncation. **No row in this matrix uses it today**. NOTE: accepted
		 *   tradeoff — the variant is kept deliberately rather than deleted as dead:
		 *   `runMatrix`'s `abort` arm is the assertion that a frame-level failure is still
		 *   distinguishable from a body-level drop,
		 *   which is the whole two-tier split. A payload string cannot produce one — framing
		 *   failures come out of `readFramed`, above anything `sendRaw` can express — so a row
		 *   needing it must drive the frame itself.
		 * drop — silently closed with no reply frame (undecodable body, parser rejection, or
		 *   identity mismatch): the sender sees EOF;
		 * ok — answered normally.
		 */
		expect: RowExpect
		/**
		 * Which `diag.rejected` counter this row must increment, or absent for none. Stated per
		 * row rather than derived from the row name: the two body-level drop reasons look
		 * identical on the wire (both are a close with no reply), so nothing but this field
		 * distinguishes them, and a name-matched split silently misaccounts the first row whose
		 * name reads like the other kind.
		 */
		counts?: 'malformed' | 'identityMismatch'
	}

	/** The measured defect matrix from the ticket, plus the decoder's non-object shapes. */
	function malformedMatrix(): MatrixRow[] {
		return [
			// Body-level failures, all four: a *complete* frame carrying a body that will not
			// decode. maybeAct parses in its own handler body rather than on the
			// `registerJsonHandler` seam (its token bucket must be taken first), but it follows
			// the same rule — close, no reply. Note 'truncated JSON' is named for its payload,
			// not for where it fails: the frame is whole, so it fails in `decodeJson` like the
			// other three rather than in `readFramed`.
			{ name: 'maybeAct: invalid JSON', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => '{ not: json }', expect: 'drop', counts: 'malformed' },
			{ name: 'maybeAct: truncated JSON', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => '{"v":1,"key":"', expect: 'drop', counts: 'malformed' },
			{ name: 'maybeAct: null top level', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => 'null', expect: 'drop', counts: 'malformed' },
			{ name: 'maybeAct: array top level', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => '[1,2,3]', expect: 'drop', counts: 'malformed' },
			{ name: 'maybeAct: bad base64url key', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => JSON.stringify(baseMsg({ key: '!!!bad!!!' })), expect: 'reject', counts: 'malformed' },
			{ name: 'maybeAct: absent key', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => JSON.stringify(withoutKey()), expect: 'reject', counts: 'malformed' },
			{ name: 'maybeAct: numeric breadcrumbs', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => JSON.stringify(baseMsg({ breadcrumbs: 5 })), expect: 'reject', counts: 'malformed' },
			{ name: 'maybeAct: string want_k', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => JSON.stringify(baseMsg({ want_k: 'abc' })), expect: 'reject', counts: 'malformed' },
			{ name: 'maybeAct: numeric activity', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => JSON.stringify(baseMsg({ activity: 5 })), expect: 'reject', counts: 'malformed' },
			// A well-formed frame whose *body* will not decode is a body-level failure under
			// `registerJsonHandler`, so it drops (close, no reply) rather than aborting. That is
			// the rule on every protocol — the maybeAct rows above drop for the same reason off
			// their own seam. Only *frame*-level failures (truncation, over-cap, reset) abort,
			// and no row here produces one: they come out of `readFramed`, which `sendRaw` cannot
			// drive from a payload string.
			{ name: 'leave: non-JSON', protocol: P.PROTOCOL_LEAVE, payload: () => 'total garbage', expect: 'drop', counts: 'malformed' },
			{ name: 'leave: numeric replacements', protocol: P.PROTOCOL_LEAVE, payload: (senderId) => JSON.stringify({ v: 1, from: senderId, replacements: 5, timestamp: Date.now() }), expect: 'ok' },
			// A *parseable* peer id that is not the sender: the wire-shape parser refuses an
			// unparseable `from` before the handler's identity check ever runs, so a placeholder
			// here would count as `malformed` and never reach the mismatch path it is testing.
			{ name: 'leave: from mismatch', protocol: P.PROTOCOL_LEAVE, payload: () => JSON.stringify({ v: 1, from: PEER_CLAIMED, timestamp: Date.now() }), expect: 'drop', counts: 'identityMismatch' },
			{ name: 'leave: from absent', protocol: P.PROTOCOL_LEAVE, payload: () => JSON.stringify({ v: 1, timestamp: Date.now() }), expect: 'drop', counts: 'malformed' },
			// An unparseable `from` is a *parser* rejection, so it counts `malformed` — the
			// counter split the accounting below asserts. Distinct from the mismatch row, whose
			// `from` parses fine and is refused one step later by the identity check.
			{ name: 'leave: unparseable from', protocol: P.PROTOCOL_LEAVE, payload: () => JSON.stringify({ v: 1, from: 'not-a-parseable-peer-id', timestamp: Date.now() }), expect: 'drop', counts: 'malformed' },
			// Same body-level rule as the leave rows: a decodable frame carrying an undecodable
			// body drops rather than aborting.
			{ name: 'announce: null top level', protocol: P.PROTOCOL_NEIGHBORS_ANNOUNCE, payload: () => 'null', expect: 'drop', counts: 'malformed' },
			{ name: 'announce: from mismatch', protocol: P.PROTOCOL_NEIGHBORS_ANNOUNCE, payload: () => JSON.stringify({ v: 1, from: PEER_CLAIMED, timestamp: Date.now(), successors: [], predecessors: [], sig: '' }), expect: 'drop', counts: 'identityMismatch' },
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
			await waitFor(
				() => openStreams(receiver, sender, row.protocol) === 0,
				2000,
				10,
				`${row.name}: inbound stream released`
			)
		}

		// Body-level drops split two ways now that leave/announce run on `registerJsonHandler`:
		// a body the decoder or parser refuses counts `malformed` (alongside the maybeAct
		// validator rows), while a well-formed body whose `from` is not the
		// transport-authenticated sender counts `identityMismatch`. The split is read off each
		// row's own `counts`, so adding a row states its counter rather than inheriting one from
		// how the row happens to be named.
		const after = svc.getDiagnostics().rejected
		const expected = (which: 'malformed' | 'identityMismatch'): number => rows.filter((r) => r.counts === which).length
		expect(after.malformed - before.malformed, 'every validator, decoder and parser rejection counted').to.equal(expected('malformed'))
		expect(after.identityMismatch - before.identityMismatch, 'every identity drop counted').to.equal(expected('identityMismatch'))
		// A row that rejects but names no counter is a row whose accounting was never stated.
		for (const r of rows) {
			if (r.expect === 'reject' || r.expect === 'drop') expect(r.counts, `${r.name}: states which counter it increments`).to.not.equal(undefined)
		}
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

			await waitFor(
				() => openStreams(rig.receiver, rig.sender, P.PROTOCOL_MAYBE_ACT) === 0,
				2000,
				10,
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

			await waitFor(
				() => openStreams(receiver, sender, P.PROTOCOL_MAYBE_ACT) === 0,
				2000,
				10,
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

			await waitFor(
				() => openStreams(rig.receiver, rig.sender, P.PROTOCOL_PING) === 0,
				2000,
				10,
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

			await waitFor(
				() => openStreams(receiver, sender, P.PROTOCOL_MAYBE_ACT) === 0,
				2000,
				10,
				'the batch left nothing open'
			)

			await sleep(1000) // bucket refill, as in the memory-transport case

			const reply = replyBytes(await sendRaw(sender, receiver.peerId, P.PROTOCOL_MAYBE_ACT, JSON.stringify(baseMsg())), 'well-formed message still answered')
			expect((JSON.parse(dec.decode(reply)) as NearAnchorV1).estimated_cluster_size).to.be.greaterThan(0)
		})
	})
})
