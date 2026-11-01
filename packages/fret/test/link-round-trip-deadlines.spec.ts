import { expect } from 'chai'
import { FretService } from '../src/service/fret-service.js'
import { buildMaintenanceRig, type MaintenanceRig } from './helpers/maintenance-rig.js'

/**
 * The reproduction of gotchoices/sereus#48 through the near pass: a connected peer behind a link
 * slower than the ping budget answers every ping too late, so each one times out, books a contact
 * strike, and the peer is marked `dead` while its connection is up. Declaring the link's round trip
 * (`FretConfig.linkRoundTripMs`) derives a ping budget that covers it.
 *
 * Scaled down to keep the run short: the ping floor is shrunk to 100 ms (as `near-exchange.spec.ts`
 * does) and the peer answers after 250 ms. Undeclared, the ping budget is the 100 ms floor; at a
 * declared 200 ms round trip it is 2 × 200 = 400 ms. Every other derived budget stays at its floor
 * (snapshot 1 s, phase 1 3 s, tick 5 s), so the ping is the only thing that differs between arms.
 *
 * This is the one wiring test for the derivation: it proves the declaration reaches the ping site.
 * The other use sites read the same `deadlines()` resolution (each `FretService` RPC call site
 * passes `this.deadlines().<field>`); the arithmetic itself is pinned in
 * `stabilize-budget-invariants.spec.ts`.
 */
describe('declared link round trip reaches the near ping', function () {
	this.timeout(10000)

	const PING_FLOOR_MS = 100
	const ANSWER_AFTER_MS = 250

	let harness: MaintenanceRig | undefined
	const REAL_RPC_TIMEOUT = (FretService as any).MAINTENANCE_RPC_TIMEOUT_MS as number
	beforeEach(() => { (FretService as any).MAINTENANCE_RPC_TIMEOUT_MS = PING_FLOOR_MS })
	afterEach(async () => {
		;(FretService as any).MAINTENANCE_RPC_TIMEOUT_MS = REAL_RPC_TIMEOUT
		if (harness != null) await harness.teardown()
		harness = undefined
	})

	async function tickAgainstSlowPeer(linkRoundTripMs?: number): Promise<{ contactFailures: number; pingsOk: number; pingsFail: number }> {
		harness = await buildMaintenanceRig('core', linkRoundTripMs === undefined ? {} : { linkRoundTripMs })
		const [id] = await harness.seedPeers(1, 'member') as [string]
		harness.rig.answerDelayMs.set(id, ANSWER_AFTER_MS)
		await (harness.svc as unknown as { stabilizeOnce: () => Promise<void> }).stabilizeOnce()
		const d = harness.svc.getDiagnostics()
		return { contactFailures: harness.store.getById(id)!.contactFailures ?? 0, pingsOk: d.pingsOk, pingsFail: d.pingsFail }
	}

	it('undeclared: a ping slower than the floor times out and strikes a connected peer', async () => {
		const out = await tickAgainstSlowPeer()
		expect(out.contactFailures, 'the late answer is booked as a failed contact').to.equal(1)
		expect(out.pingsOk).to.equal(0)
		expect(out.pingsFail).to.equal(1)
	})

	it('declared: the derived ping budget covers the link, so the peer answers and is not struck', async () => {
		const out = await tickAgainstSlowPeer(200)
		expect(out.contactFailures, 'no strike').to.equal(0)
		expect(out.pingsOk, 'the ping answered inside 2 × 200 ms').to.equal(1)
		expect(out.pingsFail).to.equal(0)
	})
})
