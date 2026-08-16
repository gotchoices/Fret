import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { buildMaintenanceRig, type MaintenanceRig, type PeerRig } from './helpers/maintenance-rig.js'
import type { FretService as CoreFretService } from '../src/service/fret-service.js'

// The two connection warm-up passes — the one-shot `preconnectNeighbors` at `start()` and the
// per-second active-mode tick — now share one pooled fan-out (`pingWarmupTargets`), at the same
// `maintenanceConcurrency` cap the stabilization tick uses (Core 6 / Edge 2), against the **run
// signal** rather than a tick deadline. Serially they were exactly the "serial dial chain" the
// *Active vs passive state* section of `docs/fret.md` says active mode exists to avoid: up to 12
// pings one at a time, each able to spend the full 2 s `MAINTENANCE_RPC_TIMEOUT_MS`.
//
// These tests drive `preconnectNeighbors` because it is the wider of the two passes (up to 12
// targets vs the active tick's Core 6 / Edge 3) and its cancellation behaviour is already pinned in
// `dead-state.spec.ts`. Both passes funnel through the same helper, so what holds here holds for
// the active tick's body too.
//
// Harness (stub connections, per-peer hang control, in-flight high-water mark) is shared with
// `stabilize-concurrency.spec.ts` — see `helpers/maintenance-rig.ts`.

describe('connection warm-up: pooled pings at the maintenance concurrency cap', function () {
	this.timeout(15000)

	/** `FretService.MAINTENANCE_RPC_TIMEOUT_MS` — the per-ping budget, not overridden here. */
	const PING_TIMEOUT_MS = 2000

	let harness: MaintenanceRig
	let svc: CoreFretService
	let rig: PeerRig

	async function build(profile: 'core' | 'edge'): Promise<void> {
		harness = await buildMaintenanceRig(profile)
		;({ svc, rig } = harness)
	}

	beforeEach(async () => {
		await build('core')
	})

	afterEach(async () => {
		await harness.teardown()
	})

	/**
	 * `preconnectNeighbors` walks `min(6, m)` peers on each side of self, so exactly 12 seeded
	 * peers is the full pass — every seeded peer is a target, whatever its ring position, which is
	 * what lets a test choose which peers hang without re-deriving the walk order.
	 */
	const FULL_PASS = 12

	async function preconnect(): Promise<number> {
		const t0 = Date.now()
		await (svc as any).preconnectNeighbors()
		return Date.now() - t0
	}

	// The headline: three peers that never answer used to cost three *sequential* 2 s ping
	// timeouts — 6 s of start-up spent before the ninth reachable neighbor was warmed. Pooled at
	// Core's 6, all three hang side by side, so the pass costs one timeout and the other nine are
	// pinged while they hang. Three rather than one is what separates the two: a single hung peer
	// costs one timeout under either shape.
	it('pings every reachable neighbor without waiting on the peers that never answer', async () => {
		const ids = await harness.seedPeers(FULL_PASS, 'member')
		const hung = ids.slice(0, 3)
		for (const id of hung) rig.behavior.set(id, 'hangs')

		const elapsed = await preconnect()

		expect(elapsed, 'one ping timeout, not three chained ones').to.be.at.most(PING_TIMEOUT_MS + 1500)
		expect(elapsed, 'the hung peers really were in the pass and hit their timeout').to.be.at.least(PING_TIMEOUT_MS / 2)
		for (const id of ids.slice(3)) {
			expect(rig.protocolsSeenBy(id), `${id}: pinged exactly once`).to.deep.equal([harness.ping()])
		}
		for (const id of hung) {
			expect(rig.protocolsSeenBy(id), `${id}: ping opened, then timed out`).to.deep.equal([harness.ping()])
		}
		expect(svc.getDiagnostics().pingsSent, 'only the nine that answered are counted as sent').to.equal(9)
		expect(rig.inFlight, 'every hung open settled on its own deadline').to.equal(0)
	})

	// Asserted *equal* to the cap, not merely at-most: at-most also passes for a serial walk, and
	// the whole point is that the pass overlaps its peers. `holdMs` keeps overlapping opens open
	// together long enough for the high-water mark to be real.
	async function expectHighWaterAtCap(): Promise<void> {
		rig.holdMs = 30
		await harness.seedPeers(FULL_PASS, 'member')
		const cap = harness.concurrency()

		await preconnect()

		expect(rig.highWater, `in-flight high-water mark equals the ${cap}-wide pool`).to.equal(cap)
		expect(rig.inFlight, 'every stream released by the end of the pass').to.equal(0)
	}

	it('Core: never more than 6 pings in flight, and 6 are reached', async () => {
		expect(harness.concurrency()).to.equal(6)
		await expectHighWaterAtCap()
	})

	it('Edge: never more than 2 pings in flight, and 2 are reached', async () => {
		await harness.teardown()
		await build('edge')
		expect(harness.concurrency()).to.equal(2)
		await expectHighWaterAtCap()
	})

	// Filtering `isDialable` *before* the task list is built is what keeps a pool slot from going to
	// a peer that can only fail to dial. Observable as: the pass still reaches the cap when half the
	// walk is undialable, rather than spending slots on no-ops.
	it('spends pool slots only on dialable peers', async () => {
		rig.holdMs = 30
		const ids = await harness.seedPeers(FULL_PASS, 'member')
		// Undialable = no known address *and* no connection; the rig's stub `getConnections` answers
		// for every id, so the connection has to be withdrawn too.
		const undialable = new Set(ids.slice(0, 6))
		for (const id of undialable) (svc as any).setAddressKnown(id, false)
		const { node } = harness
		;(node as any).getConnections = (pid?: any) =>
			pid == null || undialable.has(pid.toString()) ? [] : [rig.connectionFor(pid.toString())]

		await preconnect()

		for (const id of undialable) {
			expect(rig.protocolsSeenBy(id), `${id}: undialable, never opened`).to.deep.equal([])
		}
		expect(rig.highWater, 'the six dialable peers still fill the six-wide pool').to.equal(harness.concurrency())
		expect(svc.getDiagnostics().pingsSent, 'only the dialable six are pinged').to.equal(6)
	})
})
