import { after, afterEach, before, describe, it } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import { createMemNode, stopAll } from './helpers/libp2p.js'
import { FretService } from '../src/service/fret-service.js'
import { makeProtocols, registerRpcHandler } from '../src/rpc/protocols.js'
import { hashPeerId } from '../src/ring/hash.js'
import type { DigitreeStore } from '../src/store/digitree-store.js'

// What a **service** does with a `local-limit` outcome, driven by a real outbound stream-cap
// refusal rather than by a hand-written outcome object.
//
// `test/rpc.stream-caps-outbound.spec.ts` proves the wire behavior — libp2p raises
// `TooManyOutboundProtocolStreamsError` out of our own `newStream` and `classify()` reports it as
// `local-limit`. `test/dead-state.spec.ts` proves the scoring rule, but by handing
// `noteRpcFailure` a synthetic `{ kind: 'local-limit' }`: nothing joined the two, so a regression
// that made a real refusal surface as some *other* variant (`unreachable`, say) would leave both
// specs green while marking a perfectly healthy peer `dead` after three refusals. This spec closes
// that seam: a genuine cap firing, observed through a real maintenance pass, at the service.
//
// Two consequences are asserted, and they are the whole point of the variant existing:
//
//  - **No contact strike.** The ceiling is ours; it fired before anything reached the wire, so it
//    is evidence about this node and never about the peer.
//  - **`diag.streamLimit` increments.** A ceiling that fires must be visible rather than silent.
//
// Rigging. libp2p reads the outbound cap off the **dialing** node's own registrar entry for the
// protocol (`findOutgoingStreamLimit`, `libp2p/dist/src/connection.js`), and FRET's `openRpcStream`
// passes no `maxOutboundStreams` option — so the registrar is the only lever. In production the
// number comes from `FretService.streamCaps()` on the `start()` path (Core 256 outbound); here the
// local service is deliberately **not** started — the same choice `test/dead-state.spec.ts` makes,
// so the passes below are driven explicitly and no live stabilization loop probes on its own
// schedule — which leaves the ping protocol unregistered on the local node and lets this spec
// register it directly at a cap of 0. That handler is never entered by anything: it exists purely
// so the registrar has an outbound cap to read, exactly as the requester-side registration in the
// outbound spec does.
//
// A cap of **0** is what makes both arms drivable with no concurrency at all: `newStream` counts
// the stream it is opening before comparing (`streamCount > outgoingLimit`), so a cap of N admits
// exactly N and a cap of 0 refuses the very first outbound stream.
//
// One thing this rig cannot observe, and does not try to: the check at that call site runs *after*
// protocol negotiation, so a refused stream has already reached the remote and its handler may
// have been entered before the local abort. Only the sender-side outcome is reliable here.

const NETWORK = 'stream-caps-local-limit-test'
const PING = makeProtocols(NETWORK).PROTOCOL_PING

/**
 * More refusals than `deadAfterFailures` (3), so a regression that booked them as contact strikes
 * would provably have reached `dead` rather than merely have incremented a counter. Asserted
 * against the live config below rather than trusted as a constant.
 */
const REFUSALS = 4

describe('local stream-cap refusals at the service', function () {
	this.timeout(30000)

	let remote: Libp2p
	let remoteSvc: FretService
	let local: Libp2p
	let svc: FretService
	let store: DigitreeStore
	let peerId: string

	/** Registered once, lazily, so either case below stands up on its own under `.only`. */
	let capped = false

	async function capPingOutboundAtZero(): Promise<void> {
		if (capped) return
		capped = true
		await registerRpcHandler(local, PING, async () => {
			throw new Error('the local node never serves ping in this spec')
		}, { maxOutboundStreams: 0 })
	}

	before(async () => {
		remote = await createMemNode()
		await remote.start()
		remoteSvc = new FretService(remote, { profile: 'core', networkName: NETWORK })
		await remoteSvc.start() // registers this network's ping handler, so the control ping answers

		local = await createMemNode()
		await local.start()
		// Not started: every pass here is driven explicitly, and a running stabilization loop would
		// probe this peer on its own schedule and make the diagnostics non-deterministic.
		svc = new FretService(local, { profile: 'core', networkName: NETWORK })
		store = svc.getStore()

		// FRET dials by bare peer id, so the local node needs an address for the remote first.
		await local.dial(remote.getMultiaddrs()[0]!)
		peerId = remote.peerId.toString()
		store.upsert(peerId, await hashPeerId(remote.peerId))
		store.setMembership(peerId, 'member')
	})

	afterEach(async () => {
		// The spacing guard (`CONTACT_FAILURE_MIN_SPACING_MS`, 500 ms) discards a strike landing
		// within 500 ms of the last counted one. Rewinding the stamp between refusals defeats it
		// outright, which is what makes the no-strike assertion **non-vacuous**: fired back to back
		// with the guard in place, four refusals would book at most one strike even on a broken
		// implementation, so the assertion would pass against exactly the bug it exists to catch.
		// Rewinding is preferred over sleeping ≥ 500 ms apart (`test/dead-state.spec.ts` sets the
		// precedent): it defeats the guard completely rather than merely out-waiting it, and it does
		// not depend on wall-clock granularity on a loaded box.
		store.update(peerId, { lastContactFailureAt: 0 })
	})

	after(async () => {
		try { await svc.stop() } catch { /* never started */ }
		await remoteSvc.stop()
		await stopAll([local, remote])
	})

	/** The near-neighbor verification pass: one namespaced ping, one hop. */
	const nearProbe = async (): Promise<boolean> =>
		await (svc as unknown as { probeNeighborLatency(id: string, s: AbortSignal | undefined): Promise<boolean> })
			.probeNeighborLatency(peerId, undefined)

	/** The off-ring classification / re-probe pass: same ping, different bookkeeping. */
	const offRingProbe = async (): Promise<void> =>
		await (svc as unknown as { probeMembership(id: string, s: AbortSignal | undefined): Promise<void> })
			.probeMembership(peerId, undefined)

	const backoffFor = (id: string): unknown =>
		(svc as unknown as { backoffMap: { get(k: string): unknown } }).backoffMap.get(id)

	const entry = () => {
		const e = store.getById(peerId)
		expect(e, 'the peer is in the routing table').to.not.equal(undefined)
		return e!
	}

	// The control. Without it the two capped cases below would pass just as well against a rig
	// whose dial was simply broken — every outcome would be a failure of *some* kind, and only the
	// asserted variant would tell them apart. This proves the very same call answers over the very
	// same connection the moment before the ceiling is installed.
	it('answers the same ping over the same connection before the cap is installed', async () => {
		const answered = await nearProbe()

		expect(answered, 'the peer answered on our namespaced protocol').to.equal(true)
		expect(svc.getDiagnostics().pingsOk, 'a real ping round trip').to.equal(1)
		expect(svc.getDiagnostics().streamLimit, 'no ceiling fired yet').to.equal(0)
		expect(entry().membership, 'a completed namespaced RPC is membership proof').to.equal('member')
		expect(entry().contactFailures, 'nothing to strike for').to.equal(0)
	})

	// The headline arm. `noteRpcFailure` holds both consequences, so one driven pass proves both.
	it('books no contact strike and counts diag.streamLimit when our own outbound ceiling refuses a near probe', async () => {
		await capPingOutboundAtZero()

		const deadAfter = (svc as unknown as { cfg: { deadAfterFailures: number } }).cfg.deadAfterFailures
		expect(REFUSALS, 'enough refusals to have killed the peer had they been counted')
			.to.be.greaterThan(deadAfter)

		const start = { ...entry() }
		const d0 = { ...svc.getDiagnostics() }

		for (let i = 0; i < REFUSALS; i++) {
			const answered = await nearProbe()
			// A refusal raised locally is not an answer — the caller must skip the snapshot fetch it
			// could not have completed either.
			expect(answered, 'a refused open is not an answer').to.equal(false)
			store.update(peerId, { lastContactFailureAt: 0 }) // see the afterEach note on spacing
		}

		const now = entry()
		expect(now.contactFailures, 'no contact strike').to.equal(0)
		expect(now.state, 'never marked dead').to.not.equal('dead')
		expect(now.relevance, 'relevance untouched').to.equal(start.relevance)
		expect(now.failureCount, 'no failure recorded').to.equal(start.failureCount)
		expect(now.successCount, 'no success recorded either').to.equal(start.successCount)
		expect(now.negotiateFailures, 'not membership evidence').to.equal(0)
		expect(now.membership, 'label untouched').to.equal('member')
		expect(backoffFor(peerId), 'no backoff — next tick probes fresh').to.equal(undefined)

		const d = svc.getDiagnostics()
		expect(d.streamLimit - d0.streamLimit, 'one count per refusal').to.equal(REFUSALS)
		// A second, free observable: this arm increments *no* ping diagnostic at all, because no
		// ping was sent. Its `unreachable` / `timeout` siblings do count `pingsFail`, so this is the
		// honest place to prove "would have been scored, wasn't".
		expect(d.pingsSent - d0.pingsSent, 'no ping was sent').to.equal(0)
		expect(d.pingsFail - d0.pingsFail, 'and none failed').to.equal(0)
	})

	// The same refusal through the off-ring pass, which is where the no-backoff arm is worth
	// something: `probeMembership`'s `foreign-protocol` / `unreachable` / `timeout` arms strike
	// **and** record backoff, so an empty backoff map here is a fact about the `local-limit` arm
	// rather than about a pass that never backs off.
	it('records neither a strike nor backoff when the ceiling refuses an off-ring membership probe', async () => {
		await capPingOutboundAtZero()

		const start = { ...entry() }
		const d0 = { ...svc.getDiagnostics() }

		for (let i = 0; i < REFUSALS; i++) {
			await offRingProbe()
			store.update(peerId, { lastContactFailureAt: 0 })
		}

		const now = entry()
		expect(now.contactFailures, 'no contact strike').to.equal(0)
		expect(now.state, 'never marked dead').to.not.equal('dead')
		expect(now.negotiateFailures, 'not membership evidence').to.equal(0)
		expect(now.membership, 'label untouched').to.equal(start.membership)
		expect(backoffFor(peerId), 'no backoff on this arm, unlike the failure arms').to.equal(undefined)

		const d = svc.getDiagnostics()
		expect(d.streamLimit - d0.streamLimit, 'one count per refusal').to.equal(REFUSALS)
		expect(d.pingsFail - d0.pingsFail, 'no ping diagnostic').to.equal(0)
	})
})
