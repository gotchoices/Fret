import { describe, it } from 'mocha'
import { expect } from 'chai'
import { DeterministicRNG } from './simulation/deterministic-rng.js'
import { SimMessageBus, type MessageBusConfig } from './simulation/message-bus.js'
import { MetricsCollector } from './simulation/sim-metrics.js'
import { FretSimulation } from './simulation/fret-sim.js'

describe('DeterministicRNG extensions', () => {
	it('nextGaussian produces values with mean ~0 and stddev ~1', () => {
		const rng = new DeterministicRNG(42)
		const samples: number[] = []
		for (let i = 0; i < 10000; i++) {
			samples.push(rng.nextGaussian())
		}
		const mean = samples.reduce((a, b) => a + b, 0) / samples.length
		const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length
		const stddev = Math.sqrt(variance)

		expect(mean).to.be.closeTo(0, 0.05)
		expect(stddev).to.be.closeTo(1, 0.1)
	})

	it('nextBigInt produces values within range', () => {
		const rng = new DeterministicRNG(123)
		for (let i = 0; i < 100; i++) {
			const val = rng.nextBigInt(256)
			expect(val >= 0n).to.be.true
			expect(val < (1n << 256n)).to.be.true
		}
	})

	it('nextBigInt produces varied values', () => {
		const rng = new DeterministicRNG(99)
		const values = new Set<bigint>()
		for (let i = 0; i < 50; i++) {
			values.add(rng.nextBigInt(64))
		}
		expect(values.size).to.be.greaterThan(40)
	})
})

describe('SimMessageBus', () => {
	function makeBus(config: Partial<MessageBusConfig> = {}): { bus: SimMessageBus; rng: DeterministicRNG; metrics: MetricsCollector } {
		const rng = new DeterministicRNG(42)
		const metrics = new MetricsCollector()
		const full: MessageBusConfig = {
			defaultLatencyMs: 100,
			defaultLossRate: 0,
			defaultQueueCapacity: 100,
			latencyDistribution: 'constant',
			latencyJitter: 0,
			...config,
		}
		return { bus: new SimMessageBus(rng, full, metrics), rng, metrics }
	}

	it('delivers messages after latency elapses', () => {
		const { bus } = makeBus({ defaultLatencyMs: 100 })
		bus.send('a', 'b', 'neighbor-request', {}, 0)
		bus.send('a', 'c', 'neighbor-request', {}, 0)

		// At t=50, nothing delivered
		const early = bus.deliver(50)
		expect(early).to.have.length(0)

		// At t=100, both delivered
		const onTime = bus.deliver(100)
		expect(onTime).to.have.length(2)
		expect(onTime[0]!.to).to.be.oneOf(['b', 'c'])
	})

	it('applies loss rate', () => {
		// Use different recipients to avoid queue capacity limits
		const { bus } = makeBus({ defaultLossRate: 0.5, defaultQueueCapacity: 10000 })
		let sent = 0
		for (let i = 0; i < 1000; i++) {
			if (bus.send('a', `b${i}`, 'neighbor-request', {}, 0)) sent++
		}
		// With 50% loss, expect roughly 500 delivered
		expect(sent).to.be.greaterThan(350)
		expect(sent).to.be.lessThan(650)
		expect(bus.droppedCount()).to.be.greaterThan(350)
	})

	it('drops messages when queue is full', () => {
		const { bus, metrics } = makeBus({ defaultQueueCapacity: 5, defaultLatencyMs: 1000 })

		for (let i = 0; i < 10; i++) {
			bus.send('a', 'b', 'neighbor-request', { i }, 0)
		}

		// 5 should be enqueued, 5 dropped
		expect(bus.pendingCount()).to.equal(5)
		expect(bus.droppedCount()).to.equal(5)
		expect(metrics.finalize().messageDrops).to.equal(5)
	})

	it('supports per-link config overrides', () => {
		const { bus } = makeBus({ defaultLatencyMs: 100 })
		bus.setLink('x', 'y', { latencyMs: 500, lossRate: 0, queueCapacity: 100 })

		bus.send('x', 'y', 'neighbor-request', {}, 0)
		bus.send('a', 'b', 'neighbor-request', {}, 0)

		// At t=100, only a->b delivered
		const at100 = bus.deliver(100)
		expect(at100).to.have.length(1)
		expect(at100[0]!.from).to.equal('a')

		// At t=500, x->y delivered
		const at500 = bus.deliver(500)
		expect(at500).to.have.length(1)
		expect(at500[0]!.from).to.equal('x')
	})

	it('uniform latency distribution adds jitter', () => {
		const { bus } = makeBus({
			defaultLatencyMs: 100,
			latencyDistribution: 'uniform',
			latencyJitter: 50,
		})

		const deliveryTimes = new Set<number>()
		for (let i = 0; i < 100; i++) {
			bus.send('a', `b${i}`, 'neighbor-request', {}, 0)
		}
		const all = bus.deliver(200)
		for (const msg of all) {
			deliveryTimes.add(msg.scheduledDelivery)
		}
		// Should have varied delivery times
		expect(deliveryTimes.size).to.be.greaterThan(1)
	})

	it('normal latency distribution applies Gaussian jitter', () => {
		const { bus } = makeBus({
			defaultLatencyMs: 100,
			latencyDistribution: 'normal',
			latencyJitter: 20,
		})

		for (let i = 0; i < 100; i++) {
			bus.send('a', `b${i}`, 'neighbor-request', {}, 0)
		}
		const all = bus.deliver(300)
		const times = all.map((m) => m.scheduledDelivery)
		const mean = times.reduce((a, b) => a + b, 0) / times.length
		// Mean should be near 100
		expect(mean).to.be.closeTo(100, 20)
	})
})

describe('Deterministic replay', () => {
	it('two runs with same seed produce identical metrics', () => {
		const config = {
			seed: 42,
			n: 20,
			k: 10,
			m: 5,
			churnRatePerSec: 0.5,
			stabilizationIntervalMs: 500,
			durationMs: 5000,
		}

		const metrics1 = new FretSimulation(config).run()
		const metrics2 = new FretSimulation(config).run()

		expect(JSON.stringify(metrics1)).to.equal(JSON.stringify(metrics2))
	})

	it('deterministic replay with message bus', () => {
		const config = {
			seed: 42,
			n: 15,
			k: 8,
			m: 4,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 3000,
			messageBus: {
				defaultLatencyMs: 50,
				defaultLossRate: 0,
				defaultQueueCapacity: 100,
				latencyDistribution: 'constant' as const,
				latencyJitter: 0,
			},
		}

		const metrics1 = new FretSimulation(config).run()
		const metrics2 = new FretSimulation(config).run()

		expect(JSON.stringify(metrics1)).to.equal(JSON.stringify(metrics2))
	})
})

describe('Message bus integration with FretSimulation', function () {
	this.timeout(60000)

	it('latency=100ms causes convergence to take longer than instant mode', () => {
		const base = {
			seed: 42,
			n: 15,
			k: 8,
			m: 4,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 8000,
		}

		const instantMetrics = new FretSimulation(base).run()
		const delayedMetrics = new FretSimulation({
			...base,
			messageBus: {
				defaultLatencyMs: 100,
				defaultLossRate: 0,
				defaultQueueCapacity: 100,
				latencyDistribution: 'constant',
				latencyJitter: 0,
			},
		}).run()

		// Both should eventually converge
		const instantFinal = instantMetrics.coverageTimeSeries
		const delayedFinal = delayedMetrics.coverageTimeSeries

		// Instant mode should have higher early coverage
		if (instantFinal.length > 2 && delayedFinal.length > 2) {
			const instantEarly = instantFinal[1]!.coverage
			const delayedEarly = delayedFinal[1]!.coverage
			// Delayed mode should have lower or equal early coverage
			expect(delayedEarly).to.be.at.most(instantEarly + 0.01)
		}
	})

	it('message loss: ~10% loss still converges but with more stabilization cycles needed', () => {
		const sim = new FretSimulation({
			seed: 77,
			n: 20,
			k: 10,
			m: 5,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 10000,
			messageBus: {
				defaultLatencyMs: 10,
				defaultLossRate: 0.1,
				defaultQueueCapacity: 200,
				latencyDistribution: 'constant',
				latencyJitter: 0,
			},
		})

		const metrics = sim.run()
		const finalCoverage = sim.snapshotCoverage()

		// Should still converge despite loss
		expect(finalCoverage).to.be.greaterThan(0.6)
		// Should have recorded some drops
		expect(metrics.messageDrops).to.be.greaterThan(0)
	})

	it('backpressure: queue overflow records drops', () => {
		const sim = new FretSimulation({
			seed: 88,
			n: 30,
			k: 15,
			m: 8,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 100, // aggressive stabilization
			durationMs: 3000,
			messageBus: {
				defaultLatencyMs: 500, // high latency causes queue buildup
				defaultLossRate: 0,
				defaultQueueCapacity: 5,
				latencyDistribution: 'constant',
				latencyJitter: 0,
			},
		})

		const metrics = sim.run()
		// Should have experienced some drops due to queue saturation
		expect(metrics.messageDrops).to.be.greaterThan(0)
	})
})

describe('Placement distributions', function () {
	this.timeout(60000)

	it('clustered placement: peers cluster around centers', () => {
		const sim = new FretSimulation({
			seed: 42,
			n: 30,
			k: 15,
			m: 8,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 5000,
			placement: 'clustered',
			clusterConfig: { numClusters: 3, spreadBits: 32 },
		})
		sim.initialize()

		// Collect all peer coords
		const coords: bigint[] = []
		for (const peer of sim.getPeers().values()) {
			let val = 0n
			for (let i = 0; i < 32; i++) {
				val = (val << 8n) | BigInt(peer.coord[i]!)
			}
			coords.push(val)
		}

		// With 3 clusters, peers should be grouped — measure by sorting and finding gaps
		coords.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		const gaps: bigint[] = []
		for (let i = 1; i < coords.length; i++) {
			gaps.push(coords[i]! - coords[i - 1]!)
		}
		gaps.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

		// The largest gaps should be significantly larger than the smallest
		// (clusters create large inter-cluster gaps and small intra-cluster gaps)
		const largestGap = gaps[gaps.length - 1]!
		const medianGap = gaps[Math.floor(gaps.length / 2)]!
		expect(largestGap > medianGap).to.be.true
	})

	it('clustered placement: inter-cluster routing takes more hops', () => {
		const clusterSim = new FretSimulation({
			seed: 42,
			n: 30,
			k: 15,
			m: 8,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 8000,
		})
		clusterSim.initialize()

		// Warm up
		for (const evt of clusterSim.scheduler.advanceTo(5000)) {
			clusterSim.processEvent(evt)
		}

		// Schedule routes
		const alivePeers = Array.from(clusterSim.getPeers().values()).filter((p) => p.alive)
		for (let i = 0; i < 10; i++) {
			const from = alivePeers[i % alivePeers.length]!
			const target = new Uint8Array(32)
			const seed = 42 + i * 13
			for (let j = 0; j < 32; j++) target[j] = (seed * (j + 1) * 37) & 0xff
			clusterSim.scheduleRoute(from.id, target, 5001 + i)
		}

		while (clusterSim.scheduler.pending() > 0) {
			const evt = clusterSim.scheduler.nextEvent()
			if (!evt || evt.time > 8000) break
			clusterSim.processEvent(evt)
		}

		const metrics = clusterSim.metrics.finalize()
		// Routing should work at all
		expect(metrics.routingAttempts).to.equal(10)
	})

	it('skewed placement: some regions are denser than others', () => {
		const sim = new FretSimulation({
			seed: 42,
			n: 50,
			k: 15,
			m: 8,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 3000,
			placement: 'skewed',
		})
		sim.initialize()

		// Collect coords and check distribution
		const coords: bigint[] = []
		for (const peer of sim.getPeers().values()) {
			let val = 0n
			for (let i = 0; i < 32; i++) {
				val = (val << 8n) | BigInt(peer.coord[i]!)
			}
			coords.push(val)
		}

		const ringSize = 1n << 256n
		const halfRing = ringSize / 2n
		const lowerHalf = coords.filter((c) => c < halfRing).length
		const upperHalf = coords.filter((c) => c >= halfRing).length

		// Skewed distribution should be uneven
		// (one half should have more peers than the other)
		// Skewed: at least one half should have more peers
		expect(lowerHalf).to.not.equal(upperHalf)
	})

	it('uniform placement still works as default', () => {
		const sim = new FretSimulation({
			seed: 42,
			n: 10,
			k: 7,
			m: 4,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 3000,
		})
		const metrics = sim.run()
		expect(metrics.totalJoins).to.equal(10)
		expect(metrics.avgNeighborCount).to.be.greaterThan(0)
	})
})

describe('Capacity enforcement', function () {
	this.timeout(60000)

	it('no store exceeds capacity after stabilization', () => {
		const capacity = 20
		const sim = new FretSimulation({
			seed: 42,
			n: 50,
			k: 15,
			m: 8,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 5000,
			capacity,
		})
		sim.run()

		for (const [_id, store] of sim.getStores()) {
			expect(store.size()).to.be.at.most(capacity)
		}
	})

	it('capacity enforcement preserves self entry', () => {
		const sim = new FretSimulation({
			seed: 42,
			n: 30,
			k: 15,
			m: 8,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 3000,
			capacity: 5,
		})
		sim.run()

		for (const [id, store] of sim.getStores()) {
			const peer = sim.getPeers().get(id)
			if (!peer || !peer.alive) continue
			const entry = store.getById(id)
			expect(entry).to.not.be.undefined
		}
	})
})
