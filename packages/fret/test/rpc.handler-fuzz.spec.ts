import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import type { Connection, Stream } from '@libp2p/interface'
import { createMemNode, stopAll } from './helpers/libp2p.js'
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
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { decodeJson, encodeJson, readFramed, registerRpcHandler, sendFramed } from '../src/rpc/protocols.js'
import { registerMaybeAct } from '../src/rpc/maybe-act.js'
import { makeSnapshotParser, parseRouteAndMaybeAct } from '../src/rpc/validate.js'
import { registerLeave } from '../src/rpc/leave.js'
import { registerPing } from '../src/rpc/ping.js'
import { registerNeighbors } from '../src/rpc/neighbors.js'
import { hashKey } from '../src/ring/hash.js'
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
// Two tiers live here:
//   1. Unit — `registerRpcHandler`'s release accounting on stub streams: exactly one release
//      per stream, `close()` for completed replies and normal drops, `abort()` for errors,
//      nothing for a stream the remote already reset.
//   2. Service — `handleMaybeAct`'s structural validator: metered by the token bucket, rejects
//      statically, never caches, counts `diag.rejected.malformed`.
//
// The third tier — Wire, the malformed matrix over a real transport plus the batch-then-recover
// case over TCP + noise + yamux — is `rpc.handler-fuzz.wire.spec.ts`. The inbound snapshot-merge
// caps, a bound on accepted work rather than a stream-release rule, are
// `rpc.snapshot-merge-cap.spec.ts`. All three share the fixtures in `test/helpers/rpc-fuzz.ts`.
//
// Oversized payloads and rate-limit *enforcement* tiers belong to `7.5-rpc-codec-property-tests`.

const enc = new TextEncoder()

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
})
