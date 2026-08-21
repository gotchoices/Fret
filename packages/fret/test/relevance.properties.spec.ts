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
	initialRelevance,
} from '../src/store/relevance.js'
import type { PeerEntry } from '../src/store/digitree-store.js'
import { COORD_BYTES } from '../src/ring/hash.js'

const arbCoord = fc.uint8Array({ minLength: COORD_BYTES, maxLength: COORD_BYTES })
const arbX = fc.double({ min: 0, max: 1, noNaN: true })

// Every scoring call blends in a recency term, so any test asserting a *value* has to pin the
// clock — otherwise `lastAccess` and `now` drift apart by however long the test took and the
// expected constant moves under it. Passing the same instant as both is what makes recency
// exactly 1 and the measured numbers below reproducible.
const FIXED_NOW = 1_700_000_000_000

// `avgLatencyMs: NaN` is deliberately untested. It would poison `healthScore` and therefore
// every relevance value derived from the entry, but latency only ever originates from a local
// `Date.now()` difference in the ping paths — never from the wire, and never from a snapshot
// (`SerializedPeerEntry.avgLatencyMs` is only ever read back as a number or null). There is no
// caller that can produce it, so guarding against it here would pin behavior no code can reach.

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

		// The bonus is what makes the routing table favor under-represented ring distances, so
		// "a heavily-observed band scores below an untouched one" is the whole point of the
		// model — but it is invisible for the first ~25 observations of a band, because the
		// occupancy EMA (α = 0.03) has not yet climbed far enough to pull the ratio under
		// `sMax`. Measured on a fresh model, observing x = 0.2 repeatedly:
		//
		//   observations |  bonus(0.2)  |  bonus(0.8)
		//        5       |    1.8000    |    1.8000   (both clamped — proves nothing)
		//       20       |    1.8000    |    1.8000
		//       30       |    1.6698    |    1.8000
		//       50       |    1.4230    |    1.8000
		//      150       |    1.2355    |    1.8000
		//
		// Hence 50 and not 5: at 5 both bands read `sMax` and the assertion passes vacuously.
		// Do not trim the loop.
		it('scores a heavily-observed band below an unobserved one, once off the sMax clamp', () => {
			const model = createSparsityModel()
			for (let i = 0; i < 50; i++) observeDistance(model, 0.2)

			const busy = sparsityBonus(model, 0.2)
			const untouched = sparsityBonus(model, 0.8)

			expect(busy, 'busy band has come off the clamp').to.be.closeTo(1.4230, 1e-4)
			expect(untouched, 'untouched band is still at sMax').to.equal(model.sMax)
			expect(busy).to.be.lessThan(untouched)
		})

		// Deliberately a property over *repeated observation of one band*, not over an arbitrary
		// observation sequence: occupancy is an EMA toward each centre's kernel value, so
		// observing somewhere else lets a centre near `x` decay and the bonus at `x` *rise*.
		// Monotonicity is only true when every observation lands on the band being queried.
		it('never raises a band\'s own bonus by observing that same band', () => {
			fc.assert(fc.property(arbX, fc.integer({ min: 1, max: 60 }), (x, n) => {
				const model = createSparsityModel()
				let prev = sparsityBonus(model, x)
				for (let i = 0; i < n; i++) {
					observeDistance(model, x)
					const cur = sparsityBonus(model, x)
					if (cur > prev + 1e-12) return false
					prev = cur
				}
				return true
			}), opts)
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

		// No counter value can push relevance out of a small range: the frequency term is
		// log1p(n)/5 and the health term is a ratio in [0,1], so the base is bounded whatever
		// the counters hold, and the bonus is clamped at sMax. Asserted as "finite and small"
		// rather than against the measured 4.0850, because the point is the bound, not the
		// constant — an entry that has been touched 2^53 times is not a state to tune against.
		it('stays finite with counters at MAX_SAFE_INTEGER', () => {
			const now = FIXED_NOW
			const model = createSparsityModel()
			const entry = makeEntry({
				lastAccess: now,
				accessCount: Number.MAX_SAFE_INTEGER,
				successCount: Number.MAX_SAFE_INTEGER,
				avgLatencyMs: 0,
			})

			const updated = touch(entry, 0.5, model, now)

			expect(Number.isFinite(updated.relevance)).to.equal(true)
			expect(updated.relevance).to.be.greaterThan(0)
			expect(updated.relevance, 'measured 4.0850').to.be.lessThan(10)
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

		it('scores a success above a failure from the same starting entry', () => {
			const now = FIXED_NOW
			const entry = makeEntry({ lastAccess: now })

			const succeeded = recordSuccess(entry, undefined, 0.5, createSparsityModel(), now)
			const failed = recordFailure(entry, 0.5, createSparsityModel(), now)

			expect(succeeded.relevance).to.be.greaterThan(failed.relevance)
			expect(succeeded.relevance, 'measured').to.be.closeTo(1.26, 1e-4)
			expect(failed.relevance, 'measured').to.be.closeTo(0.63, 1e-4)
		})

		// Frequency credit: settled by tickets/implement/25-frequency-credit-relevance-core (formerly
		// tickets/backlog/bug-frequency-credit-only-from-gossip). A completed RPC is an access.
		it('scores 500 successes strictly above 1 success', () => {
			const now = FIXED_NOW
			let one = makeEntry({ lastAccess: now })
			one = recordSuccess(one, undefined, 0.5, createSparsityModel(), now)

			let five_hundred = makeEntry({ lastAccess: now })
			for (let i = 0; i < 500; i++) {
				five_hundred = recordSuccess(five_hundred, undefined, 0.5, createSparsityModel(), now)
			}

			expect(five_hundred.relevance).to.be.greaterThan(one.relevance)
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

		// Sustained failure must down-rank without ever running away: relevance drives both
		// next-hop preference and capacity eviction, so a score that decayed to 0 (or below)
		// would make a temporarily unreachable peer indistinguishable from a worthless one and
		// evict it before the re-probe passes could recover it. The floor is structural rather
		// than clamped — `base` is a sum of non-negative terms and the bonus is at least
		// `sMin` (0.7) — so this pins the property, and the endpoints pin the magnitude.
		//
		// Measured at a fixed clock, one shared model, x = 0.5, from a fresh unmeasured entry:
		// 0.6300 after the first failure, falling monotonically to 0.5861 after 30. The decline
		// across the run is the sparsity bonus tapering as the band fills, not the 0.7 decay
		// factor compounding — each call re-derives the score from the entry's counters rather
		// than scaling the previous relevance.
		it('stays positive and non-increasing under 30 consecutive failures', () => {
			const now = FIXED_NOW
			const model = createSparsityModel()

			let entry = recordFailure(makeEntry({ lastAccess: now }), 0.5, model, now)
			const first = entry.relevance
			expect(first, 'measured').to.be.closeTo(0.63, 1e-4)

			for (let i = 1; i < 30; i++) {
				const next = recordFailure(entry, 0.5, model, now)
				expect(next.relevance, `failure ${i + 1} did not raise relevance`).to.be.at.most(entry.relevance)
				expect(next.relevance, `failure ${i + 1} stayed above zero`).to.be.greaterThan(0)
				entry = next
			}

			expect(entry.failureCount).to.equal(30)
			expect(entry.relevance, 'measured').to.be.closeTo(0.5861, 1e-4)
			expect(entry.relevance).to.be.lessThan(first)
		})

		// Surprising but deliberate: failing to reach a peer counts as *recent access*, so the
		// recency clock is reset by the very event that down-ranks the peer. The 0.7 decay
		// factor still makes the net effect a down-rank (see the test above), but a peer that
		// keeps failing never ages out through recency — it is the `dead` marking and eviction
		// that remove it, not decay.
		it('advances lastAccess to now', () => {
			const now = FIXED_NOW
			const model = createSparsityModel()
			const stale = makeEntry({ lastAccess: now - 600_000 })

			expect(recordFailure(stale, 0.5, model, now).lastAccess).to.equal(now)
		})
	})
})
