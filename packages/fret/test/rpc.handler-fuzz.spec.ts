import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { Connection, PeerId, Stream } from '@libp2p/interface'
import { createIdentifyNode, createMemNode, stopAll } from './helpers/libp2p.js'
import {
	type InboundHandler,
	type InboundStub,
	NETWORK,
	P,
	PEER_ACTUAL,
	PEER_CLAIMED,
	baseMsg,
	framed,
	inboundStub,
	json,
	peerIdStr,
	sampleCoord,
	sleep,
	withoutKey,
	wrongWidthCoord,
} from './helpers/rpc-fuzz.js'
import { waitFor } from './helpers/wait-for.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { decodeJson, encodeJson, isFrameTruncationError, readFramed, registerRpcHandler, sendFramed } from '../src/rpc/protocols.js'
import { registerMaybeAct } from '../src/rpc/maybe-act.js'
import { makeSnapshotParser, parseRouteAndMaybeAct } from '../src/rpc/validate.js'
import { registerLeave } from '../src/rpc/leave.js'
import { registerPing } from '../src/rpc/ping.js'
import { registerNeighbors } from '../src/rpc/neighbors.js'
import { hashKey, hashPeerId } from '../src/ring/hash.js'
import { peerIdFromString } from '@libp2p/peer-id'
import type { LeaveNoticeV1 } from '../src/rpc/leave.js'
import type { NearAnchorV1, NeighborSnapshotV1 } from '../src/index.js'
import * as lp from 'it-length-prefixed'
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

// ---------------------------------------------------------------------------------------------
// Unit tier: stub streams with libp2p's status lifecycle, so release-exactly-once is countable.
// ---------------------------------------------------------------------------------------------

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

	// -----------------------------------------------------------------------------------------
	// The two "why was this message rejected" counters, at the seam that feeds them.
	//
	// `registerJsonHandler` has two body-level drop paths that report through `onMalformed`
	// (`'decode'` when `decodeJson` throws, `'parse'` when the parser refuses) and a third that
	// reports through neither (`serve` returning `undefined` — the identity mismatch, which the
	// handler bodies count on their own `onIdentityMismatch`). Nothing pinned *which* reason each
	// path passes, so the two values could be swapped silently, and `FretService` wires this hook
	// to a counter it intends to split by reason later. These cases assert the reason by value.
	// -----------------------------------------------------------------------------------------
	describe('body-level drop hooks: onMalformed reason vs identity mismatch', () => {
		interface Hooks {
			/** Every `onMalformed` reason, in order — asserted by value, not by call count. */
			reasons: Array<'decode' | 'parse'>
			mismatches: number
			/** How many times the handler body's own callback (`onLeave` / `onAnnounce`) ran. */
			served: number
			/**
			 * The last notice `onLeave` received. The *normalizing* rows of the leave field
			 * matrix below assert what reached the body, not merely that it ran: a neutralized
			 * field is only pinned by the value that came through, so the counter alone would
			 * pass for a parser that normalized to something else entirely.
			 */
			lastLeave?: LeaveNoticeV1
			/** The last snapshot `onAnnounce` received — same rationale as `lastLeave` above. */
			lastAnnounce?: NeighborSnapshotV1
		}

		function hooks(): Hooks { return { reasons: [], mismatches: 0, served: 0 } }

		function snapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
			return { v: 1, from: PEER_ACTUAL, timestamp: Date.now(), successors: [], predecessors: [], sig: '', ...over }
		}

		async function registerLeaveWithHooks(node: Libp2p, h: Hooks): Promise<void> {
			await registerLeave(
				node,
				(notice) => { h.served++; h.lastLeave = notice },
				P.PROTOCOL_LEAVE,
				() => { h.mismatches++ },
				(reason) => { h.reasons.push(reason) }
			)
		}

		async function registerAnnounceWithHooks(node: Libp2p, h: Hooks): Promise<void> {
			await registerNeighbors(
				node,
				() => snapshot() as unknown as NeighborSnapshotV1,
				(_from, snap) => { h.served++; h.lastAnnounce = snap },
				{ PROTOCOL_NEIGHBORS: P.PROTOCOL_NEIGHBORS, PROTOCOL_NEIGHBORS_ANNOUNCE: P.PROTOCOL_NEIGHBORS_ANNOUNCE },
				128 * 1024,
				() => { h.mismatches++ },
				undefined,
				// Explicit rather than defaulted, mirroring how `FretService` supplies it; the
				// default is covered on its own below.
				makeSnapshotParser({ successors: 16, predecessors: 16, sample: 8 }),
				(reason) => { h.reasons.push(reason) }
			)
		}

		interface Subject {
			name: string
			protocol: string
			register: (node: Libp2p, h: Hooks) => Promise<void>
			/** Decodes to an object the parser refuses: `from` will not parse as a peer id. */
			parseReject: () => Record<string, unknown>
			/** Decodes and parses, but `from` is a *different* parseable peer id than the sender. */
			mismatched: () => Record<string, unknown>
		}

		const subjects: Subject[] = [
			{
				name: 'leave',
				protocol: P.PROTOCOL_LEAVE,
				register: registerLeaveWithHooks,
				parseReject: () => ({ v: 1, from: 'not-a-parseable-peer-id', timestamp: Date.now() }),
				mismatched: () => ({ v: 1, from: PEER_CLAIMED, timestamp: Date.now() }),
			},
			{
				name: 'announce',
				protocol: P.PROTOCOL_NEIGHBORS_ANNOUNCE,
				register: registerAnnounceWithHooks,
				parseReject: () => snapshot({ from: 'not-a-parseable-peer-id' }),
				mismatched: () => snapshot({ from: PEER_CLAIMED }),
			},
		]

		/**
		 * Drive one body through a freshly registered handler and report what the seam did.
		 * Shared with the leave field matrix below rather than copied into it — the matrix wants
		 * this exact rig against this exact `Hooks` record.
		 */
		async function driveWith(
			protocol: string,
			register: (node: Libp2p, h: Hooks) => Promise<void>,
			chunks: Uint8Array[]
		): Promise<{ h: Hooks; s: InboundStub }> {
			const { node, invoke } = fakeNode()
			const h = hooks()
			await register(node, h)
			const s = inboundStub(chunks)
			await invoke(protocol, s.stream, PEER_ACTUAL)
			return { h, s }
		}

		/** Every body-level drop is a close with no reply, and never runs the body. */
		function expectDropped(h: Hooks, s: InboundStub, label: string): void {
			expect({ closes: s.closes, aborts: s.aborts }, `${label}: closed, never aborted`).to.deep.equal({ closes: 1, aborts: 0 })
			expect(s.sends, `${label}: no reply sent`).to.equal(0)
			expect(h.served, `${label}: handler body never ran`).to.equal(0)
		}

		for (const subject of subjects) {
			describe(subject.name, () => {
				const drive = (chunks: Uint8Array[]): Promise<{ h: Hooks; s: InboundStub }> =>
					driveWith(subject.protocol, subject.register, chunks)

				it("reports 'decode' for a body that is not JSON", async () => {
					const { h, s } = await drive([framed('!!! definitely not json !!!')])

					expect(h.reasons, 'reason asserted by value').to.deep.equal(['decode'])
					expect(h.mismatches, 'a decode failure is not an identity mismatch').to.equal(0)
					expectDropped(h, s, 'non-JSON body')
				})

				it("reports 'decode' for a body that decodes to a non-object", async () => {
					// `decodeJson` rejects any non-object top level, so this takes the same arm as
					// unparseable text — the parser is never reached.
					const { h, s } = await drive([framed('null')])

					expect(h.reasons).to.deep.equal(['decode'])
					expect(h.mismatches).to.equal(0)
					expectDropped(h, s, 'non-object body')
				})

				it("reports 'parse' for a decodable object the parser rejects", async () => {
					const { h, s } = await drive([json(subject.parseReject())])

					expect(h.reasons, "the parser arm, not the decode arm").to.deep.equal(['parse'])
					expectDropped(h, s, 'parser-rejected body')
				})

				// The pair the split exists for. An unparseable `from` never reaches `serve`, so
				// the identity check cannot see it; a parseable-but-wrong `from` reaches `serve`
				// and is refused there, a path `onMalformed` is deliberately not on.
				it('counts an unparseable `from` as malformed and never as an identity mismatch', async () => {
					const { h, s } = await drive([json(subject.parseReject())])

					expect(h.reasons).to.deep.equal(['parse'])
					expect(h.mismatches, 'the parser runs before serve, so the identity check never ran').to.equal(0)
					expectDropped(h, s, 'unparseable from')
				})

				it('counts a parseable-but-wrong `from` as an identity mismatch and never as malformed', async () => {
					const { h, s } = await drive([json(subject.mismatched())])

					expect(h.mismatches, 'the serve-returns-undefined drop').to.equal(1)
					expect(h.reasons, 'neither onMalformed arm is on the identity path').to.deep.equal([])
					expectDropped(h, s, 'mismatched from')
				})
			})
		}

		// -------------------------------------------------------------------------------------
		// Leave notice, one row per field per way of being wrong.
		//
		// The columns are deliberately *not* uniform, because `parseLeaveNotice` does not treat
		// its three fields alike. `from` and `timestamp` are load-bearing (the receiver removes
		// the peer `from` names), so a wrong value **rejects**: the whole notice drops, the seam
		// closes with no reply, and `onLeave` never runs. `replacements` is advisory, so a wrong
		// value **normalizes**: the notice is still served and still answered `{ok: true}`, with
		// the field neutralized. "Over cap" is meaningful only for the list field, and "missing"
		// collapses into "wrong type" for the two rejecting ones. So each row states its own
		// expectation rather than inheriting one from its column.
		//
		// Every row asserts the release *arm* (close, never abort) rather than only the release
		// count: the count alone passes for an abort too, so it would prove nothing about the
		// rule that body-level drops close and only frame-level failures tear the stream down.
		// -------------------------------------------------------------------------------------
		describe('leave notice field matrix', () => {
			interface FieldRow {
				name: string
				body: () => Record<string, unknown>
				/** `reject` — the whole notice drops. `normalize` — served and answered, field neutralized. */
				expect: 'reject' | 'normalize'
				/**
				 * For `normalize` rows: the `replacements` value `onLeave` must have received.
				 * `undefined` means the key is *absent* from the notice, not present-and-empty —
				 * `parseLeaveNotice` deletes it rather than writing `[]`, and the two are
				 * different things to a receiver that iterates it.
				 */
				replacements?: string[]
			}

			function wellFormed(over: Record<string, unknown> = {}): Record<string, unknown> {
				return { v: 1, from: PEER_ACTUAL, timestamp: Date.now(), ...over }
			}

			function without(field: string): Record<string, unknown> {
				const m = wellFormed()
				delete m[field]
				return m
			}

			/** 15 parseable ids — past the 12-entry cap `sanitizeReplacements` slices to. */
			const overCap = Array.from({ length: 15 }, (_, i) => peerIdStr(20 + i))
			/** 12 unparseable entries, then 3 parseable ones sitting past the cap. */
			const validPastTheSlice = [
				...Array.from({ length: 12 }, (_, i) => `not-a-peer-${i}`),
				...Array.from({ length: 3 }, (_, i) => peerIdStr(50 + i)),
			]

			const rows: FieldRow[] = [
				// `from` — must satisfy `isPeerIdString` (a `peerIdFromString` try/catch).
				{ name: 'from: unparseable string', body: () => wellFormed({ from: 'not-a-parseable-peer-id' }), expect: 'reject' },
				{ name: 'from: empty string', body: () => wellFormed({ from: '' }), expect: 'reject' },
				{ name: 'from: wrong type (number)', body: () => wellFormed({ from: 5 }), expect: 'reject' },
				{ name: 'from: wrong type (array)', body: () => wellFormed({ from: [PEER_ACTUAL] }), expect: 'reject' },
				{ name: 'from: wrong type (object)', body: () => wellFormed({ from: { id: PEER_ACTUAL } }), expect: 'reject' },
				{ name: 'from: null', body: () => wellFormed({ from: null }), expect: 'reject' },
				{ name: 'from: missing', body: () => without('from'), expect: 'reject' },

				// `timestamp` — must be a finite `number`. Nothing coerces, which is why the
				// numeric-string row is worth stating on its own: '5' rejects exactly like 'now'.
				{ name: 'timestamp: numeric string', body: () => wellFormed({ timestamp: '5' }), expect: 'reject' },
				{ name: 'timestamp: non-numeric string', body: () => wellFormed({ timestamp: 'now' }), expect: 'reject' },
				{ name: 'timestamp: wrong type (boolean)', body: () => wellFormed({ timestamp: true }), expect: 'reject' },
				{ name: 'timestamp: null', body: () => wellFormed({ timestamp: null }), expect: 'reject' },
				{ name: 'timestamp: missing', body: () => without('timestamp'), expect: 'reject' },

				// `replacements` — any non-array is treated as absent. It used to reach `.slice`
				// and throw out of the handler, which leaked the inbound stream.
				{ name: 'replacements: wrong type (number)', body: () => wellFormed({ replacements: 5 }), expect: 'normalize', replacements: undefined },
				{ name: 'replacements: wrong type (string)', body: () => wellFormed({ replacements: PEER_CLAIMED }), expect: 'normalize', replacements: undefined },
				{ name: 'replacements: wrong type (object)', body: () => wellFormed({ replacements: { 0: PEER_CLAIMED } }), expect: 'normalize', replacements: undefined },
				{ name: 'replacements: null', body: () => wellFormed({ replacements: null }), expect: 'normalize', replacements: undefined },
				{ name: 'replacements: missing', body: () => without('replacements'), expect: 'normalize', replacements: undefined },
				{ name: 'replacements: empty array', body: () => wellFormed({ replacements: [] }), expect: 'normalize', replacements: undefined },
				{ name: 'replacements: every entry unparseable', body: () => wellFormed({ replacements: ['nope', 'also-nope'] }), expect: 'normalize', replacements: undefined },
				{ name: 'replacements: non-string entries', body: () => wellFormed({ replacements: [1, 2, 3] }), expect: 'normalize', replacements: undefined },
				// Over cap: sliced to 12, in order.
				{ name: 'replacements: over the 12 cap', body: () => wellFormed({ replacements: overCap }), expect: 'normalize', replacements: overCap.slice(0, 12) },
				// Mixed: the unparseable entries are dropped rather than rejecting the message.
				{ name: 'replacements: mixed valid and invalid', body: () => wellFormed({ replacements: [peerIdStr(40), 'nope', peerIdStr(41), 7, peerIdStr(42)] }), expect: 'normalize', replacements: [peerIdStr(40), peerIdStr(41), peerIdStr(42)] },
				// The row that pins the *order* of the two operations. `sanitizeReplacements`
				// slices to 12 and only then filters, so parseable ids sitting past the cap are
				// gone before the filter sees them and the result is empty. Filter-then-slice
				// would keep all three, so this row fails if the two are ever swapped.
				{ name: 'replacements: valid entries sitting past the slice', body: () => wellFormed({ replacements: validPastTheSlice }), expect: 'normalize', replacements: undefined },
			]

			for (const row of rows) {
				it(`${row.expect}s — ${row.name}`, async () => {
					const { h, s } = await driveWith(P.PROTOCOL_LEAVE, registerLeaveWithHooks, [json(row.body())])

					if (row.expect === 'reject') {
						expectDropped(h, s, row.name)
						expect(h.reasons, `${row.name}: the parser arm, not the decoder's`).to.deep.equal(['parse'])
						expect(h.mismatches, `${row.name}: the parser runs before serve`).to.equal(0)
						return
					}

					// Normalizing rows: the notice is still a notice, and still answered.
					expect({ closes: s.closes, aborts: s.aborts }, `${row.name}: closed, never aborted`).to.deep.equal({ closes: 1, aborts: 0 })
					expect(h.reasons, `${row.name}: nothing malformed about a normalized field`).to.deep.equal([])
					expect(h.served, `${row.name}: onLeave ran`).to.equal(1)
					const reply = await decodeFramed<{ ok: boolean }>(s.replies[0]!)
					expect(reply.ok, `${row.name}: answered ok`).to.equal(true)

					// What reached the body, not merely that it did.
					const notice = h.lastLeave!
					expect(notice.from, `${row.name}: from untouched`).to.equal(PEER_ACTUAL)
					if (row.replacements === undefined) {
						expect('replacements' in notice, `${row.name}: the key is deleted, not emptied`).to.equal(false)
					} else {
						expect(notice.replacements, `${row.name}: normalized list`).to.deep.equal(row.replacements)
					}
				})
			}
		})

		// -------------------------------------------------------------------------------------
		// Announce snapshot, one row per field per way of being wrong. Mirrors the leave field
		// matrix above: `from` and `timestamp` are load-bearing (identity check, freshness),
		// so a wrong value **rejects** the whole snapshot. `successors` / `predecessors` are
		// `boundedStringArray(value, cap)` — any non-array (including missing) normalizes to
		// `[]`, entries are truncated to `cap` *then* filtered to strings, in that order.
		// `sample` and the advisory numerics are the sibling ticket's rows, appended to this
		// same table without restructuring it.
		// -------------------------------------------------------------------------------------
		describe('announce snapshot field matrix', () => {
			interface FieldRow {
				name: string
				body: () => Record<string, unknown>
				/** `reject` — the whole snapshot drops. `normalize` — served, field neutralized. */
				expect: 'reject' | 'normalize'
				/** For `normalize` rows: assert what reached `onAnnounce` beyond the defaults. */
				expectSnapshot?: (snap: NeighborSnapshotV1) => void
			}

			/** `snapshot()` already sets successors/predecessors/sig, so "missing" needs a delete. */
			function withoutField(field: string): Record<string, unknown> {
				const m = snapshot()
				delete m[field]
				return m
			}

			/** The cap `registerAnnounceWithHooks` supplies to `makeSnapshotParser`. */
			const SUCC_PRED_CAP = 16

			function succPredRows(field: 'successors' | 'predecessors'): FieldRow[] {
				const overCap = Array.from({ length: 20 }, (_, i) => `${field}-${i}`)
				// cap non-strings, then one valid string past the slice — must vanish entirely.
				const truncateThenFilter: unknown[] = [
					...Array.from({ length: SUCC_PRED_CAP }, () => 7),
					'past-the-slice',
				]
				const expectEmpty = (s: NeighborSnapshotV1): void => {
					expect(s[field], `${field}: normalizes to []`).to.deep.equal([])
				}
				return [
					{ name: `${field}: non-array (number)`, body: () => snapshot({ [field]: 5 }), expect: 'normalize', expectSnapshot: expectEmpty },
					{ name: `${field}: non-array (string)`, body: () => snapshot({ [field]: 'nope' }), expect: 'normalize', expectSnapshot: expectEmpty },
					{ name: `${field}: non-array (object)`, body: () => snapshot({ [field]: { 0: 'a' } }), expect: 'normalize', expectSnapshot: expectEmpty },
					{ name: `${field}: non-array (null)`, body: () => snapshot({ [field]: null }), expect: 'normalize', expectSnapshot: expectEmpty },
					{ name: `${field}: missing`, body: () => withoutField(field), expect: 'normalize', expectSnapshot: expectEmpty },
					{ name: `${field}: array of non-strings`, body: () => snapshot({ [field]: [1, 2, 3] }), expect: 'normalize', expectSnapshot: expectEmpty },
					{
						name: `${field}: over the ${SUCC_PRED_CAP} cap`,
						body: () => snapshot({ [field]: overCap }),
						expect: 'normalize',
						expectSnapshot: (s) => expect(s[field]).to.deep.equal(overCap.slice(0, SUCC_PRED_CAP)),
					},
					{
						name: `${field}: mixed valid and invalid entries`,
						body: () => snapshot({ [field]: ['a', 5, 'b', null, 'c'] }),
						expect: 'normalize',
						expectSnapshot: (s) => expect(s[field]).to.deep.equal(['a', 'b', 'c']),
					},
					{
						// Pins truncate-then-filter order: filter-then-slice would keep 'past-the-slice'.
						name: `${field}: truncate-then-filter order (valid entry past the slice)`,
						body: () => snapshot({ [field]: truncateThenFilter }),
						expect: 'normalize',
						expectSnapshot: expectEmpty,
					},
				]
			}

			/** The cap `registerAnnounceWithHooks` supplies to `makeSnapshotParser` for `sample`. */
			const SAMPLE_CAP = 8

			function sampleEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
				return { id: 'sample-peer', coord: sampleCoord(9), relevance: 0.5, ...over }
			}

			const sampleRows: FieldRow[] = [
				{ name: 'sample: non-array (number)', body: () => snapshot({ sample: 5 }), expect: 'normalize', expectSnapshot: (s) => expect(s.sample).to.deep.equal([]) },
				{ name: 'sample: non-array (string)', body: () => snapshot({ sample: 'nope' }), expect: 'normalize', expectSnapshot: (s) => expect(s.sample).to.deep.equal([]) },
				{ name: 'sample: non-array (object)', body: () => snapshot({ sample: { 0: sampleEntry() } }), expect: 'normalize', expectSnapshot: (s) => expect(s.sample).to.deep.equal([]) },
				{ name: 'sample: non-array (null)', body: () => snapshot({ sample: null }), expect: 'normalize', expectSnapshot: (s) => expect(s.sample).to.deep.equal([]) },
				{ name: 'sample: missing', body: () => withoutField('sample'), expect: 'normalize', expectSnapshot: (s) => expect(s.sample).to.deep.equal([]) },

				{
					name: 'sample: entry not a plain object (number)',
					body: () => snapshot({ sample: [7, sampleEntry({ id: 'ok-1' })] }),
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([{ id: 'ok-1', coord: sampleCoord(9), relevance: 0.5 }]),
				},
				{
					name: 'sample: entry not a plain object (string)',
					body: () => snapshot({ sample: ['nope', sampleEntry({ id: 'ok-2' })] }),
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([{ id: 'ok-2', coord: sampleCoord(9), relevance: 0.5 }]),
				},
				{
					name: 'sample: entry not a plain object (null)',
					body: () => snapshot({ sample: [null, sampleEntry({ id: 'ok-3' })] }),
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([{ id: 'ok-3', coord: sampleCoord(9), relevance: 0.5 }]),
				},
				{
					name: 'sample: entry not a plain object (array)',
					body: () => snapshot({ sample: [['x'], sampleEntry({ id: 'ok-4' })] }),
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([{ id: 'ok-4', coord: sampleCoord(9), relevance: 0.5 }]),
				},
				{
					name: 'sample: id missing',
					body: () => {
						const bad = sampleEntry() as Record<string, unknown>
						delete bad.id
						return snapshot({ sample: [bad, sampleEntry({ id: 'ok-5' })] })
					},
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([{ id: 'ok-5', coord: sampleCoord(9), relevance: 0.5 }]),
				},
				{
					name: 'sample: id not a string',
					body: () => snapshot({ sample: [sampleEntry({ id: 5 }), sampleEntry({ id: 'ok-6' })] }),
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([{ id: 'ok-6', coord: sampleCoord(9), relevance: 0.5 }]),
				},
				{
					name: 'sample: coord missing',
					body: () => {
						const bad = sampleEntry({ id: 'bad' }) as Record<string, unknown>
						delete bad.coord
						return snapshot({ sample: [bad, sampleEntry({ id: 'ok-7' })] })
					},
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([{ id: 'ok-7', coord: sampleCoord(9), relevance: 0.5 }]),
				},
				{
					name: 'sample: coord not a string',
					body: () => snapshot({ sample: [sampleEntry({ id: 'bad', coord: 5 }), sampleEntry({ id: 'ok-8' })] }),
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([{ id: 'ok-8', coord: sampleCoord(9), relevance: 0.5 }]),
				},
				{
					name: 'sample: relevance missing',
					body: () => {
						const bad = sampleEntry({ id: 'bad' }) as Record<string, unknown>
						delete bad.relevance
						return snapshot({ sample: [bad, sampleEntry({ id: 'ok-9' })] })
					},
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([{ id: 'ok-9', coord: sampleCoord(9), relevance: 0.5 }]),
				},
				{
					name: 'sample: relevance a string',
					body: () => snapshot({ sample: [sampleEntry({ id: 'bad', relevance: '0.5' }), sampleEntry({ id: 'ok-10' })] }),
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([{ id: 'ok-10', coord: sampleCoord(9), relevance: 0.5 }]),
				},
				{
					name: 'sample: relevance null',
					body: () => snapshot({ sample: [sampleEntry({ id: 'bad', relevance: null }), sampleEntry({ id: 'ok-11' })] }),
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([{ id: 'ok-11', coord: sampleCoord(9), relevance: 0.5 }]),
				},
				{
					name: 'sample: coord decodes to the wrong width (too short)',
					body: () => snapshot({ sample: [sampleEntry({ id: 'bad', coord: wrongWidthCoord(16) }), sampleEntry({ id: 'ok-12' })] }),
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([{ id: 'ok-12', coord: sampleCoord(9), relevance: 0.5 }]),
				},
				{
					name: 'sample: coord decodes to the wrong width (too long)',
					body: () => snapshot({ sample: [sampleEntry({ id: 'bad', coord: wrongWidthCoord(48) }), sampleEntry({ id: 'ok-13' })] }),
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([{ id: 'ok-13', coord: sampleCoord(9), relevance: 0.5 }]),
				},
				{
					name: `sample: over the ${SAMPLE_CAP} cap keeps exactly the first ${SAMPLE_CAP}, in order`,
					body: () => snapshot({ sample: Array.from({ length: 10 }, (_, i) => sampleEntry({ id: `over-${i}`, coord: sampleCoord(i + 1) })) }),
					expect: 'normalize',
					expectSnapshot: (s) =>
						expect(s.sample).to.deep.equal(Array.from({ length: SAMPLE_CAP }, (_, i) => ({ id: `over-${i}`, coord: sampleCoord(i + 1), relevance: 0.5 }))),
				},
				{
					// The row above cannot distinguish the two orders — with every entry valid,
					// slice-then-filter and filter-then-slice agree. This one separates them, the
					// same way `truncateThenFilter` does for the id lists: `SAMPLE_CAP` unusable
					// entries followed by a valid one. Slice-then-filter (today) drops the valid
					// entry along with the junk that displaced it; filter-then-slice would keep it,
					// letting an over-long list of junk smuggle real entries in behind the cap.
					name: `sample: truncate-then-filter order (valid entry past the ${SAMPLE_CAP} slice)`,
					body: () => snapshot({ sample: [...Array.from({ length: SAMPLE_CAP }, () => 7), sampleEntry({ id: 'past-the-slice' })] }),
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([]),
				},
				{
					// `parseSample` rebuilds each entry from the three fields it vetted rather than
					// passing the received object through, so an attacker cannot ride extra keys
					// into the merge loop. Unlike `sig` at the top level, nothing here is carried.
					name: 'sample: entry is rebuilt from vetted fields, extra keys dropped',
					body: () => snapshot({ sample: [sampleEntry({ id: 'extras', extra: 'ride-along', coord2: sampleCoord(1) })] }),
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([{ id: 'extras', coord: sampleCoord(9), relevance: 0.5 }]),
				},
				{
					// The wrong-width rows above trip `base64urlToCoord`'s own length check; these
					// two trip the *decoder* underneath it, which is a different throw site. Both
					// must be caught by `parseSample`, or a malformed coord escapes the parser and
					// reaches the store's write seam inside the merge loop.
					name: 'sample: coord is not decodable base64url at all',
					body: () => snapshot({ sample: [sampleEntry({ id: 'bad', coord: '!!!not-base64!!!' }), sampleEntry({ id: 'ok-14' })] }),
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([{ id: 'ok-14', coord: sampleCoord(9), relevance: 0.5 }]),
				},
				{
					name: 'sample: coord is an empty string',
					body: () => snapshot({ sample: [sampleEntry({ id: 'bad', coord: '' }), sampleEntry({ id: 'ok-15' })] }),
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.sample).to.deep.equal([{ id: 'ok-15', coord: sampleCoord(9), relevance: 0.5 }]),
				},
			]

			function advisoryNumberRows(field: 'size_estimate' | 'confidence'): FieldRow[] {
				const expectAbsent = (s: NeighborSnapshotV1): void => {
					expect(field in s, `${field}: key absent, not present-and-zero`).to.equal(false)
				}
				return [
					{ name: `${field}: wrong type (string)`, body: () => snapshot({ [field]: 'nope' }), expect: 'normalize', expectSnapshot: expectAbsent },
					{ name: `${field}: null`, body: () => snapshot({ [field]: null }), expect: 'normalize', expectSnapshot: expectAbsent },
					{ name: `${field}: missing`, body: () => withoutField(field), expect: 'normalize', expectSnapshot: expectAbsent },
					{
						name: `${field}: valid finite value survives unchanged`,
						body: () => snapshot({ [field]: 0.42 }),
						expect: 'normalize',
						expectSnapshot: (s) => expect((s as unknown as Record<string, unknown>)[field]).to.equal(0.42),
					},
				]
			}

			const metadataRows: FieldRow[] = [
				{ name: 'metadata: array', body: () => snapshot({ metadata: ['a'] }), expect: 'normalize', expectSnapshot: (s) => expect('metadata' in s).to.equal(false) },
				{ name: 'metadata: null', body: () => snapshot({ metadata: null }), expect: 'normalize', expectSnapshot: (s) => expect('metadata' in s).to.equal(false) },
				{ name: 'metadata: number', body: () => snapshot({ metadata: 5 }), expect: 'normalize', expectSnapshot: (s) => expect('metadata' in s).to.equal(false) },
				{ name: 'metadata: string', body: () => snapshot({ metadata: 'nope' }), expect: 'normalize', expectSnapshot: (s) => expect('metadata' in s).to.equal(false) },
				{ name: 'metadata: missing', body: () => withoutField('metadata'), expect: 'normalize', expectSnapshot: (s) => expect('metadata' in s).to.equal(false) },
				{
					name: 'metadata: plain object survives unchanged',
					body: () => snapshot({ metadata: { app: 'test', n: 1 } }),
					expect: 'normalize',
					expectSnapshot: (s) => expect(s.metadata).to.deep.equal({ app: 'test', n: 1 }),
				},
			]

			const rows: FieldRow[] = [
				{ name: 'from: unparseable string', body: () => snapshot({ from: 'not-a-parseable-peer-id' }), expect: 'reject' },
				{ name: 'from: empty string', body: () => snapshot({ from: '' }), expect: 'reject' },
				{ name: 'from: wrong type (number)', body: () => snapshot({ from: 5 }), expect: 'reject' },
				{ name: 'from: wrong type (array)', body: () => snapshot({ from: [PEER_ACTUAL] }), expect: 'reject' },
				{ name: 'from: wrong type (object)', body: () => snapshot({ from: { id: PEER_ACTUAL } }), expect: 'reject' },
				{ name: 'from: null', body: () => snapshot({ from: null }), expect: 'reject' },
				{ name: 'from: missing', body: () => withoutField('from'), expect: 'reject' },

				{ name: 'timestamp: numeric string', body: () => snapshot({ timestamp: '5' }), expect: 'reject' },
				{ name: 'timestamp: non-numeric string', body: () => snapshot({ timestamp: 'now' }), expect: 'reject' },
				{ name: 'timestamp: wrong type (boolean)', body: () => snapshot({ timestamp: true }), expect: 'reject' },
				{ name: 'timestamp: null', body: () => snapshot({ timestamp: null }), expect: 'reject' },
				{ name: 'timestamp: missing', body: () => withoutField('timestamp'), expect: 'reject' },

				...succPredRows('successors'),
				...succPredRows('predecessors'),

				...sampleRows,
				...advisoryNumberRows('size_estimate'),
				...advisoryNumberRows('confidence'),
				...metadataRows,

				// `sig` is deliberately unchecked — message signing is unimplemented, so nothing
				// reads it. These rows make that decision testable rather than implicit: whatever
				// arrives is carried through untouched, and an absent one stays absent. They fail
				// if `sig` ever gains a shape rule without the decision being revisited here.
				{
					name: 'sig: wrong type (number) passes through untouched',
					body: () => snapshot({ sig: 5 }),
					expect: 'normalize',
					expectSnapshot: (s) => expect((s as unknown as Record<string, unknown>).sig).to.equal(5),
				},
				{
					name: 'sig: null passes through untouched',
					body: () => snapshot({ sig: null }),
					expect: 'normalize',
					expectSnapshot: (s) => expect((s as unknown as Record<string, unknown>).sig).to.equal(null),
				},
				{
					name: 'sig: missing stays absent',
					body: () => withoutField('sig'),
					expect: 'normalize',
					expectSnapshot: (s) => expect('sig' in s, 'sig: not synthesized').to.equal(false),
				},
			]

			for (const row of rows) {
				it(`${row.expect}s — ${row.name}`, async () => {
					const { h, s } = await driveWith(P.PROTOCOL_NEIGHBORS_ANNOUNCE, registerAnnounceWithHooks, [json(row.body())])

					if (row.expect === 'reject') {
						expectDropped(h, s, row.name)
						expect(h.reasons, `${row.name}: the parser arm, not the decoder's`).to.deep.equal(['parse'])
						expect(h.mismatches, `${row.name}: the parser runs before serve`).to.equal(0)
						return
					}

					expect({ closes: s.closes, aborts: s.aborts }, `${row.name}: closed, never aborted`).to.deep.equal({ closes: 1, aborts: 0 })
					expect(h.reasons, `${row.name}: nothing malformed about a normalized field`).to.deep.equal([])
					expect(h.served, `${row.name}: onAnnounce ran`).to.equal(1)
					const reply = await decodeFramed<{ ok: boolean }>(s.replies[0]!)
					expect(reply.ok, `${row.name}: answered ok`).to.equal(true)

					const snap = h.lastAnnounce!
					expect(snap.from, `${row.name}: from untouched`).to.equal(PEER_ACTUAL)
					row.expectSnapshot?.(snap)
				})
			}
		})

		// `registerNeighbors`' `snapshotParser` is trailing and defaulted, and every production
		// caller supplies one — so the default (`Infinity` caps: "validate the shape, truncate
		// nothing") is reachable only from tests and was untested. Omitting it means also omitting
		// `onMalformed`, which is the parameter after it, so the rejection is asserted through the
		// drop's observable effects rather than through the hook.
		describe("registerNeighbors' defaulted snapshotParser", () => {
			async function driveDefault(body: Record<string, unknown>): Promise<{ announced: NeighborSnapshotV1 | undefined; s: InboundStub }> {
				const { node, invoke } = fakeNode()
				let announced: NeighborSnapshotV1 | undefined
				await registerNeighbors(
					node,
					() => snapshot() as unknown as NeighborSnapshotV1,
					(_from, snap) => { announced = snap },
					{ PROTOCOL_NEIGHBORS: P.PROTOCOL_NEIGHBORS, PROTOCOL_NEIGHBORS_ANNOUNCE: P.PROTOCOL_NEIGHBORS_ANNOUNCE },
					128 * 1024
				)
				const s = inboundStub([json(body)])
				await invoke(P.PROTOCOL_NEIGHBORS_ANNOUNCE, s.stream, PEER_ACTUAL)
				return { announced, s }
			}

			it('still rejects a malformed snapshot, so shape checking is live', async () => {
				const { announced, s } = await driveDefault(snapshot({ from: 'not-a-parseable-peer-id' }))

				expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 1, aborts: 0 })
				expect(s.sends, 'no reply for a dropped snapshot').to.equal(0)
				expect(announced, 'onAnnounce never ran').to.equal(undefined)
			})

			it('truncates nothing — an id list far past any profile cap is merged whole', async () => {
				// 50 is well past the largest production cap (Core 16 successors / 16 predecessors).
				const successors = Array.from({ length: 50 }, (_, i) => peerIdStr(10 + i))
				const { announced, s } = await driveDefault(snapshot({ successors }))

				expect({ closes: s.closes, aborts: s.aborts }).to.deep.equal({ closes: 1, aborts: 0 })
				expect(announced?.successors, 'the whole list, in order').to.deep.equal(successors)
				const reply = await decodeFramed<{ ok: boolean }>(s.replies[0]!)
				expect(reply.ok).to.equal(true)
			})
		})
	})

	// -----------------------------------------------------------------------------------------
	// Frame-level failures abort, where body-level failures close.
	//
	// `registerJsonHandler` reads through `readFramed` and lets a framing throw propagate into
	// `registerRpcHandler`'s error arm, so a frame that never yielded a body is torn down rather
	// than closed politely. Nothing was committed on either path, so there is no reply to protect.
	// -----------------------------------------------------------------------------------------
	describe('frame-level failures abort', () => {
		/** The cap `registerLeave` fixes inside itself — not a parameter of the registration. */
		const LEAVE_MAX_BYTES = 4096

		async function driveLeave(chunks: Uint8Array[]): Promise<{ served: number; s: InboundStub }> {
			const { node, invoke } = fakeNode()
			let served = 0
			await registerLeave(node, () => { served++ }, P.PROTOCOL_LEAVE)
			const s = inboundStub(chunks)
			await invoke(P.PROTOCOL_LEAVE, s.stream, PEER_ACTUAL)
			return { served, s }
		}

		it('aborts a truncated frame — a length prefix promising more bytes than follow', async () => {
			const whole = json({ v: 1, from: PEER_ACTUAL, timestamp: Date.now() })
			const truncated = whole.subarray(0, whole.byteLength - 5)

			const { served, s } = await driveLeave([truncated])

			// The source runs out mid-frame, `readFramed` sees `done` and raises
			// `FrameTruncationError`. Contrast the body-level rows above, which arrive as one
			// well-formed frame and therefore close.
			expect({ closes: s.closes, aborts: s.aborts }, 'torn down, not closed').to.deep.equal({ closes: 0, aborts: 1 })
			expect(s.sends, 'no reply written').to.equal(0)
			expect(served, 'onLeave never ran').to.equal(0)
		})

		it('aborts an over-cap frame at the length prefix, without pulling the body', async () => {
			const body = enc.encode('x'.repeat(LEAVE_MAX_BYTES * 2))
			const frame = lp.encode.single(body).subarray()
			const prefixLen = frame.byteLength - body.byteLength
			// Handed over as two chunks on purpose: `lp.decode` pulls whole chunks, so one chunk
			// carrying prefix+body would be delivered by a single pull and the counter below
			// would pass whatever the decoder did with the body. Split at the varint boundary,
			// "the body was never pulled" is measured rather than inferred — the same
			// measure-do-not-infer rule `test/rpc.codec-properties.spec.ts` applies to the codec.
			const chunks = [frame.subarray(0, prefixLen), frame.subarray(prefixLen)]

			const { served, s } = await driveLeave(chunks)

			expect({ closes: s.closes, aborts: s.aborts }, 'torn down, not closed').to.deep.equal({ closes: 0, aborts: 1 })
			expect(s.pulls, 'refused in onLength — the body was never pulled').to.equal(1)
			expect(s.sends, 'no reply written').to.equal(0)
			expect(served, 'onLeave never ran').to.equal(0)
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
		 * abort — stream aborted (decode/handler threw): the sender's read fails non-truncation;
		 * drop — silently closed with no reply frame (identity mismatch): the sender sees EOF;
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
			{ name: 'maybeAct: invalid JSON', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => '{ not: json }', expect: 'abort' },
			{ name: 'maybeAct: truncated JSON', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => '{"v":1,"key":"', expect: 'abort' },
			{ name: 'maybeAct: null top level', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => 'null', expect: 'abort' },
			{ name: 'maybeAct: array top level', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => '[1,2,3]', expect: 'abort' },
			{ name: 'maybeAct: bad base64url key', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => JSON.stringify(baseMsg({ key: '!!!bad!!!' })), expect: 'reject', counts: 'malformed' },
			{ name: 'maybeAct: absent key', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => JSON.stringify(withoutKey()), expect: 'reject', counts: 'malformed' },
			{ name: 'maybeAct: numeric breadcrumbs', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => JSON.stringify(baseMsg({ breadcrumbs: 5 })), expect: 'reject', counts: 'malformed' },
			{ name: 'maybeAct: string want_k', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => JSON.stringify(baseMsg({ want_k: 'abc' })), expect: 'reject', counts: 'malformed' },
			{ name: 'maybeAct: numeric activity', protocol: P.PROTOCOL_MAYBE_ACT, payload: () => JSON.stringify(baseMsg({ activity: 5 })), expect: 'reject', counts: 'malformed' },
			// A well-formed frame whose *body* will not decode is a body-level failure under
			// `registerJsonHandler`, so it drops (close, no reply) rather than aborting. Framing
			// failures still abort — see the maybeAct rows above, which are not on that seam.
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

	// -----------------------------------------------------------------------------------------
	// Service tier: what an over-long announce actually costs the receiver.
	//
	// `onAnnounce` is handed an *already-parsed* snapshot, so the parse + hash + upsert loop a
	// crafted announce drives is `FretService.mergeAnnounceSnapshot`, and its bound is
	// `FretService.mergeSnapshotCaps()` — enforced at the **snapshot parser**, which is the single
	// enforcement point. `makeSnapshotParser(mergeSnapshotCaps())` is handed to `registerNeighbors`
	// at the one registration site (announce) and to `fetchNeighbors` as its `parse` option (fetch),
	// and neither merge loop slices any more. So these tests drive the parser + merge pair the way
	// production drives it, and pin that an unparsed body is merged whole — which is what makes
	// "the parser is where the cap lives" a fact rather than a comment.
	//
	// The work is **counted** (`store.upsert` calls, by id and in order) rather than inferred from
	// "nothing crashed" — a cap that silently stopped applying would leave a passing no-crash test
	// and an unbounded per-message cost. Driven on unstarted services against
	// `mergeAnnounceSnapshot` directly, because `handleAnnounce` `detach`es the merge and a
	// detached merge cannot be counted deterministically. The one exception is the wiring test
	// that closes the block: it drives the *registered* handler, and buys determinism back by
	// wrapping `mergeAnnounceSnapshot` on the instance to capture and await the detached promise.
	//
	// The **fetch** path is the block's other half and shares every fixture: `fetchAndMergeSnapshot`
	// builds the same `makeSnapshotParser(mergeSnapshotCaps())` and hands it to `fetchNeighbors` as
	// `opts.parse`. It is driven through a stub reply stream (`fetchMerged`) rather than through
	// `fetchNeighbors` directly, because that sender's `parse` *defaults* to `Infinity` caps — a
	// test that called it would prove nothing about the caps the service supplies.
	// -----------------------------------------------------------------------------------------
	describe('snapshot merge caps', () => {
		interface Caps { successors: number; predecessors: number; sample: number }
		interface DrivableMerge {
			mergeAnnounceSnapshot(from: string, snap: NeighborSnapshotV1): Promise<void>
			mergeSnapshotCaps(): Caps
		}
		/** Only the one method the counter replaces — this spec never imports `DigitreeStore`. */
		interface CountableStore { upsert(id: string, coord: Uint8Array): unknown }

		/** `from` plus three lists of distinct, parseable ids (seeds stay under 256 to stay distinct). */
		const FROM = peerIdStr(60)
		const OVER_SUCC = Array.from({ length: 40 }, (_, i) => peerIdStr(61 + i))
		const OVER_PRED = Array.from({ length: 40 }, (_, i) => peerIdStr(101 + i))
		const OVER_SAMPLE = Array.from({ length: 20 }, (_, i) => ({ id: peerIdStr(141 + i), coord: sampleCoord(i + 1), relevance: 0.5 }))

		/** The raw announce body: every list far past any profile's cap. */
		function overCapBody(): Record<string, unknown> {
			return { v: 1, from: FROM, timestamp: Date.now(), successors: OVER_SUCC, predecessors: OVER_PRED, sample: OVER_SAMPLE, sig: '' }
		}

		/**
		 * Two usable sample ids for the per-entry tests below. Parseable, because the merge loops
		 * re-hash a sample entry's coordinate from its *id* rather than trusting `coord` — a
		 * synthetic non-peer-id string is dropped by that re-hash before any of the rules these
		 * tests are about can be observed.
		 */
		const GOOD_1 = peerIdStr(181)
		const GOOD_2 = peerIdStr(182)

		/** A three-entry sample whose middle coord decodes to 16 bytes instead of 32. */
		function shortCoordSample(): Array<Record<string, unknown>> {
			return [
				{ id: GOOD_1, coord: sampleCoord(4), relevance: 0.5 },
				{ id: 'short-coord', coord: wrongWidthCoord(16), relevance: 0.5 },
				{ id: GOOD_2, coord: sampleCoord(5), relevance: 0.5 },
			]
		}

		const merge = (s: CoreFretService, from: string, snap: NeighborSnapshotV1): Promise<void> =>
			(s as unknown as DrivableMerge).mergeAnnounceSnapshot(from, snap)
		const capsOf = (s: CoreFretService): Caps => (s as unknown as DrivableMerge).mergeSnapshotCaps()

		/**
		 * Run a raw announce body through the *same* parser the service wires in at registration —
		 * `makeSnapshotParser(mergeSnapshotCaps())`, built from the service's own caps rather than
		 * from literals — so these tests drive the parser + merge pair production drives, and a
		 * rejection fails loudly here instead of surfacing as a mystery zero count.
		 */
		function parsed(s: CoreFretService, body: Record<string, unknown>): NeighborSnapshotV1 {
			const out = makeSnapshotParser(capsOf(s))(body)
			expect(out, 'an over-long message is truncated, not rejected').to.not.equal(undefined)
			return out!
		}

		/**
		 * Record every id the merge loop upserts, in order.
		 *
		 * `applyTouch` opens with `getById(id) ?? upsert(id, coord)` and the loop has always just
		 * upserted that id, so it does not double-count — a doubled count is the first assumption
		 * to re-check if these numbers ever drift.
		 *
		 * NOTE: this **stacks** wrappers rather than replacing them, and nothing restores. A second
		 * call wraps the first, so a counter installed earlier keeps recording while a later one is
		 * live. Harmless while a test installs one counter (every test below but one), but a test
		 * that drives both merge paths must copy its first array out (`[...ids]`) before installing
		 * the second counter — see the `relevance: null` test. Left stacking deliberately: a
		 * restore handle would change all eight call sites for the benefit of one, and each test
		 * gets a fresh service from `beforeEach` so nothing leaks between them. Revisit if a second
		 * test needs two counters, or if any test ever reuses a service.
		 */
		function countUpserts(s: CoreFretService): string[] {
			const store = s.getStore()
			const holder = store as unknown as CountableStore
			const inner = holder.upsert.bind(store)
			const ids: string[] = []
			holder.upsert = (id: string, coord: Uint8Array): unknown => { ids.push(id); return inner(id, coord) }
			return ids
		}

		/**
		 * A stub stream serving exactly one framed reply.
		 *
		 * The fetch is the simplest of the five senders: `fetchNeighbors` passes no body and does
		 * not half-close, so `rpcRequest` runs open → read → release and `sendFramed` is never
		 * called. Only the async iterator and a resolving `close` are load-bearing — `send` exists
		 * to satisfy the `Stream` type, and `abort` is reached only if that close rejects.
		 */
		function replyStream(body: Record<string, unknown>): Stream {
			const chunks = [json(body)]
			let i = 0
			return {
				id: 'fetch-reply-stub',
				send: (): boolean => true,
				close: async (): Promise<void> => { /* released */ },
				abort: (): void => { /* released */ },
				[Symbol.asyncIterator]: () => ({
					next: async (): Promise<IteratorResult<Uint8Array>> => {
						const c = chunks[i++]
						return c === undefined ? { done: true, value: undefined } : { done: false, value: c }
					},
				}),
			} as unknown as Stream
		}

		/** The private fetch-path entry point — `async`, and it awaits its own merges. */
		interface DrivableFetch {
			fetchAndMergeSnapshot(id: string, signal: AbortSignal | undefined): Promise<string[]>
		}

		/**
		 * Drive one raw snapshot body through the *fetch* path; report the ids it upserted and
		 * the ids it reports as newly seen.
		 *
		 * `openRpcStream` picks an open connection out of `node.getConnections(pid)`, and the
		 * fetch dials `'never'` — so with no connection the whole call is `skipped` and upserts
		 * nothing, a zero count indistinguishable from a cap doing its job. Overriding
		 * `getConnections` on the block's real node is what makes the test prove anything; it is
		 * restored afterwards so teardown still sees the node's own connections. A bare
		 * `{status, newStream}` is not a limited connection (`isLimitedConnection` reads `limits`
		 * then `remoteAddr`), so it is the chosen one.
		 */
		async function fetchMerged(
			node: Libp2p,
			svc: CoreFretService,
			body: Record<string, unknown>
		): Promise<{ ids: string[]; announced: string[] }> {
			const stream = replyStream(body)
			const holder = node as unknown as { getConnections: (p?: PeerId) => Connection[] }
			const real = holder.getConnections.bind(node)
			holder.getConnections = () => [{ status: 'open', newStream: async () => stream }] as unknown as Connection[]
			const ids = countUpserts(svc)
			try {
				const announced = await (svc as unknown as DrivableFetch).fetchAndMergeSnapshot(FROM, undefined)
				return { ids, announced }
			} finally {
				holder.getConnections = real
			}
		}

		// Pinned literally rather than read back out of `mergeSnapshotCaps()`, so the expectation
		// is not derived from the thing under test.
		const profiles: Array<{ profile: 'core' | 'edge'; caps: Caps }> = [
			{ profile: 'core', caps: { successors: 16, predecessors: 16, sample: 8 } },
			{ profile: 'edge', caps: { successors: 8, predecessors: 8, sample: 6 } },
		]

		// Every count below is `1 + successors + predecessors + sample`, one upsert per list entry.
		// That arithmetic holds only while the four id sets are disjoint — a collision would merge
		// as one id and quietly shift every expectation. Pinned here rather than left to the seed
		// ranges above, which are easy to widen into an overlap.
		it('the fixture ids are distinct, which is what the merge-count arithmetic assumes', () => {
			const all = [FROM, ...OVER_SUCC, ...OVER_PRED, ...OVER_SAMPLE.map((e) => e.id)]
			expect(new Set(all).size, 'no id appears in two of the lists').to.equal(all.length)
		})

		for (const { profile, caps: expected } of profiles) {
			describe(profile, () => {
				let node: Libp2p
				let svc: CoreFretService

				beforeEach(async () => {
					node = await createMemNode()
					await node.start()
					// Deliberately left unstarted: no stabilization loops, no handlers registered
					// unless a test asks for them (only the wiring test does, by calling
					// `registerRpcHandlers` directly), and the merge's own detached tail is quiet — `announceToNewPeers` filters
					// targets by `hasAddresses` (empty on an unstarted service, so it dials
					// nothing) and `enforceCapacity` early-returns far below the 2048 capacity.
					svc = new CoreFretService(node, { profile, networkName: NETWORK })
				})

				afterEach(async () => { await stopAll([node]) })

				// `mergeSnapshotCaps()` is deep-equalled against these same literals by
				// `test/announce-rate-limit.spec.ts`, which owns the caps-are-one-source-of-truth
				// claim; re-asserting it here would be a second copy of the numbers to keep in
				// sync. The counts below still fail loudly if the caps drift.
				it('merges exactly 1 + successors + predecessors + sample ids, however long the lists', async () => {
					const ids = countUpserts(svc)

					await merge(svc, FROM, parsed(svc, overCapBody()))

					expect(ids.length, 'one upsert for `from`, then one per capped id').to.equal(
						1 + expected.successors + expected.predecessors + expected.sample
					)
					expect(ids, 'the first N of each list, in merge order').to.deep.equal([
						FROM,
						...OVER_SUCC.slice(0, expected.successors),
						...OVER_PRED.slice(0, expected.predecessors),
						...OVER_SAMPLE.slice(0, expected.sample).map((e) => e.id),
					])
				})

				it('never stores an id past the cap', async () => {
					await merge(svc, FROM, parsed(svc, overCapBody()))
					const store = svc.getStore()

					for (const id of OVER_SUCC.slice(expected.successors)) expect(store.getById(id), `successor past the cap: ${id}`).to.equal(undefined)
					for (const id of OVER_PRED.slice(expected.predecessors)) expect(store.getById(id), `predecessor past the cap: ${id}`).to.equal(undefined)
					for (const e of OVER_SAMPLE.slice(expected.sample)) expect(store.getById(e.id), `sample entry past the cap: ${e.id}`).to.equal(undefined)

					// ...and the last *admitted* id of each list is present, so the absences above
					// are the cap doing its job rather than nothing having been stored at all.
					expect(store.getById(OVER_SUCC[expected.successors - 1]!), 'last admitted successor').to.not.equal(undefined)
					expect(store.getById(OVER_PRED[expected.predecessors - 1]!), 'last admitted predecessor').to.not.equal(undefined)
					expect(store.getById(OVER_SAMPLE[expected.sample - 1]!.id), 'last admitted sample entry').to.not.equal(undefined)
				})

				it('leaves the cap entirely to the parser — a bypassed body is merged whole', async () => {
					// The other side of the single-enforcement-point claim. The merge loop no
					// longer slices, so handing it a raw over-cap body merges every id: proof that
					// the truncation the tests above observe came from the parser and from nowhere
					// else. Not a reachable production path — nothing calls the merge without the
					// parser in front of it — so this is a claim about *where* the cap lives, not
					// a tolerated hole.
					const raw = overCapBody()
					const ids = countUpserts(svc)

					await merge(svc, FROM, raw as unknown as NeighborSnapshotV1)

					expect(ids.length, 'every id, uncapped, once the parser is out of the way').to.equal(
						1 + OVER_SUCC.length + OVER_PRED.length + OVER_SAMPLE.length
					)
					expect(ids.length, 'and that is strictly more than the parsed route merges').to.be.greaterThan(
						1 + expected.successors + expected.predecessors + expected.sample
					)
				})

				it('drops a sample entry whose relevance is not a finite number', () => {
					// `parseSample` is stricter than the merge loops it replaces: the loops read
					// only `id` and `coord`, so a peer whose relevance encodes as `null` (a `NaN`
					// at the sender) used to merge fine. Keeping the strictness is a decision —
					// the wire type declares `relevance: number` as required, so `null` is
					// malformed — and this pins it on the path both merges now share.
					const out = parsed(svc, {
						v: 1, from: FROM, timestamp: Date.now(), successors: [], predecessors: [], sig: '',
						sample: [
							{ id: GOOD_1, coord: sampleCoord(6), relevance: 0.5 },
							{ id: 'null-relevance', coord: sampleCoord(7), relevance: null },
							{ id: GOOD_2, coord: sampleCoord(8), relevance: 0 },
						],
					})

					expect(out.sample?.map((e) => e.id), 'the unusable entry is gone; a relevance of 0 is fine').to.deep.equal([GOOD_1, GOOD_2])
				})

				it('drops a wrong-width sample coord at the parser, so it never reaches onAnnounce', () => {
					const out = parsed(svc, {
						v: 1, from: FROM, timestamp: Date.now(), successors: [], predecessors: [], sig: '',
						sample: shortCoordSample(),
					})

					expect(out.sample, 'the unusable entry is gone; the good ones survive, in order').to.deep.equal([
						{ id: GOOD_1, coord: sampleCoord(4), relevance: 0.5 },
						{ id: GOOD_2, coord: sampleCoord(5), relevance: 0.5 },
					])
				})

				it('re-hashes a sample coordinate from the id, so a bypassed wrong-width coord is merged and ignored', async () => {
					// The coord-width rule is the *parser's* alone. The merge loop never reads
					// `s.coord` — a ring coordinate is derivable from the id, so trusting the wire
					// field would let an authenticated sender place another peer's id anywhere on
					// the ring. Bypassing the parser therefore merges the short-coord entry like
					// any other, at the coordinate its id hashes to.
					const shortId = peerIdStr(183)
					const snap = {
						v: 1, from: FROM, timestamp: Date.now(), sig: '',
						successors: [], predecessors: [],
						sample: [{ id: shortId, coord: wrongWidthCoord(16), relevance: 0.5 }],
					}

					await merge(svc, FROM, snap as unknown as NeighborSnapshotV1)

					const stored = svc.getStore().getById(shortId)
					expect(stored, 'the entry merged; the coordinate was never read').to.not.equal(undefined)
					expect(stored!.coord, 're-hashed from the id, not decoded from the wire').to.deep.equal(
						await hashPeerId(peerIdFromString(shortId))
					)
				})

				it('skips a sample entry whose id will not parse, without costing the message its other ids', async () => {
					// The arm the merge loop's own per-entry try/catch exists for now that the
					// coordinate is re-hashed: `peerIdFromString` throws on an id that is not one,
					// and that entry must drop without costing the message its remaining ids or
					// failing the merge.
					const snap = {
						v: 1, from: FROM, timestamp: Date.now(), sig: '',
						successors: [OVER_SUCC[0]!], predecessors: [OVER_PRED[0]!],
						sample: [
							{ id: GOOD_1, coord: sampleCoord(4), relevance: 0.5 },
							{ id: 'not-a-peer-id', coord: sampleCoord(5), relevance: 0.5 },
							{ id: GOOD_2, coord: sampleCoord(6), relevance: 0.5 },
						],
					}
					const ids = countUpserts(svc)

					await merge(svc, FROM, snap as unknown as NeighborSnapshotV1)

					expect(ids, 'only the unusable entry is skipped').to.deep.equal([FROM, OVER_SUCC[0]!, OVER_PRED[0]!, GOOD_1, GOOD_2])
					expect(svc.getStore().getById('not-a-peer-id'), 'never reached the store write seam').to.equal(undefined)
				})

				it('applies the cap through the handler the service actually registers', async () => {
					// The wiring test, and the only one in this block that is one. Every test above
					// applies `makeSnapshotParser(...)` from the test body, which restates
					// `registerRpcHandlers`' 8th argument rather than proving it — unwire the parser at
					// the registration site and all of them still pass. This one registers the real
					// handlers on a node that records instead of registering, invokes the announce
					// protocol with a raw over-cap frame, and counts the same upserts, so the truncation
					// it observes can only have come from the parser the service wired in.
					const handlers = new Map<string, InboundHandler>()
					;(node as unknown as { handle: (p: string, h: InboundHandler) => Promise<void> }).handle =
						async (protocol, h) => { handlers.set(protocol, h) }
					// Private, and it registers all five protocols. Called directly rather than via
					// `start()`: stabilization and the peerStore seed drag their own upserts into the
					// counter, and this test is about one message's cost.
					await (svc as unknown as { registerRpcHandlers(): Promise<void> }).registerRpcHandlers()

					// The announce handler's `onInbound` hook runs `noteInboundRpc(from)`, which also
					// upserts `from` — detached, racing the merge's own first upsert. It is guarded by
					// `if (!getById(id))`, so seeding `from` first makes it a no-op and the count
					// deterministic. Seeded before the counter is installed so the seed is not itself
					// counted; the merge's own unconditional `upsert(from, ...)` still is.
					svc.getStore().upsert(FROM, new Uint8Array(32).fill(60))

					// `handleAnnounce` detaches the merge, so an upsert count taken around the handler
					// call is not deterministic. Wrap the method on the instance to capture and await
					// the promise it returns; the snapshot still arrives through the real parser, so
					// nothing on the path under test is replaced.
					const merges: Array<Promise<void>> = []
					const drivable = svc as unknown as DrivableMerge
					const innerMerge = drivable.mergeAnnounceSnapshot.bind(svc)
					drivable.mergeAnnounceSnapshot = (from: string, snap: NeighborSnapshotV1): Promise<void> => {
						const p = innerMerge(from, snap)
						merges.push(p)
						return p
					}

					const ids = countUpserts(svc)
					const handler = handlers.get(P.PROTOCOL_NEIGHBORS_ANNOUNCE)
					expect(handler, 'the service registered an announce handler').to.not.equal(undefined)

					// The transport-authenticated remote must equal the body's `from`: the handler drops
					// a mismatch without replying, and the merge would then never run — a silent zero
					// count rather than a visible failure.
					const s = inboundStub([json(overCapBody())])
					await handler!(s.stream, { remotePeer: { toString: () => FROM } } as unknown as Connection)

					expect(merges.length, 'the announce reached the merge at all').to.equal(1)
					await Promise.all(merges)

					expect(ids.length, 'truncated by the parser the service wired in, not by this test').to.equal(
						1 + expected.successors + expected.predecessors + expected.sample
					)
					expect(ids, 'the first N of each list, in merge order').to.deep.equal([
						FROM,
						...OVER_SUCC.slice(0, expected.successors),
						...OVER_PRED.slice(0, expected.predecessors),
						...OVER_SAMPLE.slice(0, expected.sample).map((e) => e.id),
					])

					// ...and nothing past the cap reached the store, so the count above is the cap
					// doing its job rather than the merge having stopped early for some other reason.
					const store = svc.getStore()
					for (const id of OVER_SUCC.slice(expected.successors)) expect(store.getById(id), `successor past the cap: ${id}`).to.equal(undefined)
					for (const id of OVER_PRED.slice(expected.predecessors)) expect(store.getById(id), `predecessor past the cap: ${id}`).to.equal(undefined)
					for (const e of OVER_SAMPLE.slice(expected.sample)) expect(store.getById(e.id), `sample entry past the cap: ${e.id}`).to.equal(undefined)
				})

				it('applies the same caps on the fetch path, and never upserts the snapshot sender', async () => {
					// The fetch path's own cap test — until now its truncation rested on reading
					// the code. Two differences from the announce path above, both load-bearing:
					//
					//   - `fetchAndMergeSnapshot` never upserts `snap.from`, so the expected list
					//     is `successors + predecessors + sample` with no leading `FROM`.
					//   - a body the parser refuses comes back as `decode-error`, which returns
					//     early having upserted nothing. So this deep-equals the full expected id
					//     list rather than asserting `<= cap` — under which a fixture rejected for
					//     some unrelated reason would pass as a cap doing its job.
					const expectedIds = [
						...OVER_SUCC.slice(0, expected.successors),
						...OVER_PRED.slice(0, expected.predecessors),
						...OVER_SAMPLE.slice(0, expected.sample).map((e) => e.id),
					]

					const { ids, announced } = await fetchMerged(node, svc, overCapBody())

					expect(ids, 'the first N of each list, in merge order').to.deep.equal(expectedIds)
					expect(ids, 'the fetch path never upserts the sender').to.not.include(FROM)
					// Every merged id was new to this empty store, so the method's own return
					// value is a second reading of the same truncation.
					expect(announced, 'every merged id was new to this store').to.deep.equal(expectedIds)

					// ...and the store agrees, so the list above is the cap doing its job rather
					// than the merge having stopped early for some other reason.
					const store = svc.getStore()
					expect(store.getById(OVER_SUCC[expected.successors - 1]!), 'last admitted successor').to.not.equal(undefined)
					expect(store.getById(OVER_SUCC[expected.successors]!), 'first successor past the cap').to.equal(undefined)
					expect(store.getById(OVER_PRED[expected.predecessors]!), 'first predecessor past the cap').to.equal(undefined)
					expect(store.getById(OVER_SAMPLE[expected.sample]!.id), 'first sample entry past the cap').to.equal(undefined)
					expect(store.getById(FROM), 'the sender itself was never stored').to.equal(undefined)
				})

				it('drops a `relevance: null` sample entry on both merge paths', async () => {
					// The parser test above pins the drop at the parser; this pins that both merge
					// paths inherit it — which is what makes "the parser is the single enforcement
					// point" a claim about the whole system rather than about one function. The
					// strictness is a decision, not an accident: the wire type declares
					// `relevance: number` as required, so `null` is malformed.
					const body = {
						v: 1, from: FROM, timestamp: Date.now(), successors: [], predecessors: [], sig: '',
						sample: [
							{ id: GOOD_1, coord: sampleCoord(6), relevance: 0.5 },
							{ id: 'null-relevance', coord: sampleCoord(7), relevance: null },
							{ id: GOOD_2, coord: sampleCoord(8), relevance: 0 },
						],
					}

					const counted = countUpserts(svc)
					await merge(svc, FROM, parsed(svc, body))
					// Copied out before the fetch below: `countUpserts` stacks wrappers rather
					// than replacing them, so a counter installed earlier keeps recording while a
					// later one is live.
					const announceIds = [...counted]
					expect(announceIds, 'announce: the sender, then the two usable entries').to.deep.equal([FROM, GOOD_1, GOOD_2])

					const { ids: fetchIds } = await fetchMerged(node, svc, body)
					expect(fetchIds, 'fetch: the two usable entries, and no sender').to.deep.equal([GOOD_1, GOOD_2])

					expect(svc.getStore().getById('null-relevance'), 'reached the store on neither path').to.equal(undefined)
				})
			})
		}
	})

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
