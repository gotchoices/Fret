import { describe, it } from 'mocha'
import { expect } from 'chai'
import { FretSimulation, type SimConfig } from './simulation/fret-sim.js'
import { percentileSummary } from './simulation/sim-metrics.js'
import { DeterministicRNG } from './simulation/deterministic-rng.js'
import { chooseNextHop } from '../src/selector/next-hop.js'

/**
 * Does ring routing actually work?
 *
 * Every other simulation spec measures ring *maintenance* — coverage, neighbor-set purity,
 * convergence — and none of them could fail if next-hop selection were wrong, because until
 * `sim-route-local-selector` the harness reimplemented hop choice against its own all-seeing
 * view. The sim now routes hop by hop through the shipped `chooseNextHop` over each peer's own
 * store, so the numbers below are statements about `src/selector/next-hop.ts`.
 *
 * ── What these thresholds do and do not guard ────────────────────────────────────────────
 *
 * **The hop-count bound is the sensitive measure; the success rate is not.** Measured
 * 2026-08-20 by substituting a deliberately wrong metric into the selector and re-running
 * these exact cases (100 routes each, seeds 1 / 4242 / 99 / 20260820):
 *
 * | selector distance function          | success  | p90 hops  | max hops |
 * |-------------------------------------|----------|-----------|----------|
 * | `minDistance` (shipped)             | 95–100%  | **2**     | 3        |
 * | preference inverted (farthest wins) | 99%      | **17–20** | 22       |
 * | `clockwiseDistance` substituted     | 100%     | 2         | 3        |
 * | XOR distance substituted            | 94–98%   | 2–3       | 3        |
 *
 * So this spec bites hard on a selector that routes in the *wrong direction* — p90 moves by an
 * order of magnitude, far outside any seed variation — and the assertions sit in that gap.
 * Note the success rate barely moved even then: the attempt budget absorbs a bad route until it
 * stumbles onto the target, which is exactly why the hop bound carries the guard.
 *
 * It deliberately does **not** claim to discriminate one plausible ring metric from another.
 * The last two rows are the evidence: substituting clockwise-only distance, or XOR, barely
 * moves either number. That is a property of the harness, not a defect in these assertions.
 * The sim's stores are unbounded and its gossip merges every neighbor's window each tick, so a
 * peer ends up knowing a large, near-uniform slice of the ring (63% at n=200, 19% at n=1000 —
 * each case logs its own figure). Greedy routing over knowledge that dense reaches the target's
 * anchor in one or two hops under *any* metric even loosely monotone in ring position, so there
 * is no gap between plausible metrics left to measure. Discriminating them needs stores that are
 * sparse and finger-shaped, which needs the sim's eviction to stop being degenerate — see the
 * NOTE at `FretSimulation.enforceCapacity`, where every entry ties at relevance 0 and eviction
 * collapses to ring order. That is the prerequisite, and it is also why `capacity` is left unset
 * here rather than used as a sparsity knob: today it would evict a contiguous arc from every
 * store and this spec would measure eviction rather than routing.
 */

/** Big-endian bigint → 32-byte ring coordinate. Mirrors the module-private helper in fret-sim.ts. */
function coordFromBigInt(val: bigint): Uint8Array {
	const coord = new Uint8Array(32)
	let v = val
	for (let i = 31; i >= 0; i--) {
		coord[i] = Number(v & 0xffn)
		v >>= 8n
	}
	return coord
}

/** Drive every event scheduled up to `uptoMs`, one at a time, then park the clock there. */
function pump(sim: FretSimulation, uptoMs: number): void {
	while ((sim.scheduler.peek()?.time ?? Infinity) <= uptoMs) {
		sim.processEvent(sim.scheduler.nextEvent()!)
	}
	sim.scheduler.advanceTo(uptoMs)
}

function baseConfig(overrides: Partial<SimConfig> = {}): SimConfig {
	return {
		seed: 4242,
		n: 200,
		k: 15,
		m: 8,
		churnRatePerSec: 0,
		stabilizationIntervalMs: 500,
		durationMs: 60000,
		...overrides,
	}
}

/**
 * Store contents stop growing after ~4 simulated seconds at a 500 ms tick — measured flat from
 * t=2000 through t=20000 at n=200 — so a longer convergence window costs runtime and changes
 * nothing.
 */
const CONVERGE_MS = 4000
const ROUTE_COUNT = 100

/**
 * Both thresholds sit in the gap in the table above: healthy runs measure 95–100% success and
 * p90 2 across four seeds, a wrong-direction selector measures p90 17–20. log2(1000) ≈ 10, so 6
 * is also inside the O(log N) claim the bound is meant to express.
 */
const MIN_SUCCESS_RATE = 0.9
const MAX_P90_HOPS = 6

interface RouteResult {
	successRate: number
	p90Hops: number
	maxHops: number
	attempts: number
	knowledgeFraction: number
}

/** Converge the ring, then fire `ROUTE_COUNT` routes from random live peers to random coordinates. */
function measureRouting(config: SimConfig): RouteResult {
	const sim = new FretSimulation(config)
	sim.initialize()
	pump(sim, CONVERGE_MS)

	const sizes = Array.from(sim.getStores().values()).map((s) => s.size())
	const meanSize = sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length)

	// Routes fire one millisecond apart, well inside durationMs.
	const rng = new DeterministicRNG(config.seed + 1)
	const liveIds = Array.from(sim.getPeers().values())
		.filter((p) => p.alive)
		.map((p) => p.id)
	for (let i = 0; i < ROUTE_COUNT; i++) {
		const from = liveIds[rng.nextInt(0, liveIds.length)]!
		sim.scheduleRoute(from, coordFromBigInt(rng.nextBigInt(256)), CONVERGE_MS + 10 + i)
	}
	pump(sim, CONVERGE_MS + 10 + ROUTE_COUNT)

	const m = sim.metrics.finalize()
	// p90 over *successful* routes only: a failed route contributes the partial path it managed
	// before giving up, so including failures makes the bound look better the more routes fail.
	const hops = percentileSummary(m.successfulRouteHops)
	return {
		successRate: m.routingSuccessRate,
		p90Hops: hops.p90,
		maxHops: hops.max,
		attempts: m.routingAttempts,
		knowledgeFraction: meanSize / config.n,
	}
}

function report(label: string, r: RouteResult): void {
	console.log(
		`  ${label}: knows ${(r.knowledgeFraction * 100).toFixed(1)}% of the ring, ` +
			`success ${(r.successRate * 100).toFixed(1)}%, p90 hops ${r.p90Hops}, max ${r.maxHops}`,
	)
}

describe('Ring routing through the shipped selector', function () {
	this.timeout(120000)

	it('a converged ring routes to random coordinates reliably and in few hops', () => {
		// MEASURED (seeds 1 / 4242 / 99 / 20260820): success 96–100%, p90 2, max 2.
		const r = measureRouting(baseConfig())
		report('dense n=200', r)

		expect(r.attempts, 'every scheduled route must have fired').to.equal(ROUTE_COUNT)
		expect(r.successRate, 'converged routing success').to.be.at.least(MIN_SUCCESS_RATE)
		expect(r.p90Hops, 'p90 hop count on a converged 200-peer ring').to.be.at.most(MAX_P90_HOPS)
	})

	it('a larger, sparser ring still routes in O(log N) hops', () => {
		// The all-edge profile at n=1000 leaves each peer knowing ~19% of the ring rather than
		// ~63%, so this is the case where routing is genuinely multi-hop.
		// MEASURED (same four seeds): success 95–99%, p90 2, max 3.
		const r = measureRouting(baseConfig({ n: 1000, profileMix: { edge: 1, core: 0 } }))
		report('sparse n=1000', r)

		expect(r.knowledgeFraction, 'this case is only interesting while knowledge stays partial')
			.to.be.below(0.5)
		expect(r.successRate, 'sparse routing success').to.be.at.least(MIN_SUCCESS_RATE)
		expect(r.p90Hops, 'p90 hop count on a 1000-peer ring').to.be.at.most(MAX_P90_HOPS)
	})

	it('routing under churn degrades gracefully rather than collapsing', () => {
		// MEASURED (same four seeds): success 97–99%, p90 2, max 3.
		const r = measureRouting(
			baseConfig({ n: 1000, profileMix: { edge: 1, core: 0 }, churnRatePerSec: 20 }),
		)
		report('sparse n=1000, churn 20/s', r)

		expect(r.successRate, 'routing success under churn').to.be.at.least(MIN_SUCCESS_RATE)
		expect(r.p90Hops, 'p90 hop count under churn').to.be.at.most(MAX_P90_HOPS)
	})

	it('a route whose originator is already the peer nearest the target still succeeds', () => {
		// The strict-improvement floor makes a hop no closer to the key ineligible. Production
		// applies it only when *forwarding* — an originator aiming at a key's cluster is
		// legitimately farther from the key than every member of that cluster — so the sim
		// supplies selfCoord from the second hop onward. Without that split, a route whose
		// source is itself the nearest peer has no eligible first hop and fails, and the
		// aggregate cases above would hide it as a couple of percent.
		const sim = new FretSimulation(baseConfig())
		sim.initialize()
		pump(sim, CONVERGE_MS)

		const rng = new DeterministicRNG(99)
		const peers = Array.from(sim.getPeers().values()).filter((p) => p.alive)
		for (let i = 0; i < 20; i++) {
			const target = coordFromBigInt(rng.nextBigInt(256))
			const nearest = nearestByCoord(peers, target)
			const before = sim.metrics.getMetrics().routingSuccesses
			sim.scheduleRoute(nearest.id, target, CONVERGE_MS + 100 + i)
			pump(sim, CONVERGE_MS + 100 + i)
			expect(
				sim.metrics.getMetrics().routingSuccesses,
				`originator-nearest route ${i} from ${nearest.id}`,
			).to.equal(before + 1)
		}
	})
})

/** Ring-nearest peer to a coordinate, by the same shorter-arc metric the selector uses. */
function nearestByCoord(peers: { id: string; coord: Uint8Array }[], target: Uint8Array) {
	let best = peers[0]!
	let bestDist = ringDistance(best.coord, target)
	for (const p of peers.slice(1)) {
		const d = ringDistance(p.coord, target)
		if (d < bestDist) {
			best = p
			bestDist = d
		}
	}
	return best
}

function toBigInt(u8: Uint8Array): bigint {
	let v = 0n
	for (const b of u8) v = (v << 8n) | BigInt(b)
	return v
}

function ringDistance(a: Uint8Array, b: Uint8Array): bigint {
	const RING = 1n << 256n
	const cw = (toBigInt(b) - toBigInt(a) + RING) % RING
	return cw < RING - cw ? cw : RING - cw
}
