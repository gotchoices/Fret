import { describe, it } from 'mocha'
import { expect } from 'chai'
import { DigitreeStore } from '../src/store/digitree-store.js'
import { estimateSizeAndConfidence } from '../src/estimate/size-estimator.js'
import { DeterministicRNG } from './simulation/deterministic-rng.js'

const RING_SIZE = 1n << 256n

// --- Coordinate generation helpers ---

function bigIntToCoord(v: bigint): Uint8Array {
	const u = new Uint8Array(32)
	let rem = v % RING_SIZE
	if (rem < 0n) rem += RING_SIZE
	for (let i = 31; i >= 0; i--) {
		u[i] = Number(rem & 0xffn)
		rem >>= 8n
	}
	return u
}

/** Evenly spaced coords: i * (2^256 / n) */
function uniformCoords(n: number): Uint8Array[] {
	const step = RING_SIZE / BigInt(n)
	return Array.from({ length: n }, (_, i) => bigIntToCoord(BigInt(i) * step))
}

/** Peers placed only in a fraction of the ring (e.g., 60%), leaving a large empty gap */
function gappedCoords(n: number, fraction: number = 0.6): Uint8Array[] {
	const arc = (RING_SIZE * BigInt(Math.floor(fraction * 1000))) / 1000n
	const step = arc / BigInt(n)
	return Array.from({ length: n }, (_, i) => bigIntToCoord(BigInt(i) * step))
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
		coords.push(bigIntToCoord(pos))
	}
	return coords
}

/** Random uniform 32-byte coordinates */
function randomUniformCoords(n: number, rng: DeterministicRNG): Uint8Array[] {
	return Array.from({ length: n }, () => bigIntToCoord(rng.nextBigInt(256)))
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
			// N=5 omitted: too few random points for reliable median-gap estimation
			for (const n of [10, 50, 100, 500, 1000, 5000]) {
				it(`N=${n}: relative error < 50%`, () => {
					const rng = new DeterministicRNG(42 + n)
					const store = populateStore(randomUniformCoords(n, rng))
					const est = estimateSizeAndConfidence(store, M)
					// Median-gap estimator with random coords has significant variance
					expect(relativeError(est.n, n)).to.be.lessThan(0.50)
				})
			}
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
				store.upsert('a', bigIntToCoord(0n))
				store.upsert('b', bigIntToCoord(RING_SIZE / 2n))
				const est = estimateSizeAndConfidence(store, M)
				expect(est.confidence).to.be.greaterThan(0)
				expect(est.confidence).to.be.lessThan(1)
			})

			it('all peers at same coordinate: n_est capped, confidence low', () => {
				const store = new DigitreeStore()
				const coord = bigIntToCoord(42n)
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
})
