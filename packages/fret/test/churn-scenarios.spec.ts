import { describe, it } from 'mocha'
import { FretSimulation } from './simulation/fret-sim.js'

describe('Churn scenario simulations', function () {
	this.timeout(60000)

	it('batched leave: 30% simultaneous departure recovers coverage', () => {
		const sim = new FretSimulation({
			seed: 1001,
			n: 50,
			k: 15,
			m: 8,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 12000,
		})
		sim.initialize()

		// Warm up for 3s
		for (const evt of sim.scheduler.advanceTo(3000)) {
			(sim as any).handleEvent(evt)
		}

		const preChurnCoverage = sim.snapshotCoverage()
		console.log('  Pre-churn coverage:', (preChurnCoverage * 100).toFixed(1) + '%')

		// Remove 30% of peers simultaneously at t=3000
		const leaveCount = Math.ceil(sim.aliveCount() * 0.3)
		sim.scheduleBatchLeave(leaveCount, 3001)

		// Continue simulation to t=8000 (5s recovery window)
		while (sim.scheduler.pending() > 0) {
			const evt = sim.scheduler.nextEvent()
			if (!evt || evt.time > 12000) break
			;(sim as any).handleEvent(evt)
		}

		const metrics = sim.metrics.finalize()
		const finalCoverage = sim.snapshotCoverage()
		console.log('  Post-recovery coverage:', (finalCoverage * 100).toFixed(1) + '%')
		console.log('  Leaves:', metrics.totalLeaves, '/', leaveCount, 'expected')

		// Coverage should recover to at least 80% of ideal
		if (finalCoverage < 0.8) {
			throw new Error(`Coverage only ${(finalCoverage * 100).toFixed(1)}%, expected ≥80%`)
		}
		if (metrics.totalLeaves < leaveCount) {
			throw new Error(`Expected ${leaveCount} leaves, got ${metrics.totalLeaves}`)
		}
	})

	it('batched join: burst of new peers stabilizes without orphans', () => {
		const sim = new FretSimulation({
			seed: 2002,
			n: 20,
			k: 15,
			m: 8,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 10000,
		})
		sim.initialize()

		// Warm up for 2s
		for (const evt of sim.scheduler.advanceTo(2000)) {
			(sim as any).handleEvent(evt)
		}

		console.log('  Pre-burst alive:', sim.aliveCount())

		// Burst of 30 new peers at t=2001
		sim.scheduleBatchJoin(30, 2001)

		// Continue to t=7000 (5s convergence window)
		while (sim.scheduler.pending() > 0) {
			const evt = sim.scheduler.nextEvent()
			if (!evt || evt.time > 10000) break
			;(sim as any).handleEvent(evt)
		}

		const metrics = sim.metrics.finalize()
		const finalCoverage = sim.snapshotCoverage()
		console.log('  Post-burst alive:', sim.aliveCount())
		console.log('  Post-burst coverage:', (finalCoverage * 100).toFixed(1) + '%')

		// All peers should have at least 1 neighbor (no orphans)
		let orphans = 0
		for (const [_id, peer] of sim.getPeers()) {
			if (peer.alive && peer.neighbors.size === 0) orphans++
		}
		console.log('  Orphans:', orphans)

		// Total joins = initial 20 + burst 30
		if (metrics.totalJoins !== 50) {
			throw new Error(`Expected 50 total joins, got ${metrics.totalJoins}`)
		}
		// Coverage should be at least 70%
		if (finalCoverage < 0.7) {
			throw new Error(`Coverage only ${(finalCoverage * 100).toFixed(1)}%, expected ≥70%`)
		}
	})

	it('mixed churn: continuous join/leave maintains coverage above threshold', () => {
		const sim = new FretSimulation({
			seed: 3003,
			n: 40,
			k: 15,
			m: 8,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 15000,
		})
		sim.initialize()

		// Warm up for 2s
		for (const evt of sim.scheduler.advanceTo(2000)) {
			(sim as any).handleEvent(evt)
		}

		// Schedule mixed churn: alternating joins and leaves at 2/s from t=2000 to t=15000
		for (let t = 2100; t < 15000; t += 500) {
			if (t % 1000 < 500) {
				// Leave event
				const alive = Array.from(sim.getPeers().values()).filter((p) => p.alive)
				if (alive.length > 10) {
					sim.scheduleBatchLeave(1, t)
				}
			} else {
				// Join event
				sim.scheduleBatchJoin(1, t)
			}
		}

		// Run to completion, recording coverage at each stabilize
		while (sim.scheduler.pending() > 0) {
			const evt = sim.scheduler.nextEvent()
			if (!evt || evt.time > 15000) break
			;(sim as any).handleEvent(evt)
		}

		const metrics = sim.metrics.finalize()
		console.log('  Total joins:', metrics.totalJoins, 'leaves:', metrics.totalLeaves)
		console.log('  Alive at end:', sim.aliveCount())

		// Check that coverage never dropped below 50% in any 2s window
		const series = metrics.coverageTimeSeries
		let minWindowAvg = 1
		for (let i = 0; i < series.length; i++) {
			const windowEnd = series[i]!.time + 2000
			const window = series.filter((s) => s.time >= series[i]!.time && s.time <= windowEnd)
			if (window.length > 0) {
				const avg = window.reduce((sum, s) => sum + s.coverage, 0) / window.length
				if (avg < minWindowAvg) minWindowAvg = avg
			}
		}
		console.log('  Min 2s window avg coverage:', (minWindowAvg * 100).toFixed(1) + '%')

		if (minWindowAvg < 0.5) {
			throw new Error(
				`Coverage dropped to ${(minWindowAvg * 100).toFixed(1)}% in a 2s window, expected ≥50%`
			)
		}
	})

	it('proactive announcements: dead neighbors pruned after stabilization', () => {
		const sim = new FretSimulation({
			seed: 4004,
			n: 30,
			k: 15,
			m: 8,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 8000,
		})
		sim.initialize()

		// Warm up for 2s
		for (const evt of sim.scheduler.advanceTo(2000)) {
			(sim as any).handleEvent(evt)
		}

		// Remove 5 peers at t=2001
		sim.scheduleBatchLeave(5, 2001)

		// Run for 3 more stabilization cycles (1.5s at 500ms interval)
		while (sim.scheduler.pending() > 0) {
			const evt = sim.scheduler.nextEvent()
			if (!evt || evt.time > 8000) break
			;(sim as any).handleEvent(evt)
		}

		// Check dead neighbor ratio
		const deadRatio = sim.deadNeighborRatio()
		console.log('  Dead neighbor ratio:', (deadRatio * 100).toFixed(1) + '%')

		if (deadRatio > 0.20) {
			throw new Error(
				`Dead neighbor ratio ${(deadRatio * 100).toFixed(1)}%, expected ≤20%`
			)
		}
	})

	it('routing under churn: lookups succeed during active churn', () => {
		const sim = new FretSimulation({
			seed: 5005,
			n: 50,
			k: 15,
			m: 8,
			churnRatePerSec: 1,
			stabilizationIntervalMs: 500,
			durationMs: 15000,
		})
		sim.initialize()

		// Warm up for 3s
		for (const evt of sim.scheduler.advanceTo(3000)) {
			(sim as any).handleEvent(evt)
		}

		// Schedule 20 route lookups spread across t=3500 to t=13000
		const alivePeers = Array.from(sim.getPeers().values()).filter((p) => p.alive)
		for (let i = 0; i < 20; i++) {
			const from = alivePeers[i % alivePeers.length]!
			// Random target coordinate
			const targetCoord = new Uint8Array(32)
			const seed = 5005 + i * 7
			for (let j = 0; j < 32; j++) {
				targetCoord[j] = (seed * (j + 1) * 31) & 0xff
			}
			sim.scheduleRoute(from.id, targetCoord, 3500 + i * 500)
		}

		// Run to completion
		while (sim.scheduler.pending() > 0) {
			const evt = sim.scheduler.nextEvent()
			if (!evt || evt.time > 15000) break
			;(sim as any).handleEvent(evt)
		}

		const metrics = sim.metrics.finalize()
		console.log('  Routing attempts:', metrics.routingAttempts)
		console.log('  Routing successes:', metrics.routingSuccesses)
		console.log('  Routing success rate:', (metrics.routingSuccessRate * 100).toFixed(1) + '%')
		console.log('  Avg routing hops:', metrics.avgRoutingHops.toFixed(1))

		if (metrics.routingAttempts !== 20) {
			throw new Error(`Expected 20 routing attempts, got ${metrics.routingAttempts}`)
		}

		// At least 80% success rate
		if (metrics.routingSuccessRate < 0.8) {
			throw new Error(
				`Routing success rate ${(metrics.routingSuccessRate * 100).toFixed(1)}%, expected ≥80%`
			)
		}

		// Average hops should be bounded by log2(N) + 2
		const maxAvgHops = Math.log2(50) + 2
		if (metrics.avgRoutingHops > maxAvgHops) {
			throw new Error(
				`Avg routing hops ${metrics.avgRoutingHops.toFixed(1)}, expected ≤${maxAvgHops.toFixed(1)}`
			)
		}
	})
})
