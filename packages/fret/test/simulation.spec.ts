import { describe, it } from 'mocha'
import { FretSimulation } from './simulation/fret-sim.js'
import type { SimMetrics } from './simulation/sim-metrics.js'

describe('FRET simulation tests', function () {
	// NOTE: the N=100 case dominates this budget. Churn pairs each departure with an
	// arrival, so its population now holds at 100 for the whole 10s run instead of
	// collapsing toward 50, roughly doubling the per-tick stabilization work; the run
	// crossed the previous 60s ceiling under full-suite CPU contention (27s measured in
	// isolation). If this suite's wall time becomes a problem,
	// shorten that case's durationMs rather than lowering churnRatePerSec — the rate is
	// what the case is measuring.
	this.timeout(180000)

	it('converges with N=5, no churn', () => {
		const sim = new FretSimulation({
			seed: 42,
			n: 5,
			k: 5,
			m: 3,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 3000,
		})
		const metrics = sim.run()
		if (metrics.totalJoins !== 5) throw new Error(`Expected 5 joins, got ${metrics.totalJoins}`)
		if (metrics.avgNeighborCount === 0) throw new Error('No neighbors found')
		console.log('  N=5 metrics:', metrics)
	})

	it('converges with N=10, no churn', () => {
		const sim = new FretSimulation({
			seed: 123,
			n: 10,
			k: 7,
			m: 4,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 5000,
		})
		const metrics = sim.run()
		if (metrics.totalJoins !== 10) throw new Error(`Expected 10 joins, got ${metrics.totalJoins}`)
		if (metrics.avgNeighborCount === 0) throw new Error('No neighbors found')
		console.log('  N=10 metrics:', metrics)
	})

	it('converges with N=25, light churn (1%/s)', () => {
		const sim = new FretSimulation({
			seed: 999,
			n: 25,
			k: 15,
			m: 8,
			churnRatePerSec: 0.25,
			stabilizationIntervalMs: 500,
			durationMs: 10000,
		})
		const metrics = sim.run()
		// Churn is on, so each churn event pairs a departure with a fresh arrival:
		// totalJoins exceeds n by the number of churn events. Only the floor is pinned.
		if (metrics.totalJoins < 25) throw new Error(`Expected ≥ 25 joins, got ${metrics.totalJoins}`)
		if (metrics.avgNeighborCount === 0) throw new Error('No neighbors found')
		console.log('  N=25 metrics:', metrics)
	})

	it('handles N=100, moderate churn (5%/s)', () => {
		const sim = new FretSimulation({
			seed: 7777,
			n: 100,
			k: 15,
			m: 8,
			churnRatePerSec: 5,
			stabilizationIntervalMs: 300,
			durationMs: 10000,
		})
		const metrics = sim.run()
		// Churn pairs each departure with an arrival (see churnRatePerSec), so totalJoins
		// exceeds n once churn is on; the initial population is the floor.
		if (metrics.totalJoins < 100) throw new Error(`Expected ≥ 100 joins, got ${metrics.totalJoins}`)
		console.log('  N=100 metrics:', metrics)
	})
})

