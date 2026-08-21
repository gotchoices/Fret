import { describe, it } from 'mocha'
import { expect } from 'chai'
import { DigitreeStore } from '../src/store/digitree-store.js'
import { estimateSizeAndConfidence } from '../src/estimate/size-estimator.js'
import { DeterministicRNG } from './simulation/deterministic-rng.js'
import { toCoord } from './helpers/ring.js'

const RING_SIZE = 1n << 256n

// --- Coordinate generation helpers ---

/** Evenly spaced coords: i * (2^256 / n) */
function uniformCoords(n: number): Uint8Array[] {
	const step = RING_SIZE / BigInt(n)
	return Array.from({ length: n }, (_, i) => toCoord(BigInt(i) * step))
}

/** Peers placed only in a fraction of the ring (e.g., 60%), leaving a large empty gap */
function gappedCoords(n: number, fraction: number = 0.6): Uint8Array[] {
	const arc = (RING_SIZE * BigInt(Math.floor(fraction * 1000))) / 1000n
	const step = arc / BigInt(n)
	return Array.from({ length: n }, (_, i) => toCoord(BigInt(i) * step))
}

/** Exponential distribution — most peers near origin, thinning out */
function skewedCoords(n: number, rng: DeterministicRNG): Uint8Array[] {
	const coords: Uint8Array[] = []
	for (let i = 0; i < n; i++) {
		// Exponential: -ln(U) / lambda, normalized to ring
		const u = Math.max(1e-15, rng.next())
		const x = -Math.log(u) / 5 // lambda=5 concentrates near 0
		const frac = Math.min(x, 1) // clamp to [0,1]
		const pos = (RING_SIZE * BigInt(Math.floor(frac * 1e15))) / BigInt(1e15)
		coords.push(toCoord(pos))
	}
	return coords
}

/** Random uniform 32-byte coordinates */
function randomUniformCoords(n: number, rng: DeterministicRNG): Uint8Array[] {
	return Array.from({ length: n }, () => toCoord(rng.nextBigInt(256)))
}

function populateStore(coords: Uint8Array[]): DigitreeStore {
	const store = new DigitreeStore()
	for (let i = 0; i < coords.length; i++) {
		store.upsert(`p${i}`, coords[i]!)
	}
	return store
}

function relativeError(estimate: number, actual: number): number {
	return Math.abs(estimate - actual) / actual
}

// --- Tests ---

describe('Size estimator', () => {
	// Parity check for the `windowGaps` migration onto `ringNeighborsBothSides`: the window must
	// still be self + m successors + m predecessors, i.e. G = 2m gaps at the default m. G is not
	// exposed, so it is pinned through the confidence formula, which is a closed form in G on an
	// evenly-spaced ring: cv = 0, so cvEff = 1, dispersion = 1 - 1/sqrt(G), and with the store
	// well past 2m entries sizeFactor = 1, giving confidence = 0.5 + 0.5*(1 - 1/sqrt(G)). At
	// G = 16 that is exactly 0.875 (the figure docs/fret.md quotes); losing the anchor slot on
	// each side would give G = 14 and 0.8664, and asking each side for m + 1 twice over would
	// give G = 18 and 0.8821.
	it('the S/P window is 2m gaps at the default m, unchanged by the ring-walk migration', () => {
		const m = 8
		const coords = uniformCoords(64)
		const store = populateStore(coords)
		const est = estimateSizeAndConfidence(store, m, { self: { coord: coords[0]!, id: 'p0' } })
		expect(est.confidence, 'G = 2m = 16 on an evenly spaced ring').to.be.closeTo(0.5 + 0.5 * (1 - 1 / Math.sqrt(2 * m)), 1e-12)
		expect(est.n, 'the window mean gap still recovers the true population').to.equal(64)
	})

	// Preserve the original test
	it('increases confidence with more peers and balanced gaps', () => {
		const coordByte = (b: number): Uint8Array => { const u = new Uint8Array(32); u[31] = b; return u }
		const storeFew = new DigitreeStore()
		storeFew.upsert('a', coordByte(0))
		storeFew.upsert('b', coordByte(128))
		const few = estimateSizeAndConfidence(storeFew, 8)
		const storeMany = new DigitreeStore()
		for (let i = 0; i < 16; i++) storeMany.upsert(`p${i}`, coordByte((i * 16) & 255))
		const many = estimateSizeAndConfidence(storeMany, 8)
		expect(many.confidence).to.be.greaterThan(few.confidence)
	})

	// --- Phase 1: Parametric accuracy tests ---

	describe('Phase 1: Parametric accuracy', () => {
		const M = 8

		describe('Uniform topology', () => {
			for (const n of [5, 10, 50, 100, 500, 1000, 5000]) {
				it(`N=${n}: relative error < 5%`, () => {
					const store = populateStore(uniformCoords(n))
					const est = estimateSizeAndConfidence(store, M)
					expect(relativeError(est.n, n)).to.be.lessThan(0.05)
				})
			}
		})

		describe('Random uniform topology', () => {
			// N=5 omitted: too few random points for reliable median-gap estimation.
			//
			// The ~40-45% error at every N below is systematic, not noise: gaps on a random
			// ring are exponentially distributed and the median of an exponential is
			// ln(2)*mean, so n_est settles near 1.44*N. The bound pins that bias.
			for (const n of [50, 100, 500, 1000, 5000]) {
				it(`N=${n}: relative error < 50%`, () => {
					const rng = new DeterministicRNG(42 + n)
					const store = populateStore(randomUniformCoords(n, rng))
					const est = estimateSizeAndConfidence(store, M)
					// Median-gap estimator with random coords has significant variance
					expect(relativeError(est.n, n)).to.be.lessThan(0.50)
				})
			}

			// N=10 gets its own, much looser bound: with only 9 gaps the seed-to-seed noise
			// swamps the systematic bias above. Measured across 20 seeds the relative error
			// ranges 0.00-1.30 and 5 of 20 seeds exceed 0.50, so a 50% bound here would pin
			// which seed was picked rather than estimator quality.
			it('N=10: relative error within an order of magnitude', () => {
				const rng = new DeterministicRNG(52)
				const store = populateStore(randomUniformCoords(10, rng))
				const est = estimateSizeAndConfidence(store, M)
				expect(relativeError(est.n, 10)).to.be.lessThan(1.5)
			})
		})

		describe('Gapped topology', () => {
			for (const n of [5, 10, 50, 100, 500, 1000, 5000]) {
				it(`N=${n}: relative error < 70%`, () => {
					const store = populateStore(gappedCoords(n))
					const est = estimateSizeAndConfidence(store, M)
					// Gapped: median helps but large empty arcs bias the estimate
					expect(relativeError(est.n, n)).to.be.lessThan(0.70)
				})
			}
		})

		describe('Skewed topology', () => {
			for (const n of [5, 10, 50, 100, 500, 1000, 5000]) {
				it(`N=${n}: relative error within order of magnitude`, () => {
					const rng = new DeterministicRNG(123 + n)
					const store = populateStore(skewedCoords(n, rng))
					const est = estimateSizeAndConfidence(store, M)
					// Skewed: estimator is heavily biased toward dense region; median
					// gap is much smaller than true average, inflating n_est ~2-5x
					expect(relativeError(est.n, n)).to.be.lessThan(5.0)
				})
			}
		})
	})

	// --- Phase 2: Partial-knowledge (subsampling) tests ---

	// NOTE: these subsample a *uniform* ring, so a contiguous window's median gap
	// exactly equals the global inter-peer step and the estimator returns ~N
	// exactly (the "within 2x" bound is therefore slack). This is the easy case,
	// and it exercises the no-`self` whole-store fallback. The realistic hard
	// case — local density != global density, because the node knows every near
	// peer but only a scattering of far ones — is Phase 5 below.
	describe('Phase 2: Partial-knowledge subsampling', () => {
		const M = 8
		const N = 1000
		const coords = uniformCoords(N)

		for (const K of [M, 2 * M, 4 * M, 8 * M]) {
			it(`K=${K}, N=${N}: estimate within 2x of actual`, () => {
				// Take a contiguous window of K peers around the midpoint
				const start = Math.floor(N / 2)
				const store = new DigitreeStore()
				for (let i = 0; i < K; i++) {
					const idx = (start + i) % N
					store.upsert(`p${idx}`, coords[idx]!)
				}
				const est = estimateSizeAndConfidence(store, M)
				expect(est.n).to.be.greaterThan(N / 2)
				expect(est.n).to.be.lessThan(N * 2)
			})
		}

		it('confidence increases with sample count', () => {
			const kValues = [M, 2 * M, 4 * M, 8 * M]
			const confidences: number[] = []
			const start = Math.floor(N / 2)

			for (const K of kValues) {
				const store = new DigitreeStore()
				for (let i = 0; i < K; i++) {
					const idx = (start + i) % N
					store.upsert(`p${idx}`, coords[idx]!)
				}
				const est = estimateSizeAndConfidence(store, M)
				confidences.push(est.confidence)
			}

			for (let i = 1; i < confidences.length; i++) {
				expect(confidences[i]).to.be.at.least(confidences[i - 1]!)
			}
		})
	})

	// --- Phase 3: Confidence properties ---

	describe('Phase 3: Confidence properties', () => {
		const M = 8

		it('monotonicity with incremental insertion (N=200, starting from 2 peers)', () => {
			const coords = uniformCoords(200)
			const store = new DigitreeStore()
			// NOTE: monotonicity holds here only because peers are inserted in ring
			// order into an evenly-spaced ring — every gap stays equal, so the dispersion
			// factor is 1 - 1/sqrt(G) and both confidence factors (sizeFactor, dispersion)
			// rise with each insert. Confidence is NOT monotonic for arbitrary insertion
			// order; this test asserts the ordered-insertion case, not a general property.
			// Insert first two peers before tracking — the single-peer sentinel
			// confidence (0.2) is a special case, not part of the monotonic curve
			store.upsert('p0', coords[0]!)
			store.upsert('p1', coords[1]!)
			let prevConfidence = estimateSizeAndConfidence(store, M).confidence

			for (let i = 2; i < 200; i++) {
				store.upsert(`p${i}`, coords[i]!)
				const est = estimateSizeAndConfidence(store, M)
				expect(est.confidence).to.be.at.least(prevConfidence,
					`confidence dropped at peer ${i + 1}: ${est.confidence} < ${prevConfidence}`)
				prevConfidence = est.confidence
			}
		})

		describe('Edge cases', () => {
			it('empty store: n=0, confidence=0', () => {
				const store = new DigitreeStore()
				const est = estimateSizeAndConfidence(store, M)
				expect(est.n).to.equal(0)
				expect(est.confidence).to.equal(0)
			})

			it('single peer: n=1, confidence=0.2', () => {
				const store = new DigitreeStore()
				store.upsert('solo', new Uint8Array(32))
				const est = estimateSizeAndConfidence(store, M)
				expect(est.n).to.equal(1)
				expect(est.confidence).to.equal(0.2)
			})

			it('two peers: confidence > 0 and < 1', () => {
				const store = new DigitreeStore()
				store.upsert('a', toCoord(0n))
				store.upsert('b', toCoord(RING_SIZE / 2n))
				const est = estimateSizeAndConfidence(store, M)
				expect(est.confidence).to.be.greaterThan(0)
				expect(est.confidence).to.be.lessThan(1)
			})

			it('all peers at same coordinate: n_est capped, confidence low', () => {
				const store = new DigitreeStore()
				const coord = toCoord(42n)
				// Upsert with different IDs but same coordinate
				for (let i = 0; i < 10; i++) {
					store.upsert(`dup${i}`, coord)
				}
				const est = estimateSizeAndConfidence(store, M)
				// With all peers at the same point, gaps are extremely skewed
				expect(est.confidence).to.be.lessThan(0.5)
			})
		})
	})

	// --- Phase 4: Convergence speed ---

	describe('Phase 4: Convergence speed', () => {
		it('confidence exceeds 0.5 before all N=500 peers added', () => {
			const M = 8
			const N = 500
			const coords = uniformCoords(N)
			const store = new DigitreeStore()
			let crossedAt = -1

			for (let i = 0; i < N; i++) {
				store.upsert(`p${i}`, coords[i]!)
				const est = estimateSizeAndConfidence(store, M)
				if (est.confidence > 0.5 && crossedAt === -1) {
					crossedAt = i + 1
					break
				}
			}

			expect(crossedAt).to.be.greaterThan(0, 'confidence never exceeded 0.5')
			expect(crossedAt).to.be.lessThan(N, 'confidence only exceeded 0.5 after all peers added')
		})
	})

	// --- Phase 5: Realistic partial knowledge (local density != global density) ---

	// A FRET node's knowledge is deliberately non-uniform: it knows *every* peer adjacent to
	// itself (its m successors and m predecessors) and only a sparsity-weighted scattering of
	// far ones. Whole-store gaps are therefore a mixture of ~2m near-true spacings and a long
	// tail of huge far-peer gaps, and once far peers outnumber near ones — the normal steady
	// state — even the median lands in that tail and n_est collapses by 1-2 orders of
	// magnitude. Passing the self coordinate confines the gap population to the S/P window,
	// where local spacing *is* the true spacing.
	//
	// This is the guard the estimator lacked: every Phase 2 case subsamples a contiguous window
	// of a uniform ring, the one shape where whole-store gaps and S/P-window gaps coincide.
	describe('Phase 5: Non-uniform partial knowledge', () => {
		const M = 8

		/** Store holding self + M successors + M predecessors + `far` random distant peers. */
		function partialKnowledgeStore(values: bigint[], selfIdx: number, far: number, rng: DeterministicRNG) {
			const n = values.length
			const known = new Set<number>([selfIdx])
			for (let d = 1; d <= M; d++) {
				known.add((selfIdx + d) % n)
				known.add((((selfIdx - d) % n) + n) % n)
			}
			while (known.size < 2 * M + 1 + far) known.add(rng.nextInt(0, n))
			const store = new DigitreeStore()
			for (const idx of known) store.upsert(`p${idx}`, toCoord(values[idx]!))
			return store
		}

		/** Ring coordinates of N peers in ascending ring order. */
		function sortedRing(n: number, rng: DeterministicRNG): bigint[] {
			return Array.from({ length: n }, () => rng.nextBigInt(256)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		}

		for (const N of [500, 2000, 10000]) {
			for (const far of [0, 32, 128]) {
				it(`N=${N}, ${far} far peers known: estimate within 2x of actual`, () => {
					const rng = new DeterministicRNG(7000 + N + far)
					const values = sortedRing(N, rng)
					const selfIdx = rng.nextInt(0, N)
					const store = partialKnowledgeStore(values, selfIdx, far, rng)

					const est = estimateSizeAndConfidence(store, M, { self: { coord: toCoord(values[selfIdx]!), id: `p${selfIdx}` } })
					expect(est.n).to.be.greaterThan(N / 2, `undercount: n_est=${est.n} for N=${N}`)
					expect(est.n).to.be.lessThan(N * 2, `overcount: n_est=${est.n} for N=${N}`)
				})
			}
		}

		// The cases above use one seed per (N, far) pair, which pins one draw rather than the
		// estimator. This sweeps 20 seeds at a fixed shape so a change that happens to suit
		// seed 7000+N+far but degrades the estimator in general still fails here.
		it('N=2000, 32 far peers known: within 2x across 20 seeds', () => {
			const N = 2000
			let worst = 0
			for (let seed = 0; seed < 20; seed++) {
				const rng = new DeterministicRNG(8000 + seed)
				const values = sortedRing(N, rng)
				const selfIdx = rng.nextInt(0, N)
				const store = partialKnowledgeStore(values, selfIdx, 32, rng)

				const est = estimateSizeAndConfidence(store, M, { self: { coord: toCoord(values[selfIdx]!), id: `p${selfIdx}` } })
				worst = Math.max(worst, relativeError(est.n, N))
				expect(est.n).to.be.greaterThan(N / 2, `undercount at seed ${seed}: n_est=${est.n}`)
				expect(est.n).to.be.lessThan(N * 2, `overcount at seed ${seed}: n_est=${est.n}`)
			}
			// Guards the 2x bound against silently becoming the actual accuracy. Measured worst
			// across these 20 seeds is 0.545; the mean of 2m exponential gaps has a coefficient
			// of variation of 1/sqrt(2m) ~ 25%, so a bound much below this would pin the draw.
			expect(worst).to.be.lessThan(0.75, `worst relative error across 20 seeds: ${worst}`)
		})

		// Pins a *known blind spot*, not desired behaviour — see the NOTE on `dispersionFactor`
		// and the "Known blind spot" bullet in docs/fret.md. Dispersion measures spacing
		// regularity within the sampled arc and cannot see the arc that was never sampled, so a
		// node whose entire neighbourhood is packed into a tiny evenly-spaced band reports a
		// confidently wrong n. If a future change gives the estimator a defence against this
		// (corroboration from peer-reported estimates is the stated one), this test should fail
		// and be rewritten to assert the defence — it must not be loosened to keep it green.
		it('KNOWN BLIND SPOT: an eclipsed neighbourhood scores high confidence on a wrong n', () => {
			// Self plus 2m neighbours evenly spaced across 1/1000th of the ring: the shape an
			// eclipse (or a very young ring) produces.
			const band = RING_SIZE / 1000n
			const points = 2 * M + 1
			const step = band / BigInt(points)
			const store = new DigitreeStore()
			for (let i = 0; i < points; i++) store.upsert(`e${i}`, toCoord(BigInt(i) * step))

			const selfIdx = Math.floor(points / 2)
			const est = estimateSizeAndConfidence(store, M, { self: { coord: toCoord(BigInt(selfIdx) * step), id: `e${selfIdx}` } })

			// n is inflated by ~1000x: local spacing is 1000x tighter than the true spacing of
			// any plausible ring this node could belong to.
			expect(est.n).to.be.greaterThan(10_000)
			// ...and confidence does not notice, because the sampled arc is perfectly regular.
			expect(est.confidence).to.be.greaterThan(0.8)
		})

		it('S/P window is used even when self sits at the wrap-around point', () => {
			// Self near coordinate 0 puts half its predecessor window at the top of the ring.
			// Comparing raw coordinates would split the window into two runs and manufacture an
			// interior gap the size of the whole ring, collapsing n_est just as the whole-store
			// population does.
			const N = 1000
			const step = RING_SIZE / BigInt(N)
			const values = Array.from({ length: N }, (_, i) => BigInt(i) * step)
			const rng = new DeterministicRNG(99)
			const store = partialKnowledgeStore(values, 0, 64, rng)

			const est = estimateSizeAndConfidence(store, M, { self: { coord: toCoord(values[0]!), id: 'p0' } })
			expect(est.n).to.be.greaterThan(N / 2)
			expect(est.n).to.be.lessThan(N * 2)
		})

		it('confidence tracks sample quality rather than pinning at 0.5', () => {
			// The old variance factor was minGap/maxGap, which is ~0 on any random ring, so
			// confidence was exactly 0.5 for every node knowing >= 2m peers and carried no
			// information at all. A healthy window must now score well above that plateau.
			const rng = new DeterministicRNG(4242)
			const values = sortedRing(2000, rng)
			const selfIdx = rng.nextInt(0, 2000)
			const healthy = partialKnowledgeStore(values, selfIdx, 64, rng)
			const est = estimateSizeAndConfidence(healthy, M, { self: { coord: toCoord(values[selfIdx]!), id: `p${selfIdx}` } })
			expect(est.confidence).to.be.greaterThan(0.6)

			// A store whose peers all sit at one coordinate carries no spacing information.
			const degenerate = new DigitreeStore()
			for (let i = 0; i < 32; i++) degenerate.upsert(`dup${i}`, toCoord(1234n))
			const degenerateEst = estimateSizeAndConfidence(degenerate, M, { self: { coord: toCoord(1234n), id: 'dup0' } })
			expect(degenerateEst.confidence).to.be.lessThan(est.confidence)
			expect(degenerateEst.confidence).to.be.lessThan(0.6)
		})
	})
})
