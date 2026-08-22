import { describe, it } from 'mocha'
import { expect } from 'chai'
import { DeterministicRNG } from './simulation/deterministic-rng.js'
import { SimMessageBus, type MessageBusConfig } from './simulation/message-bus.js'
import { MetricsCollector } from './simulation/sim-metrics.js'
import { FretSimulation, type SimConfig } from './simulation/fret-sim.js'
import {
	coordToBigInt,
	maxPeersInOneSpacingArc,
	nearestAlivePeerTo,
	PLACEMENT_SEEDS,
} from './simulation/placement-assertions.js'
import { toCoord } from './helpers/ring.js'
import { pump } from './simulation/pump.js'

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

describe('Deterministic replay', function () {
	// Each test runs two full FretSimulations back-to-back (CPU-bound, ~1.4s in
	// isolation). Like the other simulation-heavy blocks in this file, lift the
	// per-test timeout off the 2000ms default so full-suite CPU contention can't
	// trip a spurious timeout.
	this.timeout(60000)

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
		function reading(placement?: 'clustered', seed = 42): number {
			const sim = new FretSimulation({
				seed,
				n: 30,
				k: 15,
				m: 8,
				churnRatePerSec: 0,
				stabilizationIntervalMs: 500,
				durationMs: 5000,
				...(placement
					? { placement, clusterConfig: { numClusters: 3, spreadBits: 32 } }
					: {}),
			})
			sim.initialize()
			while (sim.scheduler.pending() > 0) {
				const evt = sim.scheduler.nextEvent()
				if (!evt || evt.time > 5000) break
				sim.processEvent(evt)
			}
			const alive = Array.from(sim.getPeers().values()).filter((p) => p.alive)
			return maxPeersInOneSpacingArc(alive.map((p) => coordToBigInt(p.coord)))
		}

		// Measured 2026-08-21 over PLACEMENT_SEEDS at n=30 / k=15 / m=8 / stabilize 500ms / 5s:
		//
		//   seed    uniform   clustered
		//   8008    1         13
		//   8009    1         12
		//   8010    1         15
		//   4242    1         17
		//   99      1         12
		//
		// Worst uniform reading 1, best clustered reading 12 — wide gap. 5 sits 5x above the worst
		// uniform reading and 2.4x below the best clustered one, same margin-on-both-sides reasoning
		// as MAX_PEERS_IN_ONE_SPACING_ARC in placement-assertions.ts. Both arms asserted below, so
		// the threshold's separating power is re-proved on every run rather than measured once here.
		const CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC = 5

		for (const seed of PLACEMENT_SEEDS) {
			const clustered = reading('clustered', seed)
			const uniform = reading(undefined, seed)
			console.log(
				`  clustered vs uniform seed ${seed}: clustered ${clustered}, uniform ${uniform}` +
					` (threshold ${CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC})`
			)
			expect(uniform).to.be.at.most(CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC)
			expect(clustered).to.be.greaterThan(CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC)
		}
	})

	it('clustered placement: inter-cluster routing takes more hops', function () {
		this.timeout(300000)

		// Three things have to be true at once for this to measure anything; the two earlier
		// shapes of this test measured nothing at all (see the review ticket).
		//
		//  - The store must be *bounded*, or every peer holds every other peer and the
		//    originator is already the target's anchor in its own store — a one-hop "route"
		//    whatever the placement. `enforceCapacity` mirrors production, where protection
		//    outranks the cap, so a capacity below 2m+1 = 17 is simply not enforced; that needs
		//    an n far larger than the first test's 30. n=300 / capacity 32 is ~10.7% of the
		//    population, the same bounded regime `simulation.routing.spec.ts` measures.
		//  - Targets must be aimed at *real* cluster centers (`getClusterCenters`), and the
		//    uniform arm must route between the same two coordinates under the same
		//    sender-selection rule, or the arms differ by more than their placement.
		//  - Convergence must use the routing spec's pump to CONVERGE_MS rather than draining
		//    `durationMs`. That spec measured store contents flat from t=2000 to t=20000, and
		//    draining 60s of stabilization ticks over 300 peers takes minutes per sim.
		//
		// Measured 2026-08-21 over PLACEMENT_SEEDS; every arm 10/10 successful at store size 32:
		//
		//   seed    clustered   uniform   margin
		//   8008    4.90        2.30      2.60
		//   8009    5.00        2.60      2.40
		//   8010    7.10        2.00      5.10
		//   4242    4.80        2.00      2.80
		//   99      6.70        3.10      3.60
		//
		// Smallest observed margin 2.40 hops, so MIN_HOP_MARGIN of 1.5 sits 1.6x inside it and
		// far above noise — the assertion is a measured separation rather than a coin flip. The
		// store size and success count are asserted per run too, since a silently-unbounded
		// store is exactly what made the earlier versions vacuous.
		//
		// What this does *not* discriminate: the sim's near radius is 4k/store.size() of the
		// ring (see `nearRadiusFor` in fret-sim.ts), so at k=15 over a 32-entry store it clamps
		// to half the ring and every candidate takes the selector's near branch. This measures
		// the distance metric and the placement, not the cost function's slack constants.
		// spreadBits stays at 32: `CoordPlacement.clusteredCoord` scales its Gaussian offset
		// through a JS float, so it is only exact to ~52 bits.
		const N = 300
		const NUM_CLUSTERS = 3
		const SPREAD_BITS = 32
		const CAPACITY = 32
		const CONVERGE_MS = 4000
		const ROUTES = 10
		const MIN_HOP_MARGIN = 1.5

		function cfgFor(seed: number, placement: 'uniform' | 'clustered'): SimConfig {
			return {
				seed,
				n: N,
				k: 15,
				m: 8,
				churnRatePerSec: 0,
				stabilizationIntervalMs: 500,
				durationMs: 60000,
				placement,
				// Passed on the uniform arm too, where it is unused: the two configs then differ
				// by `placement` alone, which is the point of the control.
				clusterConfig: { numClusters: NUM_CLUSTERS, spreadBits: SPREAD_BITS },
				capacity: CAPACITY,
			}
		}

		/**
		 * The clustered arm reports the centers it placed itself; the uniform arm must be handed
		 * those same centers rather than deriving its own. That is what makes the uniform run a
		 * control: identical coordinates and identical origin-selection rule, only the placement
		 * differs. Letting the uniform arm pick its own centers would destroy the control — and
		 * building a throwaway clustered sim purely to read the centers off costs a third of the
		 * sweep's 300-peer initializations for nothing.
		 */
		function measure(
			seed: number,
			placement: 'uniform' | 'clustered',
			given?: readonly bigint[]
		) {
			const sim = new FretSimulation(cfgFor(seed, placement))
			sim.initialize()

			let centers: readonly bigint[]
			if (placement === 'clustered') {
				const own = sim.getClusterCenters()
				expect(own, 'clustered placement must expose its centers').to.exist
				centers = own!
			} else {
				expect(given, 'uniform arm must be given the clustered centers').to.exist
				centers = given!
			}

			pump(sim, CONVERGE_MS)

			const alive = Array.from(sim.getPeers().values()).filter((p) => p.alive)
			let firstSender: string | undefined
			for (let i = 0; i < ROUTES; i++) {
				const from = nearestAlivePeerTo(alive, centers[i % centers.length]!)!
				const to = centers[(i + 1) % centers.length]!
				firstSender ??= from
				sim.scheduleRoute(from, toCoord(to), CONVERGE_MS + 10 + i)
			}
			pump(sim, CONVERGE_MS + 10 + ROUTES)

			const metrics = sim.metrics.finalize()
			return {
				hops: metrics.avgRoutingHops,
				succeeded: metrics.successfulRouteHops.length,
				attempts: metrics.routingAttempts,
				// NOTE: sampled from the first sender only. One sample is enough for what the
				// assertion claims — that the store bound actually bit — and every peer in the
				// sweep is enforced against the same capacity.
				storeSize: sim.getStores().get(firstSender!)?.size() ?? -1,
				centers,
			}
		}

		for (const seed of PLACEMENT_SEEDS) {
			const clustered = measure(seed, 'clustered')
			const uniform = measure(seed, 'uniform', clustered.centers)
			console.log(
				`  routing seed ${seed}: clustered ${clustered.hops.toFixed(2)} hops ` +
					`(${clustered.succeeded}/${clustered.attempts}, store ${clustered.storeSize}), ` +
					`uniform ${uniform.hops.toFixed(2)} hops ` +
					`(${uniform.succeeded}/${uniform.attempts}, store ${uniform.storeSize})`
			)

			for (const [label, arm] of [
				['clustered', clustered],
				['uniform', uniform],
			] as const) {
				expect(arm.attempts, `${label} seed ${seed} attempts`).to.equal(ROUTES)
				expect(arm.succeeded, `${label} seed ${seed} successes`).to.equal(ROUTES)
				// Proof the bound actually bit: unbounded, the store holds all 300 peers and
				// every route is one hop.
				expect(arm.storeSize, `${label} seed ${seed} store size`).to.equal(CAPACITY)
			}

			expect(clustered.hops, `seed ${seed}: clustered vs uniform hops`).to.be.greaterThan(
				uniform.hops + MIN_HOP_MARGIN
			)
		}
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

		// The power-law concentrates mass at the low end of the ring, so the lower
		// half must hold substantially more peers than the upper half. A mere
		// `lowerHalf !== upperHalf` check would also pass for a *uniform* layout
		// (which almost never splits exactly evenly), so assert a real imbalance.
		expect(lowerHalf).to.be.greaterThan(Math.floor(upperHalf * 1.5))
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
