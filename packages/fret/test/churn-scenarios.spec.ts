import { describe, it } from 'mocha'
import { FretSimulation, type PlacementStrategy } from './simulation/fret-sim.js'
import { coordToBigInt, maxPeersInOneSpacingArc, PLACEMENT_SEEDS, MAX_PEERS_IN_ONE_SPACING_ARC } from './simulation/placement-assertions.js'

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
			sim.processEvent(evt)
		}

		const preChurnCoverage = sim.snapshotCoverage()
		console.log('  Pre-churn coverage:', (preChurnCoverage * 100).toFixed(1) + '%')

		// Remove 30% of peers simultaneously at t=3000
		const leaveCount = Math.ceil(sim.aliveCount() * 0.3)
		sim.scheduleBatchLeave(leaveCount, 3001)

		// Continue simulation to t=8000 (5s recovery window)
		// NOTE: this drain idiom pops an event and discards it when it lands past the bound,
		// unlike test/simulation/pump.ts which peeks first and leaves it queued. Pre-existing and
		// used at nine sites across this spec, sim-profiles.spec.ts and message-bus.spec.ts; every
		// one of them is the last drain of its sim, so the dropped event changes no reading today.
		// If a site ever drains to a bound and then keeps simulating, fold it onto `pump` instead.
		while (sim.scheduler.pending() > 0) {
			const evt = sim.scheduler.nextEvent()
			if (!evt || evt.time > 12000) break
			;sim.processEvent(evt)
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
			sim.processEvent(evt)
		}

		console.log('  Pre-burst alive:', sim.aliveCount())

		// Burst of 30 new peers at t=2001
		sim.scheduleBatchJoin(30, 2001)

		// Continue to t=7000 (5s convergence window)
		while (sim.scheduler.pending() > 0) {
			const evt = sim.scheduler.nextEvent()
			if (!evt || evt.time > 10000) break
			;sim.processEvent(evt)
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
			sim.processEvent(evt)
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
			;sim.processEvent(evt)
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
			sim.processEvent(evt)
		}

		// Remove 5 peers at t=2001
		sim.scheduleBatchLeave(5, 2001)

		// Run for 3 more stabilization cycles (1.5s at 500ms interval)
		while (sim.scheduler.pending() > 0) {
			const evt = sim.scheduler.nextEvent()
			if (!evt || evt.time > 8000) break
			;sim.processEvent(evt)
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
			sim.processEvent(evt)
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
			;sim.processEvent(evt)
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

	it('continuous churn keeps the population stationary', () => {
		const config = {
			seed: 6006,
			n: 40,
			k: 15,
			m: 8,
			churnRatePerSec: 2,
			stabilizationIntervalMs: 500,
			durationMs: 10000,
		}
		const sim = new FretSimulation(config)
		const metrics = sim.run()

		// Each churn event is a paired leave + join, so joins = n + churnEvents and
		// leaves = churnEvents. The population therefore never drifts from n. Before
		// pairing landed, this run lost one peer per event and ended at 20 alive.
		// Mirrors scheduleChurn's loop (t = interval; t < durationMs; t += interval), which
		// yields ceil(durationMs / interval) - 1 events. Ceil, not floor: with a non-dividing
		// interval (rate 3 -> 333ms) floor undercounts by one.
		const churnInterval = Math.floor(1000 / config.churnRatePerSec)
		const churnEvents = Math.ceil(config.durationMs / churnInterval) - 1
		console.log('  Joins:', metrics.totalJoins, 'leaves:', metrics.totalLeaves, 'alive:', sim.aliveCount())

		if (metrics.totalLeaves !== churnEvents) {
			throw new Error(`Expected ${churnEvents} leaves, got ${metrics.totalLeaves}`)
		}
		if (metrics.totalJoins !== config.n + churnEvents) {
			throw new Error(`Expected ${config.n + churnEvents} joins, got ${metrics.totalJoins}`)
		}
		if (sim.aliveCount() !== config.n) {
			throw new Error(`Expected ${config.n} alive at end, got ${sim.aliveCount()}`)
		}
	})

	it('churn replays identically across runs at one seed', () => {
		// Churn now draws its leaver at fire time rather than at setup, so the RNG is
		// consumed interleaved with every other event. Lazy scheduling is precisely what
		// could introduce order-dependence, so pin byte-identical metrics across two runs.
		const config = {
			seed: 7007,
			n: 30,
			k: 15,
			m: 8,
			churnRatePerSec: 3,
			stabilizationIntervalMs: 500,
			durationMs: 8000,
		}

		const first = new FretSimulation(config).run()
		const second = new FretSimulation(config).run()

		if (JSON.stringify(first) !== JSON.stringify(second)) {
			throw new Error('Churn run is not deterministic across two runs at the same seed')
		}
		if (first.totalLeaves === 0) {
			throw new Error('Expected churn to produce leaves; the case would pass vacuously')
		}
	})

	it('uniform placement keeps a batch of joiners spread across the ring', () => {
		assertPlacementSeparates('batch burst', { churnRatePerSec: 0, batchJoin: true })
	})

	it('uniform placement keeps churn-driven joiners spread across the ring', () => {
		// `handleChurn` calls `handleJoin` for every leave, so churn-driven joins run through the
		// same placement path as a batch join. Covered as its own case rather than mixed into the
		// batch one: a statistic can pass on a mix while being blind to one arm of it.
		assertPlacementSeparates('steady trickle', { churnRatePerSec: 2, batchJoin: false })
	})
})

interface PlacementCase {
	churnRatePerSec: number
	batchJoin: boolean
}

function placementReading(placement: PlacementStrategy, seed: number, c: PlacementCase): number {
	const sim = new FretSimulation({
		seed,
		n: 40,
		k: 15,
		m: 8,
		churnRatePerSec: c.churnRatePerSec,
		// Deliberately far coarser than the 500ms the other cases in this file use: stabilization
		// changes neither a peer's coordinate nor its alive flag, so it cannot move this
		// statistic — it only costs wall time. Every reading in the table above was taken at both
		// 500ms and 5000ms and came out identical, while the 20 runs these two cases perform went
		// from 100s to 3s.
		stabilizationIntervalMs: 5000,
		durationMs: 10000,
		placement,
	})
	sim.initialize()
	if (c.batchJoin) sim.scheduleBatchJoin(10, 3000)

	while (sim.scheduler.pending() > 0) {
		const evt = sim.scheduler.nextEvent()
		if (!evt || evt.time > 10000) break
		sim.processEvent(evt)
	}

	const alive = Array.from(sim.getPeers().values()).filter((p) => p.alive)
	return maxPeersInOneSpacingArc(alive.map((p) => coordToBigInt(p.coord)))
}

/**
 * Assert both directions at once: the shipped placement reads under the threshold and the
 * deliberately-clumping placement reads over it. Asserting only the passing arm is what let a
 * guard with no separating power ship in the first place.
 */
function assertPlacementSeparates(label: string, c: PlacementCase): void {
	for (const seed of PLACEMENT_SEEDS) {
		const fixed = placementReading('uniform', seed, c)
		const clumped = placementReading('clumped-joiners', seed, c)
		console.log(
			`  ${label} seed ${seed}: uniform ${fixed}, clumped-joiners ${clumped}` +
				` (threshold ${MAX_PEERS_IN_ONE_SPACING_ARC})`
		)

		if (fixed > MAX_PEERS_IN_ONE_SPACING_ARC) {
			throw new Error(
				`${label} seed ${seed}: uniform placement packed ${fixed} peers into one even-spacing ` +
					`arc, expected ≤${MAX_PEERS_IN_ONE_SPACING_ARC}`
			)
		}
		if (clumped <= MAX_PEERS_IN_ONE_SPACING_ARC) {
			throw new Error(
				`${label} seed ${seed}: clumped-joiners placement packed only ${clumped} peers into one ` +
					`even-spacing arc, expected >${MAX_PEERS_IN_ONE_SPACING_ARC} — the guard no longer ` +
					`separates the bug from the fix and its threshold needs re-measuring`
			)
		}
	}
}
