import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { buildMaintenanceRig, type MaintenanceRig, type PeerRig } from './helpers/maintenance-rig.js'
import type { FretService as CoreFretService } from '../src/service/fret-service.js'
import { ringNeighborsBothSides } from '../src/service/ring-walk.js'

// The two connection warm-up passes — the one-shot `preconnectNeighbors` at `start()` and the
// per-second active-mode tick (`activePreconnectTick`) — share one pooled fan-out
// (`pingWarmupTargets`), at the same `maintenanceConcurrency` cap the stabilization tick uses
// (Core 6 / Edge 2), against the **run signal** rather than a tick deadline. Serially they were
// exactly the "serial dial chain" the *Active vs passive state* section of `docs/fret.md` says
// active mode exists to avoid: up to 12 pings one at a time, each able to spend the full 2 s
// `MAINTENANCE_RPC_TIMEOUT_MS`.
//
// The shared-fan-out properties (cap reached, dialable-only slots, no serial chaining) are driven
// through `preconnectNeighbors`, the wider of the two passes (up to 12 targets vs the active tick's
// Core 6 / Edge 3). The active tick then has its own tests for the part that is *not* shared: its
// per-second budget, and that the budget is spent on peers that can actually be dialed.
//
// Harness (stub connections, per-peer hang control, in-flight high-water mark) is shared with
// `stabilize-concurrency.spec.ts` — see `helpers/maintenance-rig.ts`.

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

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
	//
	// NOTE: the only wall-clock assertion in this file, and the only shape that states the
	// regression directly (a serial walk is *slow*, not structurally different). It measures ~2040ms
	// against a 3500ms ceiling, so the 1460ms of slack absorbs an ordinarily loaded box; if it ever
	// goes flaky in CI, swap the elapsed bound for an ordering assertion — that the nine reachable
	// peers were all opened while the three hung ones were still in flight — rather than widening
	// the slack, which erodes what the test proves.
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

	// The pool's signal is the run signal, so a `stop()` landing *while tasks are in flight* must
	// abort the started ones and never dial the rest. `dead-state.spec.ts` covers the easier case
	// (already cancelled before the pass starts); this is the one where the pool has to distinguish
	// "started" from "not yet started".
	it('a run cancelled mid-pass aborts the started pings and never dials the rest', async () => {
		const ids = await harness.seedPeers(FULL_PASS, 'member')
		for (const id of ids) rig.behavior.set(id, 'hangs')
		const cap = harness.concurrency()
		const abort = new AbortController()
		;(svc as any).runAbort = abort

		const pass = (svc as any).preconnectNeighbors() as Promise<void>
		await sleep(50)
		expect(rig.inFlight, 'the pool is full and every task is stuck when the run is cancelled').to.equal(cap)

		abort.abort()
		await pass

		const dialed = ids.filter((id) => rig.protocolsSeenBy(id).length > 0)
		expect(dialed, 'only the tasks the pool had started; the rest were skipped, never dialed').to.have.length(cap)
		expect(rig.inFlight, 'every in-flight open settled on the abort').to.equal(0)
		expect(svc.getDiagnostics().pingsSent, 'a cancelled ping is not a ping sent').to.equal(0)
	})

	// ----- active-mode tick -----

	// The active tick is the *budgeted* pass: Core 6 / Edge 3 targets per second, drawn from a wider
	// `min(12, m)`-per-side walk. The budget is applied to the dialable peers, not to the raw walk —
	// otherwise a run of undialable near peers eats the whole budget and the tick warms nobody, which
	// is the opposite of what a warm-up pass is for. Blocking the *leading* peers in ring order is
	// what makes that deterministic rather than luck of the seed order.
	it('active tick: spends its per-second budget on dialable peers, skipping undialable leaders', async () => {
		rig.holdMs = 30
		const cap = harness.concurrency()
		const ACTIVE_BUDGET = 6 // Core
		await harness.seedPeers(16, 'member')
		const selfCoord: Uint8Array = await (svc as any).selfCoord()
		const m = (svc as any).cfg.m as number
		// The tick's own target walk, taken from the shared helper rather than restated here, so
		// the test cannot drift from `warmupTargetIds` the way a hand-rolled copy did: the copy was
		// side-major where the helper interleaves, and it did not drop self where the pass does.
		const walk = ringNeighborsBothSides(harness.store, selfCoord, Math.min(12, m), harness.node.peerId.toString())
		expect(walk.length, 'the walk is wider than the budget, so the budget actually binds').to.be.greaterThan(ACTIVE_BUDGET)

		const blocked = new Set(walk.slice(0, ACTIVE_BUDGET))
		for (const id of blocked) (svc as any).setAddressKnown(id, false)
		const { node } = harness
		;(node as any).getConnections = (pid?: any) =>
			pid == null || blocked.has(pid.toString()) ? [] : [rig.connectionFor(pid.toString())]

		await (svc as any).activePreconnectTick()

		for (const id of blocked) {
			expect(rig.protocolsSeenBy(id), `${id}: undialable leader, never opened`).to.deep.equal([])
		}
		const dialed = walk.filter((id) => rig.protocolsSeenBy(id).length > 0)
		expect(dialed, 'the full budget still went out, from the dialable tail').to.deep.equal(walk.slice(ACTIVE_BUDGET, ACTIVE_BUDGET * 2))
		expect(svc.getDiagnostics().pingsSent, 'exactly the budget, all answered').to.equal(ACTIVE_BUDGET)
		expect(rig.highWater, 'the budgeted pings overlap up to the pool cap').to.equal(Math.min(cap, ACTIVE_BUDGET))
		expect(rig.inFlight, 'every stream released by the end of the tick').to.equal(0)
	})

	it('active tick: Edge budgets 3 targets per second, pooled at 2', async () => {
		await harness.teardown()
		await build('edge')
		rig.holdMs = 30
		await harness.seedPeers(16, 'member')

		await (svc as any).activePreconnectTick()

		expect(svc.getDiagnostics().pingsSent, "Edge's per-second budget").to.equal(3)
		expect(rig.highWater, 'three targets, two in flight at a time').to.equal(2)
		expect(rig.inFlight, 'every stream released by the end of the tick').to.equal(0)
	})
})
