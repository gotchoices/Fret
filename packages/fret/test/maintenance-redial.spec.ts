import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import { createMemNode, createSlowHandshakeMemNode, stopAll } from './helpers/libp2p.js'
import { waitFor } from './helpers/wait-for.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import type { DigitreeStore } from '../src/store/digitree-store.js'
import type { FretConfig } from '../src/index.js'
import { backoffOf } from './helpers/backoff.js'

// Reported from sereus (`p2p-fret` 1.0.2): a strand member that restarted on a slow relayed link was
// never reconnected. Every maintenance ping ran under the 2 s `MAINTENANCE_RPC_TIMEOUT_MS`, and
// because `rpcRequest` always passes a signal — which switches libp2p's own whole-dial `dialTimeout`
// off — that 2 s was the *only* bound on the dial the ping had to make first. A relayed dial on that
// link takes ~9 s. So: ping times out → contact strike; three spaced strikes → `dead`; the dead arm
// re-probes with the same 2 s → never reconnects. Measured: 32 reconnect dials in 180 s, every one
// aborted at 2.05 s.
//
// The fix splits the budget by *where the dial runs*: a maintenance ping assumes an open connection
// (`dial: 'never'`), and opening one is a separate per-peer, deduplicated **redial** under the
// host-configurable `dialTimeoutMs`, run on the run signal so it outlives the tick that asked.
//
// The rig: A dials with a slow outbound handshake (`createSlowHandshakeMemNode`) — "slow dial, fast
// exchange", the shape of a relayed connection — and holds B as a live member with B's address in
// its peerStore and no connection. A is never started: ticks are driven by hand so the loop cannot
// race the assertions, and no `peer:connect` listener is attached, so every state change below is
// the tick's own doing. B is started so it serves this network's protocols.
//
// `HANDSHAKE_MS` sits above `STABILIZE_PHASE_ONE_BUDGET_MS` (3000) on purpose: the headline claim
// is that the dial *outlives the tick*, which a handshake that fits inside the phase cannot show.
// Before the fix the first case goes timeout → strike on every tick and `dead` on the third.

describe('maintenance redial: opening a connection has its own budget, outside the tick', function () {
	this.timeout(30000)

	const HANDSHAKE_MS = 4000
	const PHASE_ONE_BUDGET_MS = (CoreFretService as unknown as { STABILIZE_PHASE_ONE_BUDGET_MS: number }).STABILIZE_PHASE_ONE_BUDGET_MS

	let a: Libp2p
	let b: Libp2p
	let svcA: CoreFretService
	let svcB: CoreFretService
	let store: DigitreeStore
	let bId: string

	afterEach(async () => {
		for (const s of [svcA, svcB]) {
			try { await s?.stop() } catch { /* never started */ }
		}
		await stopAll([a, b].filter((n) => n != null))
	})

	/**
	 * A (slow outbound handshake) holding B as a live member with an address and no connection.
	 * The peerStore merge is what makes B dialable by bare id; the seed copies that into FRET's own
	 * dialability set and creates B's entry. Membership is set by hand — memory nodes run no
	 * `identify`, so nothing else would classify B before the first probe.
	 */
	async function build(handshakeMs: number, cfg: Partial<FretConfig> = {}): Promise<void> {
		a = await createSlowHandshakeMemNode(handshakeMs)
		b = await createMemNode()
		await a.start()
		await b.start()
		svcA = new CoreFretService(a, { profile: 'core', networkName: 'net-test', ...cfg })
		svcB = new CoreFretService(b, { profile: 'core', networkName: 'net-test' })
		await svcB.start()
		store = svcA.getStore()
		bId = b.peerId.toString()
		await a.peerStore.merge(b.peerId, { multiaddrs: b.getMultiaddrs() })
		await (svcA as any).seedFromPeerStore()
		store.setMembership(bId, 'member')
		expect(a.getConnections(b.peerId), 'premise: no connection to B').to.have.length(0)
		expect(((await (svcA as any).nearProbeTargets()) as { targets: string[] }).targets, 'premise: B is a near target').to.deep.equal([bId])
	}

	async function tick(): Promise<number> {
		const t0 = Date.now()
		await (svcA as any).stabilizeOnce()
		return Date.now() - t0
	}

	const diag = () => svcA.getDiagnostics()
	const entry = () => store.getById(bId)!
	const redial = (id: string = bId): Promise<string> => (svcA as any).redial(id)

	// ----- the reproduction -----

	it('a dial slower than the phase is not a strike: the tick returns, the dial carries on, the next tick pings', async () => {
		await build(HANDSHAKE_MS, { dialTimeoutMs: 10_000 })

		const elapsed = await tick()

		// The defect first: before the fix this tick's ping timed out at 2 s and that timeout was a
		// strike (mutation-checked — restoring a dialing ping fails here, on the strike).
		expect(entry().contactFailures, 'no strike while the redial is pending').to.equal(0)
		expect(entry().failureCount, 'no relevance decay either').to.equal(0)
		expect(diag().pingsFail + diag().pingsSent, 'no ping was sent: a ping never dials').to.equal(0)
		expect(diag().redials.started, 'exactly one dial was issued').to.equal(1)
		expect(diag().redials.failed, 'a dial still running is not a failure').to.equal(0)
		expect(entry().state).to.not.equal('dead')
		expect(entry().membership).to.equal('member')
		// The tick waited on the redial for the rest of its phase and no longer: it ended on the
		// phase-1 budget, before the handshake could have completed.
		expect(elapsed, 'the tick did not wait out the dial').to.be.lessThan(HANDSHAKE_MS)
		expect(elapsed, 'the tick waited for its phase rather than giving up at once').to.be.at.least(PHASE_ONE_BUDGET_MS - 200)

		// The redial outlives the tick and lands within its own budget.
		await waitFor(() => a.getConnections(b.peerId).length > 0, 8000, 25, 'the connection formed after the tick returned')
		await waitFor(() => diag().redials.connected === 1, 2000, 10, 'the redial booked its connected verdict')
		expect(diag().redials.failed).to.equal(0)
		expect(entry().contactFailures, 'success books nothing against the peer').to.equal(0)

		// Next tick: B is connected, so the near pass pings it over the connection it now has.
		await tick()

		expect(diag().pingsOk, 'the next tick verified B with a ping').to.equal(1)
		expect(diag().snapshotsFetched, 'and fetched its snapshot').to.equal(1)
		expect(diag().redials.started, 'no second dial — the connection exists').to.equal(1)
		expect(entry().contactFailures).to.equal(0)
		expect(entry().state).to.not.equal('dead')
		expect(entry().membership, 'still a live member throughout').to.equal('member')
	})

	// The fast path: a dial that completes inside the phase is pinged and fetched in the *same* tick,
	// so a direct-link neighbour still reconnects and verifies within one tick, as before.
	it('a dial that completes within the phase is pinged and fetched in the same tick', async () => {
		await build(300)

		const elapsed = await tick()

		expect(elapsed, 'no phase budget was waited out').to.be.lessThan(PHASE_ONE_BUDGET_MS)
		expect(diag().redials.connected).to.equal(1)
		expect(diag().pingsOk, 'pinged in the same tick').to.equal(1)
		expect(diag().snapshotsFetched, 'fetched in the same tick').to.equal(1)
		expect(entry().contactFailures).to.equal(0)
	})

	// ----- the control: a budget below the handshake -----

	it('a dial budget below the handshake fails the redial: one strike, no backoff from the near pass, within the tick', async () => {
		await build(HANDSHAKE_MS, { dialTimeoutMs: 1000 })

		const elapsed = await tick()

		// A fast-failing dial books its strike inside the tick rather than after it.
		expect(elapsed, 'the dial failed on its own budget, inside the phase').to.be.lessThan(PHASE_ONE_BUDGET_MS)
		expect(diag().redials.started).to.equal(1)
		expect(diag().redials.failed).to.equal(1)
		expect(entry().contactFailures, 'one strike for the failed redial').to.equal(1)
		expect(entry().failureCount, 'with the relevance decay a failed contact carries').to.equal(1)
		expect(entry().state, 'one strike is not a verdict').to.not.equal('dead')
		expect(entry().membership, 'a dial that never landed says nothing about network').to.equal('member')
		expect(backoffOf(svcA).factor(bId), 'the near pass records no backoff').to.equal(0)
		expect(a.getConnections(b.peerId), 'the aborted dial left no connection').to.have.length(0)
	})

	// The off-ring arm owes a backoff on every failure of its own, and a failed redial is one of
	// them — recorded by the arm, not inside the seam, because the near pass above records none.
	it('a failed redial from the dead arm also records backoff', async () => {
		await build(HANDSHAKE_MS, { dialTimeoutMs: 1000 })
		store.update(bId, { state: 'dead', contactFailures: 3, lastContactFailureAt: 0 })
		expect(((await (svcA as any).nearProbeTargets()) as { targets: string[] }).targets, 'dead: out of the near pass').to.deep.equal([])
		expect((svcA as any).reprobeExcludedTargets() as string[], 'and into the dead arm').to.deep.equal([bId])

		await tick()

		expect(diag().redials.failed).to.equal(1)
		expect(backoffOf(svcA).factor(bId), 'the dead arm backed it off').to.be.greaterThan(0)
		expect(entry().state, 'still dead').to.equal('dead')
	})

	// ----- one dial, one verdict -----

	it('two concurrent requests share one dial and book one strike', async () => {
		await build(HANDSHAKE_MS, { dialTimeoutMs: 1000 })

		const first = redial()
		const second = redial()

		expect(second, 'the in-flight promise itself, not a second dial').to.equal(first)
		expect(await first).to.equal('failed')
		expect(await second).to.equal('failed')
		expect(diag().redials.started, 'one dial').to.equal(1)
		expect(entry().contactFailures, 'one strike, not one per awaiter').to.equal(1)
		expect((svcA as any).redials.size, 'the entry removed itself on settling').to.equal(0)
	})

	it('skips — no dial, no score — when connected, when address-less, and when the cap is full', async () => {
		await build(300)
		const concurrency = (svcA as any).maintenanceConcurrency as number
		const redials = (svcA as any).redials as Map<string, Promise<string>>

		// Cap: `maintenanceConcurrency` redials already in flight.
		for (let i = 0; i < concurrency; i++) redials.set(`pending-${i}`, new Promise<string>(() => {}))
		expect(await redial(), 'cap full').to.equal('skipped')
		redials.clear()

		// No address libp2p could dial.
		;(svcA as any).setAddressKnown(bId, false)
		expect(await redial(), 'no address').to.equal('skipped')
		;(svcA as any).setAddressKnown(bId, true)

		// Already connected.
		await a.dial(b.peerId)
		expect(await redial(), 'already connected').to.equal('skipped')

		expect(diag().redials.started, 'none of the three issued a dial').to.equal(0)
		expect(entry().contactFailures, 'none of the three scored').to.equal(0)
	})

	// Our own cancellation is not evidence about the peer — at the one place maintenance dials, as
	// at every pooled RPC.
	it('a run cancelled mid-dial settles the redial cancelled and books nothing', async () => {
		await build(HANDSHAKE_MS, { dialTimeoutMs: 10_000 })
		const run = new AbortController()
		;(svcA as any).runAbort = run

		const verdict = redial()
		await new Promise((r) => setTimeout(r, 200))
		expect(diag().redials.started, 'the dial is in flight').to.equal(1)
		run.abort(new Error('service stopped'))

		expect(await verdict).to.equal('cancelled')
		expect(diag().redials.failed, 'not a failure').to.equal(0)
		expect(diag().redials.connected).to.equal(0)
		expect(entry().contactFailures, 'no strike').to.equal(0)
		expect(entry().failureCount, 'no relevance decay').to.equal(0)
		expect(a.getConnections(b.peerId), 'the dial really was aborted').to.have.length(0)
	})

	// ----- config -----

	it('rejects a dialTimeoutMs that is not a positive finite number', async () => {
		a = await createMemNode()
		for (const bad of [0, -1, NaN, Infinity]) {
			expect(() => new CoreFretService(a, { profile: 'core', dialTimeoutMs: bad }), `dialTimeoutMs: ${bad}`).to.throw(/dialTimeoutMs/)
		}
		expect((new CoreFretService(a, { profile: 'core' }) as any).cfg.dialTimeoutMs, 'the default is libp2p\'s own dialTimeout').to.equal(10_000)
	})
})
