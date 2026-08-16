import { describe, it } from 'mocha'
import { expect } from 'chai'
import fc from 'fast-check'
import {
	createSparsityModel,
	sparsityBonus,
	observeDistance,
	normalizedLogDistance,
	touch,
	recordSuccess,
	recordFailure,
	healthScore,
} from '../src/store/relevance.js'
import type { PeerEntry } from '../src/store/digitree-store.js'
import { COORD_BYTES } from '../src/ring/hash.js'

const arbCoord = fc.uint8Array({ minLength: COORD_BYTES, maxLength: COORD_BYTES })
const arbX = fc.double({ min: 0, max: 1, noNaN: true })

function makeEntry(overrides?: Partial<PeerEntry>): PeerEntry {
	return {
		id: 'test-peer',
		coord: new Uint8Array(COORD_BYTES),
		relevance: 0,
		lastAccess: Date.now(),
		state: 'connected',
		membership: 'unknown',
		negotiateFailures: 0,
		lastNegotiateFailureAt: 0,
		contactFailures: 0,
		lastContactFailureAt: 0,
		accessCount: 0,
		successCount: 0,
		failureCount: 0,
		avgLatencyMs: null, // never measured, matching the store's default for a fresh peer
		...overrides,
	}
}

describe('Relevance scoring properties', function () {
	this.timeout(30_000)

	const opts = { numRuns: 200 }

	describe('sparsityBonus', () => {
		it('is bounded within [sMin, sMax]', () => {
			fc.assert(fc.property(arbX, (x) => {
				const model = createSparsityModel()
				const bonus = sparsityBonus(model, x)
				return bonus >= model.sMin && bonus <= model.sMax
			}), opts)
		})

		it('stays bounded after many observations', () => {
			fc.assert(fc.property(
				fc.array(arbX, { minLength: 1, maxLength: 50 }),
				arbX,
				(observations, queryX) => {
					const model = createSparsityModel()
					for (const x of observations) observeDistance(model, x)
					const bonus = sparsityBonus(model, queryX)
					return bonus >= model.sMin && bonus <= model.sMax
				}
			), opts)
		})
	})

	describe('observeDistance', () => {
		it('increases at least one center occupancy', () => {
			fc.assert(fc.property(arbX, (x) => {
				const model = createSparsityModel()
				const before = Float64Array.from(model.occupancy)
				observeDistance(model, x)
				let anyIncreased = false
				for (let i = 0; i < model.occupancy.length; i++) {
					if (model.occupancy[i]! > before[i]!) anyIncreased = true
				}
				return anyIncreased
			}), opts)
		})
	})

	describe('normalizedLogDistance', () => {
		it('returns value in [0, 1]', () => {
			fc.assert(fc.property(arbCoord, arbCoord, (a, b) => {
				const d = normalizedLogDistance(a, b)
				return d >= 0 && d <= 1
			}), opts)
		})

		it('self-distance is zero', () => {
			fc.assert(fc.property(arbCoord, (a) => {
				return normalizedLogDistance(a, a) === 0
			}), opts)
		})
	})

	// `avgLatencyMs` used to overload `0` to mean "never measured", so a peer genuinely measured
	// at 0 ms took the neutral no-data penalty and scored *below* a peer measured at 300 ms.
	// These pin the general rule rather than that one point, so the whole sentinel class stays
	// caught: health is monotone in measured latency everywhere, and "unmeasured" is its own
	// value sitting at the neutral midpoint.
	describe('healthScore', () => {
		const arbLatency = fc.double({ min: 0, max: 5000, noNaN: true })

		it('is non-increasing in measured latency, across the full range including 0', () => {
			fc.assert(fc.property(arbLatency, arbLatency, (a, b) => {
				const faster = healthScore(makeEntry({ avgLatencyMs: Math.min(a, b) }))
				const slower = healthScore(makeEntry({ avgLatencyMs: Math.max(a, b) }))
				return faster >= slower
			}), opts)
		})

		it('scores a 0 ms peer strictly above any slower measured peer', () => {
			fc.assert(fc.property(fc.double({ min: 1e-6, max: 1000, noNaN: true }), (slower) => {
				return healthScore(makeEntry({ avgLatencyMs: 0 })) > healthScore(makeEntry({ avgLatencyMs: slower }))
			}), opts)
		})

		it('places an unmeasured peer strictly between a 0 ms and a 1000 ms peer', () => {
			const unmeasured = healthScore(makeEntry({ avgLatencyMs: null }))
			expect(unmeasured).to.be.lessThan(healthScore(makeEntry({ avgLatencyMs: 0 })))
			expect(unmeasured).to.be.greaterThan(healthScore(makeEntry({ avgLatencyMs: 1000 })))
		})
	})

	describe('touch', () => {
		it('increments accessCount by 1', () => {
			fc.assert(fc.property(
				fc.nat({ max: 1000 }),
				arbX,
				(initialCount, x) => {
					const model = createSparsityModel()
					const entry = makeEntry({ accessCount: initialCount })
					const updated = touch(entry, x, model)
					return updated.accessCount === initialCount + 1
				}
			), opts)
		})

		it('produces non-negative relevance', () => {
			fc.assert(fc.property(arbX, (x) => {
				const model = createSparsityModel()
				const entry = makeEntry()
				const updated = touch(entry, x, model)
				return updated.relevance >= 0
			}), opts)
		})
	})

	describe('recordSuccess', () => {
		it('increments successCount by 1', () => {
			fc.assert(fc.property(
				fc.nat({ max: 1000 }),
				fc.double({ min: 0, max: 5000, noNaN: true }),
				arbX,
				(initialCount, latency, x) => {
					const model = createSparsityModel()
					const entry = makeEntry({ successCount: initialCount })
					const updated = recordSuccess(entry, latency, x, model)
					return updated.successCount === initialCount + 1
				}
			), opts)
		})

		it('produces non-negative relevance', () => {
			fc.assert(fc.property(
				fc.double({ min: 0, max: 5000, noNaN: true }),
				arbX,
				(latency, x) => {
					const model = createSparsityModel()
					const entry = makeEntry()
					const updated = recordSuccess(entry, latency, x, model)
					return updated.relevance >= 0
				}
			), opts)
		})

		it('seeds the average with the first sample rather than blending against a phantom 0', () => {
			const model = createSparsityModel()
			expect(recordSuccess(makeEntry(), 400, 0.5, model).avgLatencyMs).to.equal(400)
		})

		// A measured 0 ms average is a real average, so the next sample must blend into it by
		// EMA (α = 0.2) like any other — not hard-reset the peer to the new sample.
		it('blends a later sample into a measured 0 ms average by EMA', () => {
			const model = createSparsityModel()
			const entry = makeEntry({ avgLatencyMs: 0 })
			expect(recordSuccess(entry, 400, 0.5, model).avgLatencyMs).to.equal(80)
		})

		// The forward path in FretService.routeAct records success with no latency argument,
		// because a forwarded maybeAct returns only once the whole downstream route has
		// finished — its wall time is the subtree's cost, not the link's. Asserted here at the
		// scoring seam rather than by driving routeAct end-to-end.
		it('leaves avgLatencyMs untouched when no sample is supplied (the forward path)', () => {
			const model = createSparsityModel()
			const measured = recordSuccess(makeEntry({ avgLatencyMs: 200 }), undefined, 0.5, model)
			expect(measured.avgLatencyMs).to.equal(200)

			const neverMeasured = recordSuccess(makeEntry(), undefined, 0.5, model)
			expect(neverMeasured.avgLatencyMs).to.equal(null)
		})

		it('still counts a latency-less success', () => {
			const model = createSparsityModel()
			const updated = recordSuccess(makeEntry({ successCount: 3 }), undefined, 0.5, model)
			expect(updated.successCount).to.equal(4)
			expect(updated.relevance).to.be.greaterThan(0)
		})

		// Twenty forwards used to erase a real 200 ms measurement (200 → 2.3) by feeding a
		// fabricated 0 ms into the EMA on every hop.
		it('does not decay a measured average over repeated latency-less successes', () => {
			const model = createSparsityModel()
			let entry = makeEntry({ avgLatencyMs: 200 })
			for (let i = 0; i < 20; i++) entry = recordSuccess(entry, undefined, 0.5, model)
			expect(entry.avgLatencyMs).to.equal(200)
		})
	})

	describe('recordFailure', () => {
		it('increments failureCount by 1', () => {
			fc.assert(fc.property(
				fc.nat({ max: 1000 }),
				arbX,
				(initialCount, x) => {
					const model = createSparsityModel()
					const entry = makeEntry({ failureCount: initialCount })
					const updated = recordFailure(entry, x, model)
					return updated.failureCount === initialCount + 1
				}
			), opts)
		})

		it('degrades relevance compared to touch', () => {
			fc.assert(fc.property(arbX, (x) => {
				const now = Date.now()
				const model1 = createSparsityModel()
				const model2 = createSparsityModel()
				const entry = makeEntry({ lastAccess: now })
				const touched = touch(entry, x, model1, now)
				const failed = recordFailure(entry, x, model2, now)
				return failed.relevance <= touched.relevance
			}), opts)
		})

		it('produces non-negative relevance', () => {
			fc.assert(fc.property(arbX, (x) => {
				const model = createSparsityModel()
				const entry = makeEntry()
				const updated = recordFailure(entry, x, model)
				return updated.relevance >= 0
			}), opts)
		})
	})
})
