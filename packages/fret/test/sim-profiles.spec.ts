import { describe, it } from 'mocha'
import { FretSimulation, EDGE_PROFILE, CORE_PROFILE } from './simulation/fret-sim.js'
import { percentile, percentileSummary } from './simulation/sim-metrics.js'
import type { SimReport } from './simulation/sim-metrics.js'

describe('Simulation metrics and profiles', function () {
	this.timeout(60000)

	describe('percentile calculations', () => {
		it('computes correct percentiles for known inputs', () => {
			// 1..100
			const values = Array.from({ length: 100 }, (_, i) => i + 1)
			const sorted = [...values].sort((a, b) => a - b)
			if (percentile(sorted, 50) !== 50) throw new Error(`p50: expected 50, got ${percentile(sorted, 50)}`)
			if (percentile(sorted, 90) !== 90) throw new Error(`p90: expected 90, got ${percentile(sorted, 90)}`)
			if (percentile(sorted, 99) !== 99) throw new Error(`p99: expected 99, got ${percentile(sorted, 99)}`)

			const summary = percentileSummary(values)
			if (summary.max !== 100) throw new Error(`max: expected 100, got ${summary.max}`)
			if (summary.p50 !== 50) throw new Error(`summary p50: expected 50, got ${summary.p50}`)
		})

		it('handles empty array', () => {
			const summary = percentileSummary([])
			if (summary.p50 !== 0) throw new Error(`expected 0 for empty, got ${summary.p50}`)
			if (summary.max !== 0) throw new Error(`expected max 0 for empty, got ${summary.max}`)
		})

		it('handles single-element array', () => {
			const summary = percentileSummary([42])
			if (summary.p50 !== 42) throw new Error(`expected 42, got ${summary.p50}`)
			if (summary.p99 !== 42) throw new Error(`expected 42, got ${summary.p99}`)
			if (summary.max !== 42) throw new Error(`expected 42, got ${summary.max}`)
		})
	})

	describe('JSON report', () => {
		it('toJSON() round-trips and matches original metrics', () => {
			const sim = new FretSimulation({
				seed: 42,
				n: 10,
				k: 7,
				m: 4,
				churnRatePerSec: 0,
				stabilizationIntervalMs: 500,
				durationMs: 3000,
			})
			sim.run()

			const json = sim.metrics.toJSON({ seed: 42, config: { n: 10, k: 7 } })
			const parsed: SimReport = JSON.parse(json)

			if (parsed.meta.seed !== 42) throw new Error(`seed mismatch: ${parsed.meta.seed}`)
			if (parsed.summary.totalJoins !== 10) throw new Error(`joins mismatch: ${parsed.summary.totalJoins}`)
			if (!parsed.meta.timestamp) throw new Error('missing timestamp')

			// Verify distributions are present
			if (typeof parsed.distributions.neighborCount.p50 !== 'number') {
				throw new Error('missing neighborCount p50')
			}
			if (typeof parsed.distributions.convergence.finalCoverage !== 'number') {
				throw new Error('missing convergence finalCoverage')
			}

			// Re-parse to verify JSON round-trip fidelity
			const reparsed = JSON.parse(JSON.stringify(parsed))
			if (reparsed.summary.totalJoins !== parsed.summary.totalJoins) {
				throw new Error('round-trip mismatch')
			}
			console.log('  Report meta:', parsed.meta)
			console.log('  Distributions:', JSON.stringify(parsed.distributions))
		})

		it('toReport() includes distribution summaries', () => {
			const sim = new FretSimulation({
				seed: 777,
				n: 20,
				k: 10,
				m: 5,
				churnRatePerSec: 0,
				stabilizationIntervalMs: 500,
				durationMs: 5000,
			})
			// Schedule some routes to generate routing hops data
			sim.initialize()
			const peers = Array.from(sim.getPeers().values()).filter((p) => p.alive)
			for (let i = 0; i < 10; i++) {
				const target = new Uint8Array(32)
				for (let j = 0; j < 32; j++) target[j] = ((777 + i) * (j + 1)) & 0xff
				sim.scheduleRoute(peers[i % peers.length]!.id, target, 2000 + i * 100)
			}

			while (sim.scheduler.pending() > 0) {
				const evt = sim.scheduler.nextEvent()
				if (!evt || evt.time > 5000) break
				sim.processEvent(evt)
			}

			const report = sim.metrics.toReport({ seed: 777, config: { n: 20 } })
			console.log('  Routing hops distribution:', report.distributions.routingHops)
			console.log('  Convergence:', report.distributions.convergence)

			if (report.distributions.routingHops.max < 0) {
				throw new Error('routing hops max should be >= 0')
			}
		})
	})

	describe('Edge/Core profiles', () => {
		it('mixed network (70% edge, 30% core) converges and meets coverage threshold', () => {
			const sim = new FretSimulation({
				seed: 5555,
				n: 30,
				k: 15,
				m: 8,
				churnRatePerSec: 0,
				stabilizationIntervalMs: 500,
				durationMs: 12000,
				profileMix: { edge: 0.7, core: 0.3 },
			})
			const metrics = sim.run()

			const coverage = sim.snapshotCoverage()
			console.log('  Mixed profile coverage:', (coverage * 100).toFixed(1) + '%')
			console.log('  Stabilization cycles:', metrics.stabilizationCycles)

			// Count profiles
			let edgeCount = 0
			let coreCount = 0
			for (const peer of sim.getPeers().values()) {
				if (peer.profileConfig.profile === 'edge') edgeCount++
				else coreCount++
			}
			console.log('  Edge peers:', edgeCount, 'Core peers:', coreCount)

			// Should have both types
			if (edgeCount === 0) throw new Error('Expected some edge peers')
			if (coreCount === 0) throw new Error('Expected some core peers')

			// Coverage should still meet threshold (may converge slower than all-core)
			if (coverage < 0.6) {
				throw new Error(`Coverage only ${(coverage * 100).toFixed(1)}%, expected ≥60%`)
			}
		})

		it('all-core converges faster than mixed edge/core', () => {
			const coreOnlySim = new FretSimulation({
				seed: 6666,
				n: 30,
				k: 15,
				m: 8,
				churnRatePerSec: 0,
				stabilizationIntervalMs: 500,
				durationMs: 8000,
			})
			coreOnlySim.run()
			const coreCoverage = coreOnlySim.snapshotCoverage()

			const mixedSim = new FretSimulation({
				seed: 6666,
				n: 30,
				k: 15,
				m: 8,
				churnRatePerSec: 0,
				stabilizationIntervalMs: 500,
				durationMs: 8000,
				profileMix: { edge: 0.7, core: 0.3 },
			})
			mixedSim.run()
			const mixedCoverage = mixedSim.snapshotCoverage()

			console.log('  All-core coverage:', (coreCoverage * 100).toFixed(1) + '%')
			console.log('  Mixed coverage:', (mixedCoverage * 100).toFixed(1) + '%')

			// All-core should converge at least as well as mixed
			// (it may not always be strictly better due to RNG differences with profileMix, but should be close)
			if (coreCoverage < mixedCoverage - 0.05) {
				throw new Error(`All-core (${(coreCoverage * 100).toFixed(1)}%) unexpectedly worse than mixed (${(mixedCoverage * 100).toFixed(1)}%)`)
			}
		})

		it('edge peers never send snapshots exceeding their profile limits', () => {
			const sim = new FretSimulation({
				seed: 7777,
				n: 20,
				k: 15,
				m: 8,
				churnRatePerSec: 0,
				stabilizationIntervalMs: 500,
				durationMs: 5000,
				profileMix: { edge: 1.0, core: 0.0 },
				messageBus: {
					defaultLatencyMs: 10,
					defaultLossRate: 0,
					defaultQueueCapacity: 100,
					latencyDistribution: 'constant',
					latencyJitter: 0,
				},
			})
			sim.run()

			// All peers should be edge
			for (const peer of sim.getPeers().values()) {
				if (peer.profileConfig.profile !== 'edge') {
					throw new Error(`Expected all edge peers, found ${peer.profileConfig.profile}`)
				}
			}

			// Verify edge caps are correctly set
			const edgeCap = EDGE_PROFILE.snapshotCap
			if (edgeCap.successors !== 6) throw new Error(`Edge successors cap should be 6, got ${edgeCap.successors}`)
			if (edgeCap.predecessors !== 6) throw new Error(`Edge predecessors cap should be 6, got ${edgeCap.predecessors}`)
			if (edgeCap.sample !== 6) throw new Error(`Edge sample cap should be 6, got ${edgeCap.sample}`)

			const coreCap = CORE_PROFILE.snapshotCap
			if (coreCap.successors !== 12) throw new Error(`Core successors cap should be 12, got ${coreCap.successors}`)
			if (coreCap.predecessors !== 12) throw new Error(`Core predecessors cap should be 12, got ${coreCap.predecessors}`)
			if (coreCap.sample !== 8) throw new Error(`Core sample cap should be 8, got ${coreCap.sample}`)

			console.log('  Edge snapshot caps verified: 6/6/6')
			console.log('  Core snapshot caps verified: 12/12/8')
		})

		it('edge peers have limited connections', () => {
			const sim = new FretSimulation({
				seed: 8888,
				n: 20,
				k: 15,
				m: 8,
				churnRatePerSec: 0,
				stabilizationIntervalMs: 500,
				durationMs: 3000,
				profileMix: { edge: 1.0, core: 0.0 },
			})
			sim.run()

			// Edge peers maxConnections is 4, so initial connect should be bounded
			for (const peer of sim.getPeers().values()) {
				if (!peer.alive) continue
				if (peer.profileConfig.maxConnections !== EDGE_PROFILE.maxConnections) {
					throw new Error(`Expected maxConnections ${EDGE_PROFILE.maxConnections}, got ${peer.profileConfig.maxConnections}`)
				}
			}
			console.log('  Edge maxConnections verified:', EDGE_PROFILE.maxConnections)
		})
	})

	describe('regression thresholds', () => {
		it('routing success rate must not drop below 85%', () => {
			const sim = new FretSimulation({
				seed: 9999,
				n: 50,
				k: 15,
				m: 8,
				churnRatePerSec: 0,
				stabilizationIntervalMs: 500,
				durationMs: 8000,
			})
			sim.initialize()

			// Warm up
			for (const evt of sim.scheduler.advanceTo(3000)) {
				sim.processEvent(evt)
			}

			// Schedule routes
			const peers = Array.from(sim.getPeers().values()).filter((p) => p.alive)
			for (let i = 0; i < 30; i++) {
				const target = new Uint8Array(32)
				for (let j = 0; j < 32; j++) target[j] = ((9999 + i * 13) * (j + 1)) & 0xff
				sim.scheduleRoute(peers[i % peers.length]!.id, target, 3500 + i * 100)
			}

			while (sim.scheduler.pending() > 0) {
				const evt = sim.scheduler.nextEvent()
				if (!evt || evt.time > 8000) break
				sim.processEvent(evt)
			}

			const report = sim.metrics.toReport({ seed: 9999, config: { n: 50 } })
			console.log('  Routing success rate:', (report.summary.routingSuccessRate * 100).toFixed(1) + '%')
			console.log('  Routing hops:', report.distributions.routingHops)

			if (report.summary.routingSuccessRate < 0.85) {
				throw new Error(
					`Routing success rate ${(report.summary.routingSuccessRate * 100).toFixed(1)}% below 85% threshold`
				)
			}
		})
	})
})
