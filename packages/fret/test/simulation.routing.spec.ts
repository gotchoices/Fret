import { describe, it } from 'mocha'
import { expect } from 'chai'
import { FretSimulation, type SimConfig } from './simulation/fret-sim.js'
import { percentileSummary } from './simulation/sim-metrics.js'
import { DeterministicRNG } from './simulation/deterministic-rng.js'
import { chooseNextHop } from '../src/selector/next-hop.js'
import { refMinDistance, toCoord } from './helpers/ring.js'

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
 * ── Telling one plausible ring metric from another ─────────────────────────────────────
 *
 * **Retracted 2026-08-21.** This doc-block used to say the spec could not discriminate one
 * plausible ring metric from another. That is still true of the three *unbounded* cases above —
 * their stores are unbounded and gossip merges every neighbor's window each tick, so a peer ends
 * up knowing a large, near-uniform slice of the ring (63% at n=200, 19% at n=1000 — each case
 * logs its own figure), and greedy routing over knowledge that dense reaches the target's anchor
 * in one or two hops under *any* metric even loosely monotone in ring position. It is **not**
 * true of the capacity-bounded case below, which holds each store to 32 entries (3.2% of a
 * 1000-peer ring) and is genuinely multi-hop.
 *
 * Measured 2026-08-21 by substituting `minDistance` in `src/ring/distance.ts` and re-running
 * this file's config at `n: 1000`, all-edge, 100 routes, `capacity` as shown, seed 4242. p90 and
 * max are over **successful routes only** (`successfulRouteHops`), which matters below:
 *
 * | metric                  | cap | knowledge | success | p90 | max |
 * |-------------------------|-----|-----------|---------|-----|-----|
 * | `minDistance` (shipped) | 24  | 2.4%      | 99%     | 14  | 23  |
 * | `minDistance` (shipped) | 28  | 2.8%      | 100%    | 11  | 15  |
 * | `minDistance` (shipped) | 32  | 3.2%      | 100%    |  8  | 19  |
 * | clockwise-only          | 24  | 2.4%      | 83%     | 21  | 23  |
 * | clockwise-only          | 28  | 2.8%      | 81%     | 19  | 23  |
 * | clockwise-only          | 32  | 3.2%      | 83%     | 18  | 23  |
 * | XOR                     | 24  | 2.4%      | 53%     |  8  | 13  |
 * | XOR                     | 28  | 2.8%      | 60%     |  6  |  9  |
 * | XOR                     | 32  | 3.2%      | 71%     |  6  |  9  |
 *
 * Confirmed across seeds 1 / 4242 / 99 / 20260820 at cap 32: shipped 100% success on all four
 * at p90 7–8; clockwise-only 83–90% at p90 17–21; XOR 60–77% at p90 5–7.
 *
 * **Caveat — those rows are not a pure selector comparison.** There is no injection seam
 * (`chooseNextHop` imports `minDistance` directly), so the substitution was made in
 * `src/ring/distance.ts`, and `minDistance` is not selector-only: the relevance sparsity model
 * reads it too (`normalizedLogDistance` in `src/store/relevance.ts`, which this harness calls
 * from `scoreMerge`, `touch` and its self-seed). Each substituted row therefore changes eviction
 * shape as well as hop choice. That is enough to demonstrate a wrong metric is *detectable*, and
 * it is how the 2026-08-20 table above was produced too, but it does not isolate the selector.
 * (`nearRadiusFor` is not one of those readers — it is pure ring arithmetic and calls no
 * distance function; what a substitution changes there is the meaning of the comparison made
 * against the radius, not the radius itself.)
 *
 * **The two wrong metrics are caught by two different assertions, so the case needs both.** A
 * hop bound alone cannot catch XOR: its p90 is *lower* than the shipped metric's (5–7 vs 7–8 at
 * cap 32), because p90 is taken over successful routes only and XOR simply *fails* the hard
 * routes — its survivors are the easy ones, so its hop distribution flatters it. Clockwise-only
 * fails the other way: it keeps most routes alive (83–90%) but drags them the long way round the
 * ring. So the p90 upper bound catches clockwise-only, and the success floor catches XOR.
 */

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

/**
 * Bounds for the capacity-bounded case alone. Deliberately **separate constants**, not a
 * loosening of the two above: every unbounded case still asserts p90 ≤ 6, while the shipped
 * metric measures p90 7–8 on a 32-entry store and so cannot meet that bound. What these two
 * express is the gap in the substitution table in this file's doc-block, one assertion per wrong
 * metric — 0.95 sits 5 points below the shipped 100% and 5 above clockwise-only's worst 90%;
 * 12 sits 50% above the shipped worst p90 of 8 and 5 below clockwise-only's best of 17.
 */
const CAPPED_MIN_SUCCESS_RATE = 0.95
const CAPPED_MAX_P90_HOPS = 12

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
		sim.scheduleRoute(from, toCoord(rng.nextBigInt(256)), CONVERGE_MS + 10 + i)
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

	it('a capacity-bounded sparse ring tells the shipped ring metric from a wrong one', () => {
		// MEASURED 2026-08-21 (seeds 1 / 4242 / 99 / 20260820): 100% success on all four, p90 7–8,
		// knowledge 3.2%. Both assertions are load-bearing and each catches a different wrong
		// metric — see the substitution table in this file's doc-block. `capacity` bounds each
		// store to 32 entries, which is what makes routing here genuinely multi-hop; the three
		// cases above leave it unset on purpose, since at their store sizes no metric is
		// distinguishable from any other.
		const r = measureRouting(baseConfig({ n: 1000, profileMix: { edge: 1, core: 0 }, capacity: 32 }))
		report('capped n=1000, capacity 32', r)

		expect(r.attempts, 'every scheduled route must have fired').to.equal(ROUTE_COUNT)
		// The cap is the ceiling, so knowledge cannot exceed capacity/n = 3.2%; in practice every
		// store reaches it and the reported figure is 3.2% exactly (observed on the shipped metric
		// and on both substituted ones). The bound is asserted against the ceiling, not against
		// that observation, so a run that merely fails to saturate still passes here.
		expect(r.knowledgeFraction, 'the cap is what makes this case sparse').to.be.below(0.05)
		// Catches XOR (60–77% success), and clockwise-only (83–90%) a second time.
		expect(r.successRate, 'capacity-bounded sparse routing success')
			.to.be.at.least(CAPPED_MIN_SUCCESS_RATE)
		// Catches clockwise-only (p90 17–21). Deliberately vacuous for XOR, whose p90 sits *below*
		// the shipped metric's — the success floor is the only assertion holding that one.
		expect(r.p90Hops, 'p90 hop count on a capacity-bounded 1000-peer ring')
			.to.be.at.most(CAPPED_MAX_P90_HOPS)
		// Headroom claim, not a guard: a worse metric moves p90 *up*, away from this. It states
		// that the case is multi-hop at all — the role `knowledgeFraction < 0.5` plays above.
		expect(r.p90Hops, 'this case is only interesting while routing is multi-hop').to.be.at.least(3)
	})

	it('an originator already nearest the key has no strictly-improving first hop', () => {
		// The strict-improvement floor makes a hop no closer to the key ineligible. Production
		// applies it only when *forwarding* — an originator aiming at a key's cluster is
		// legitimately farther from the key than every member of that cluster — so the sim
		// supplies `selfCoord` from the second hop onward (`fret-sim.ts`, `handleRoute`).
		//
		// This asserts on that hop-0 selector call directly rather than through a route
		// outcome, because **a route cannot reach it**: a peer nearest a coordinate is that
		// coordinate's anchor in its own store, so `handleRoute` records success at hop 0 and
		// never calls the selector. Measured 2026-08-20 — the route-level version of this case
		// completed all 20 of its routes at hop 0, and deleting the `hops > 0` split left every
		// one of them passing, so it pinned nothing. What is reachable, and what this pins, is
		// the rule's *price*: with `selfCoord` supplied such an originator has no eligible
		// candidate at all, and only withholding it lets the message leave.
		//
		// Consequence worth stating: the sim's own `hops > 0` split is therefore unpinned by
		// any route here. It can only bite when the entries nearer the key in the originator's
		// store are all `dead` (the pool is `notDead`-filtered while the anchor check is not),
		// which is a partition-shaped scenario rather than a routing one.
		const cfg = baseConfig()
		const sim = new FretSimulation(cfg)
		sim.initialize()
		pump(sim, CONVERGE_MS)

		const rng = new DeterministicRNG(99)
		const peers = Array.from(sim.getPeers().values()).filter((p) => p.alive)
		// The floor is applied *before* the near/far partition, so the radius cannot change the
		// outcome; a whole-ring radius keeps the assertion independent of which branch runs.
		const wholeRing = toCoord(1n << 255n)

		for (let i = 0; i < 20; i++) {
			const target = toCoord(rng.nextBigInt(256))
			const nearest = nearestByCoord(peers, target)
			const store = sim.getStores().get(nearest.id)!
			// The same pool `handleRoute` builds for its first hop, minus self.
			const pool = [
				...store.neighborsRight(target, cfg.m, (e) => e.state !== 'dead'),
				...store.neighborsLeft(target, cfg.m, (e) => e.state !== 'dead'),
			].filter((id) => id !== nearest.id)
			const connected = (id: string) => nearest.connected.has(id)
			const opts = { nearRadius: wholeRing, confidence: 0.5 }

			expect(pool, `case ${i} must offer candidates for the floor to reject`).to.not.be.empty
			expect(
				chooseNextHop(store, target, pool, connected, () => 0, {
					...opts,
					selfCoord: nearest.coord,
				}),
				`forwarding rule at hop 0 strands originator-nearest case ${i} (${nearest.id})`,
			).to.equal(undefined)
			expect(
				chooseNextHop(store, target, pool, connected, () => 0, opts),
				`originator ${nearest.id} must still get a first hop without the floor`,
			).to.be.a('string')
		}
	})
})

/**
 * Ring-nearest peer to a coordinate, by the shorter-arc metric.
 *
 * Deliberately measured with the reference bigint arithmetic in `test/helpers/ring.ts` rather
 * than `src/ring/distance.ts`: this selects the *case* the selector is then asked about, so an
 * independent
 * implementation makes the assertion a cross-check — if the two disagreed about which peer is
 * nearest, the strict-improvement assertion fails loudly. Selecting the case with the selector's
 * own helper would make that agreement an assumption instead of a result.
 */
function nearestByCoord<T extends { id: string; coord: Uint8Array }>(peers: T[], target: Uint8Array): T {
	let best = peers[0]!
	let bestDist = refMinDistance(best.coord, target)
	for (const p of peers.slice(1)) {
		const d = refMinDistance(p.coord, target)
		if (d < bestDist) {
			best = p
			bestDist = d
		}
	}
	return best
}
