import { expect } from 'chai'
import { FretService } from '../src/service/fret-service.js'

/**
 * The tick-budget arithmetic, pinned over the **declared defaults**.
 *
 * Deliberately a static test rather than a runtime assertion inside `stabilizeOnce`:
 * `test/helpers/maintenance-rig.ts` and `test/per-tick-hotpath.spec.ts` mutate
 * `STABILIZE_TICK_BUDGET_MS` down to tens of milliseconds to keep tests fast, so a runtime assert
 * would throw in every such test. This spec must therefore never build a rig — it reads the
 * statics off the class directly, before anything has had a chance to mutate them.
 *
 * The invariant: the worst-case cost of one pooled unit inside a phase must fit inside that
 * phase's own budget, and the phases' budgets plus a one-RPC reserve must fit inside the tick.
 */
describe('stabilize budget invariants', () => {
	const s = FretService as unknown as {
		MAINTENANCE_RPC_TIMEOUT_MS: number
		MAINTENANCE_SNAPSHOT_TIMEOUT_MS: number
		STABILIZE_PHASE_ONE_BUDGET_MS: number
		STABILIZE_TICK_BUDGET_MS: number
	}

	it('declares all four budgets as positive finite numbers', () => {
		for (const k of ['MAINTENANCE_RPC_TIMEOUT_MS', 'MAINTENANCE_SNAPSHOT_TIMEOUT_MS', 'STABILIZE_PHASE_ONE_BUDGET_MS', 'STABILIZE_TICK_BUDGET_MS'] as const) {
			expect(s[k], `${k} must be a positive finite number`).to.be.a('number').and.to.be.greaterThan(0)
			expect(Number.isFinite(s[k]), `${k} must be finite`).to.equal(true)
		}
	})

	it('fits one worst-case phase-1 unit (ping + snapshot) inside the phase-1 budget', () => {
		const unit = s.MAINTENANCE_RPC_TIMEOUT_MS + s.MAINTENANCE_SNAPSHOT_TIMEOUT_MS
		expect(
			unit,
			`one phase-1 unit is MAINTENANCE_RPC_TIMEOUT_MS (${s.MAINTENANCE_RPC_TIMEOUT_MS}) + ` +
			`MAINTENANCE_SNAPSHOT_TIMEOUT_MS (${s.MAINTENANCE_SNAPSHOT_TIMEOUT_MS}) = ${unit}ms, which must fit ` +
			`inside STABILIZE_PHASE_ONE_BUDGET_MS (${s.STABILIZE_PHASE_ONE_BUDGET_MS}). One of those three numbers moved: ` +
			`either raise the phase-1 budget or lower a per-RPC timeout, or a merely-slow near peer is cut off mid-unit.`,
		).to.be.at.most(s.STABILIZE_PHASE_ONE_BUDGET_MS)
	})

	it('leaves phase 2 a reserve of at least one maintenance ping inside the tick budget', () => {
		const needed = s.STABILIZE_PHASE_ONE_BUDGET_MS + s.MAINTENANCE_RPC_TIMEOUT_MS
		expect(
			needed,
			`STABILIZE_PHASE_ONE_BUDGET_MS (${s.STABILIZE_PHASE_ONE_BUDGET_MS}) + one MAINTENANCE_RPC_TIMEOUT_MS ` +
			`(${s.MAINTENANCE_RPC_TIMEOUT_MS}) = ${needed}ms, which must fit inside STABILIZE_TICK_BUDGET_MS ` +
			`(${s.STABILIZE_TICK_BUDGET_MS}). One of those three numbers moved: phase 2 no longer has a reserved ` +
			`slice big enough to complete a single probe, so a phase-1 straggler can starve it again.`,
		).to.be.at.most(s.STABILIZE_TICK_BUDGET_MS)
	})
})
