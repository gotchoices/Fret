import { describe, it } from 'mocha'
import fc from 'fast-check'
import {
	createSparsityModel,
	sparsityBonus,
	observeDistance,
	normalizedLogDistance,
	touch,
	recordSuccess,
	recordFailure,
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
		accessCount: 0,
		successCount: 0,
		failureCount: 0,
		avgLatencyMs: 0,
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
