import { after, before, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService } from '../src/service/fret-service.js'
import { makeProtocols, registerRpcHandler } from '../src/rpc/protocols.js'
import { sendPing } from '../src/rpc/ping.js'
import { sendLeave } from '../src/rpc/leave.js'
import { hashPeerId } from '../src/ring/hash.js'
import type { DigitreeStore } from '../src/store/digitree-store.js'
import { backoffOf } from './helpers/backoff.js'

// Every site in `FretService` that observes an outbound RPC outcome must treat a **local** stream
// limit the same way: bump `diag.streamLimit`, score nothing. `countStreamLimit` is the single
// owner of that rule, but owning it is not the same as reaching it — a site added or edited later
// can route a `local-limit` into `noteRpcFailure`'s scoring arms instead, and three of those mark a
// healthy peer `dead`.
//
// `test/rpc.stream-caps-local-limit-scoring.spec.ts` pins exactly one of the arms (`noteRpcFailure`
// itself, through two probe passes). This spec is the table over **all** of them, so an eighth arm
// later means adding a row rather than copying a test.
//
// Every row forces a *real* refusal at that arm's own call site — libp2p raising
// `TooManyOutboundProtocolStreamsError` out of our own `newStream` — rather than handing a site a
// hand-written `{ kind: 'local-limit' }` object. A synthetic outcome proves the switch arm; only a
// real refusal proves the arm is what a firing ceiling actually lands in.
//
// Rig (carried from the scoring spec, which carried it from `rpc.stream-caps-outbound.spec.ts`):
// libp2p reads the outbound cap off the **dialing** node's own registrar entry
// (`findOutgoingStreamLimit`, `libp2p/dist/src/connection.js`) and `newStream` counts the stream it
// is opening before comparing, so registering a protocol locally at `maxOutboundStreams: 0` refuses
// the first outbound stream with no concurrency needed. The registered handler is never entered; it
// exists purely to declare the cap. The local service is deliberately **not** started, which is
// both why no stabilization loop perturbs the diagnostics and why all five protocols are free for
// this spec to register at a cap of 0.
//
// The caps are installed **per protocol**, and the control block below runs before any of them:
// a row that caps the wrong protocol passes vacuously, because the call simply succeeds.

const NETWORK = 'stream-caps-local-limit-arms-test'
const P = makeProtocols(NETWORK)

/**
 * More refusals per row than `deadAfterFailures` (3), so a row that booked them as contact strikes
 * would provably have reached `dead` rather than merely have moved a counter.
 */
const REFUSALS = 4

type Diagnostics = ReturnType<FretService['getDiagnostics']>

/**
 * One outcome-observing arm. `drive()` performs the arm's own call once against the live peer, so
 * it is a control before the cap is installed and a refusal after it — the same code path either
 * way, which is what makes the control meaningful.
 */
interface Arm {
	/** what the row covers, and where that site is */
	readonly name: string
	/** the protocol this arm dials — capping the wrong one makes the row vacuous */
	readonly protocol: string
	/** exactly one outbound request, hence exactly one refusal once capped */
	drive(): Promise<void>
	/** extra proof, on the uncapped pass only, that the call really reached the peer */
	proveControl?(before: Diagnostics, after: Diagnostics): void
}

describe('local stream-cap refusals at every outcome-observing arm', function () {
	this.timeout(30000)

	let remote: Libp2p
	let remoteSvc: FretService
	let local: Libp2p
	let svc: FretService
	let store: DigitreeStore
	let peerId: string
	let key: Uint8Array

	// The private surfaces each arm is driven through. Reached by cast rather than made public:
	// these are internal passes, and the alternative — widening the public interface for a test —
	// would change the shipped surface in order to observe it.
	const priv = () => svc as unknown as {
		probeNeighborLatency(id: string, signal: AbortSignal | undefined): Promise<boolean>
		probeMembership(id: string, signal: AbortSignal | undefined): Promise<void>
		pingWarmupTargets(ids: readonly string[], label: string, budget?: number): Promise<void>
		sendAnnouncementsRateLimited(ids: string[], snap: unknown): Promise<void>
		noteRpcFailure(id: string, outcome: unknown): Promise<void>
		noteWriteOnlyOutcome(id: string, outcome: unknown, what: string): void
		cfg: { deadAfterFailures: number }
	}

	/** The smallest snapshot the announce sender will put on the wire; content is irrelevant here. */
	const snapshot = () => ({
		v: 1,
		from: local.peerId.toString(),
		timestamp: Date.now(),
		successors: [] as string[],
		predecessors: [] as string[],
		sig: '',
	})

	const leaveNotice = () => ({ v: 1, from: local.peerId.toString(), timestamp: Date.now() }) as const

	const arms: readonly Arm[] = [
		{
			// Arm 1, through the near-neighbor verification pass. Re-covered here for uniformity —
			// `rpc.stream-caps-local-limit-scoring.spec.ts` owns the deep version of this row.
			name: "noteRpcFailure case 'local-limit', via probeNeighborLatency (fret-service.ts ~882)",
			protocol: P.PROTOCOL_PING,
			drive: async () => { await priv().probeNeighborLatency(peerId, undefined) },
			proveControl: (b, a) => expect(a.pingsOk - b.pingsOk, 'a real ping round trip').to.equal(1),
		},
		{
			// Arm 1 again, through the off-ring pass — the one whose sibling failure arms *do*
			// record backoff, so the no-backoff assertion below is a fact about `local-limit`
			// rather than about a pass that never backs off.
			name: 'noteRpcFailure, via probeMembership (the off-ring classify / re-probe pass)',
			protocol: P.PROTOCOL_PING,
			drive: async () => { await priv().probeMembership(peerId, undefined) },
		},
		{
			// The five sites that route a `local-limit` *into* `noteRpcFailure` rather than
			// counting for themselves — fret-service.ts 2472/2477, 2695/2698, 2754/2757,
			// 3067/3071 and the activity-resend arm at 3436. They inherit arm 1 today, so this row
			// pins the seam they inherit: a real refused outcome handed to `noteRpcFailure` counts
			// and scores nothing. A future edit giving one of them its own `switch` arm is caught
			// by an existing row rather than by nobody.
			name: 'the shared noteRpcFailure seam the five inheriting sites route into',
			protocol: P.PROTOCOL_PING,
			drive: async () => {
				const out = await sendPing(local, peerId, P.PROTOCOL_PING, { timeoutMs: 2000 })
				await priv().noteRpcFailure(peerId, out)
			},
		},
		{
			// Arm 2. Both warm-up passes (the one-shot at start(), the active-mode tick) share this
			// fan-out, so one row covers both.
			name: 'the warm-up ping fan-out, pingWarmupTargets (fret-service.ts ~1699)',
			protocol: P.PROTOCOL_PING,
			drive: async () => { await priv().pingWarmupTargets([peerId], 'local-limit-arms') },
			proveControl: (b, a) => expect(a.pingsSent - b.pingsSent, 'a ping completed').to.equal(1),
		},
		{
			// Arm 3. `maxAttempts: 1` makes the count deterministic: the walk gets exactly one
			// probe, so one drive is one refusal whatever the `visited` bookkeeping does with the
			// target afterwards.
			name: 'the iterative lookup probe arm (fret-service.ts ~3347)',
			protocol: P.PROTOCOL_MAYBE_ACT,
			drive: async () => {
				for await (const _ev of svc.iterativeLookup(key, { wantK: 4, minSigs: 1, maxAttempts: 1 })) {
					// drained for effect; the progress events themselves are another spec's subject
				}
			},
		},
		{
			// Arm 4, through the announce choke point — the *real* loop, including its
			// `isDoomedDial` skip and its token bucket, either of which would silently swallow the
			// send and leave the count at zero. `announcementsSkipped` is asserted on the control
			// pass so an empty bucket reads as an empty bucket rather than as a missing count.
			name: 'noteWriteOnlyOutcome, via the announce choke point (fret-service.ts ~1616)',
			protocol: P.PROTOCOL_NEIGHBORS_ANNOUNCE,
			drive: async () => { await priv().sendAnnouncementsRateLimited([peerId], snapshot()) },
			proveControl: (b, a) => {
				expect(a.announcementsSent - b.announcementsSent, 'the announce reached the transport').to.equal(1)
				expect(a.announcementsSkipped - b.announcementsSkipped, 'the bucket had a token').to.equal(0)
			},
		},
		{
			// Arm 4's two leave callers (fret-service.ts 1863 and 1881). Both hand a real
			// `sendLeave` outcome to the same helper under different labels, so the rows differ
			// only in that label — which is the point: the helper, not the label, owns the rule.
			name: 'noteWriteOnlyOutcome, via a leave notice (fret-service.ts ~1863)',
			protocol: P.PROTOCOL_LEAVE,
			drive: async () => {
				const out = await sendLeave(local, peerId, leaveNotice(), P.PROTOCOL_LEAVE, { timeoutMs: 2000 })
				priv().noteWriteOnlyOutcome(peerId, out, 'sendLeave')
			},
		},
		{
			name: 'noteWriteOnlyOutcome, via the leave fan-out beyond S/P (fret-service.ts ~1881)',
			protocol: P.PROTOCOL_LEAVE,
			drive: async () => {
				const out = await sendLeave(local, peerId, leaveNotice(), P.PROTOCOL_LEAVE, { timeoutMs: 2000 })
				priv().noteWriteOnlyOutcome(peerId, out, 'sendLeave fan-out')
			},
		},
	]

	before(async () => {
		remote = await createMemNode()
		await remote.start()
		remoteSvc = new FretService(remote, { profile: 'core', networkName: NETWORK })
		await remoteSvc.start() // registers this network's handlers, so every control call is answered

		local = await createMemNode()
		await local.start()
		// Deliberately not started — see the header note.
		svc = new FretService(local, { profile: 'core', networkName: NETWORK })
		store = svc.getStore()

		// FRET dials by bare peer id, so the local node needs an address for the remote first.
		await local.dial(remote.getMultiaddrs()[0]!)
		peerId = remote.peerId.toString()
		const coord = await hashPeerId(remote.peerId)
		store.upsert(peerId, coord)
		store.setMembership(peerId, 'member')
		// The lookup row aims at the remote's own coordinate, so it is the candidate the walk picks.
		key = coord
	})

	after(async () => {
		try { await svc.stop() } catch { /* never started */ }
		await remoteSvc.stop()
		await stopAll([local, remote])
	})

	const entry = () => {
		const e = store.getById(peerId)
		expect(e, 'the peer is in the routing table').to.not.equal(undefined)
		return e!
	}

	/**
	 * Defeats the contact-failure spacing guard (`CONTACT_FAILURE_MIN_SPACING_MS`, 500 ms), which
	 * discards a strike landing within 500 ms of the last counted one. Without this, four refusals
	 * fired back to back would book at most **one** strike even on a broken implementation, so
	 * every "no strike" assertion below would pass against exactly the bug it exists to catch.
	 */
	const rewindSpacing = () => store.update(peerId, { lastContactFailureAt: 0 })

	// Every control runs before any cap is installed, so the two blocks cannot be reordered: a
	// control running after its protocol was capped would assert nothing.
	describe('control — the same call answers over the same connection, uncapped', () => {
		for (const arm of arms) {
			it(arm.name, async () => {
				const b = { ...svc.getDiagnostics() }
				await arm.drive()
				const a = svc.getDiagnostics()

				expect(a.streamLimit - b.streamLimit, 'no ceiling fired yet').to.equal(0)
				expect(entry().contactFailures, 'nothing to strike for').to.equal(0)
				expect(entry().state, 'alive').to.not.equal('dead')
				arm.proveControl?.(b, a)
				rewindSpacing()
			})
		}
	})

	describe('capped — a real refusal counts and scores nothing', () => {
		before(async () => {
			// One registration per distinct protocol the table names. The handler body is
			// unreachable: the local node is never dialed on these protocols, and the cap refuses
			// our own opens before negotiation.
			for (const protocol of new Set(arms.map((a) => a.protocol))) {
				await registerRpcHandler(local, protocol, async () => {
					throw new Error('the local node never serves its own capped protocols in this spec')
				}, { maxOutboundStreams: 0 })
			}
		})

		it('drives more refusals per arm than deadAfterFailures', () => {
			expect(REFUSALS, 'enough refusals to have killed the peer had they been counted')
				.to.be.greaterThan(priv().cfg.deadAfterFailures)
		})

		for (const arm of arms) {
			it(arm.name, async () => {
				const start = { ...entry() }
				const b = { ...svc.getDiagnostics() }

				for (let i = 0; i < REFUSALS; i++) {
					await arm.drive()
					rewindSpacing()
				}

				const now = entry()
				expect(now.contactFailures, 'no contact strike').to.equal(0)
				expect(now.state, 'never marked dead').to.not.equal('dead')
				expect(now.membership, 'membership label untouched').to.equal(start.membership)
				expect(now.relevance, 'relevance untouched').to.equal(start.relevance)
				expect(now.failureCount, 'no failure recorded').to.equal(start.failureCount)
				expect(now.successCount, 'no success recorded either').to.equal(start.successCount)
				expect(now.negotiateFailures, 'not membership evidence').to.equal(0)
				expect(backoffOf(svc).factor(peerId), 'no backoff — the next pass probes fresh').to.equal(0)

				const a = svc.getDiagnostics()
				// Exactly one per refusal, not merely non-zero: a shared-increment bug reads as
				// "went up" either way.
				expect(a.streamLimit - b.streamLimit, 'one count per refusal').to.equal(REFUSALS)
			})
		}
	})
})
