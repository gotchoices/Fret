import { describe, it } from 'mocha'
import { expect } from 'chai'
import fc from 'fast-check'
import { ExpiringMap } from '../src/utils/expiring-map.js'

/**
 * A clock the test steps by hand.
 *
 * Expiry is a rule about the clock, not about `setTimeout` accuracy, so every TTL assertion
 * below drives time rather than sleeping through it — the same reasoning (and the same helper)
 * as `dedup-cache.spec.ts`, which exercises the same class through its `DedupCache` face.
 */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
	let t = start
	return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('ExpiringMap', () => {
	describe('capacity and eviction order', () => {
		// The two halves of the `set` contract that a naive `Map.set` gets wrong: a refresh must
		// not grow the map (so it must not evict), and it must move the key to the newest slot
		// (so it is not chosen as the next victim). `DedupCache` pins these through its own face;
		// pinned directly here too, since every other caller of this class relies on them.
		it('a refresh at capacity evicts nothing and moves the key last in eviction order', () => {
			const map = new ExpiringMap<number>({ capacity: 3, ttlMs: 30_000 })
			map.set('a', 1)
			map.set('b', 2)
			map.set('c', 3)

			map.set('a', 11) // refresh at capacity: nothing may be evicted
			expect(map.size).to.equal(3)
			expect(map.get('a')).to.equal(11)
			expect(map.has('b')).to.equal(true, 'refresh must not evict an unrelated entry')
			expect(map.has('c')).to.equal(true, 'refresh must not evict an unrelated entry')

			map.set('d', 4) // now a real insert: victim must be 'b', not the refreshed 'a'
			expect(map.has('a')).to.equal(true, 'refreshed key must not be the eviction victim')
			expect(map.has('b')).to.equal(false, 'oldest surviving key must be the victim')
			expect(map.has('d')).to.equal(true)
		})

		// Under one constant TTL insertion order *is* expiry order, so the first-inserted entry is
		// the nearest-expiry one. Pinned against both wrong answers: an arbitrary victim and the
		// newest one.
		it('the eviction victim is the nearest-expiry (first-inserted) entry', () => {
			const clock = fakeClock()
			const map = new ExpiringMap<number>({ capacity: 3, ttlMs: 1000, now: clock.now })
			map.set('a', 1)
			clock.advance(10)
			map.set('b', 2)
			clock.advance(10)
			map.set('c', 3)

			map.set('d', 4)
			expect(map.has('a')).to.equal(false, 'nearest-expiry entry must be the victim')
			expect(map.has('b')).to.equal(true)
			expect(map.has('c')).to.equal(true, 'the newest entry must never be the victim')
			expect(map.has('d')).to.equal(true)
		})

		// The property `DedupCache`'s O(1) eviction rests on: a live entry is never sacrificed
		// while a dead one remains.
		it('evicts an expired entry rather than a live one', () => {
			const clock = fakeClock()
			const map = new ExpiringMap<number>({ capacity: 3, ttlMs: 150, now: clock.now })
			map.set('a', 1) // expires t+150
			clock.advance(100)
			map.set('b', 2) // expires t+250
			map.set('c', 3) // expires t+250
			clock.advance(80) // t+180: only 'a' is expired
			map.set('d', 4)
			expect(map.has('a')).to.equal(false, 'the expired entry must be the victim')
			expect(map.has('b')).to.equal(true)
			expect(map.has('c')).to.equal(true)
		})
	})

	describe('degenerate capacities', () => {
		for (const [label, given] of [['zero', 0], ['negative', -5], ['fractional', 2.9], ['NaN', NaN], ['Infinity', Infinity]] as Array<[string, number]>) {
			it(`clamps a ${label} capacity to a usable whole number`, () => {
				const map = new ExpiringMap<number>({ capacity: given, ttlMs: 1000 })
				expect(map.capacity).to.be.at.least(1)
				expect(Number.isInteger(map.capacity)).to.equal(true)
				// "Unbounded" is the state this class exists to make unwritable.
				expect(map.capacity).to.be.at.most(2)
			})
		}

		it('capacity 1 still behaves: the second key wins and size stays 1', () => {
			const map = new ExpiringMap<string>({ capacity: 0, ttlMs: 1000 })
			expect(map.capacity).to.equal(1)
			map.set('a', 'first')
			map.set('b', 'second')
			expect(map.size).to.equal(1)
			expect(map.has('a')).to.equal(false)
			expect(map.get('b')).to.equal('second')
		})

		it('clamps a negative or non-finite TTL to 0 rather than throwing', () => {
			const clock = fakeClock()
			expect(new ExpiringMap<number>({ capacity: 4, ttlMs: -1 }).ttlMs).to.equal(0)
			expect(new ExpiringMap<number>({ capacity: 4, ttlMs: NaN }).ttlMs).to.equal(0)
			// TTL 0 means "live only at the instant of the write" — expiry is `expiresAt < now`.
			const map = new ExpiringMap<number>({ capacity: 4, ttlMs: -1, now: clock.now })
			map.set('a', 1)
			expect(map.get('a')).to.equal(1, 'still live at the write instant')
			clock.advance(1)
			expect(map.get('a')).to.equal(undefined)
		})
	})

	describe('expiry boundary', () => {
		// `<`, not `<=`: an entry is live *at* its expiry instant. `dedup-cache.spec.ts` pins this
		// through the wrapper; pinned directly here so the rule survives a refactor of either.
		it('an entry is still live at exactly its expiry instant', () => {
			const clock = fakeClock()
			const map = new ExpiringMap<string>({ capacity: 8, ttlMs: 50, now: clock.now })
			map.set('k', 'v')
			clock.advance(50)
			expect(map.get('k')).to.equal('v', 'live at the boundary')
			expect(map.has('k')).to.equal(true)
			expect(map.keys()).to.deep.equal(['k'], 'keys() must agree with get/has at the boundary')
			expect(map.sweep()).to.equal(0, 'sweep must agree with get/has at the boundary')
			clock.advance(1)
			expect(map.get('k')).to.equal(undefined, 'expired one ms past the boundary')
		})

		it('a lookup drops the expired entry it just refused', () => {
			const clock = fakeClock()
			const map = new ExpiringMap<number>({ capacity: 8, ttlMs: 10, now: clock.now })
			map.set('k', 1)
			clock.advance(11)
			expect(map.size).to.equal(1, 'an expired entry still occupies memory until something removes it')
			expect(map.get('k')).to.equal(undefined)
			expect(map.size).to.equal(0, 'the refused lookup must have removed it')
		})

		it('a refresh restarts the TTL window', () => {
			const clock = fakeClock()
			const map = new ExpiringMap<string>({ capacity: 8, ttlMs: 200, now: clock.now })
			map.set('k', 'v1')
			clock.advance(120)
			map.set('k', 'v2')
			clock.advance(120) // past 200 from the first write, not the second
			expect(map.get('k')).to.equal('v2')
			clock.advance(81)
			expect(map.get('k')).to.equal(undefined)
		})
	})

	describe('sweep', () => {
		it('reports 0 and leaves the map usable when nothing is expired', () => {
			const clock = fakeClock()
			const map = new ExpiringMap<number>({ capacity: 8, ttlMs: 1000, now: clock.now })
			map.set('a', 1)
			map.set('b', 2)
			expect(map.sweep()).to.equal(0)
			expect(map.size).to.equal(2)
			map.set('c', 3)
			expect(map.get('a')).to.equal(1)
			expect(map.get('c')).to.equal(3)
		})

		it('drops every entry, reports the count, and leaves the map usable', () => {
			const clock = fakeClock()
			const map = new ExpiringMap<number>({ capacity: 8, ttlMs: 100, now: clock.now })
			map.set('a', 1)
			map.set('b', 2)
			map.set('c', 3)
			clock.advance(101)
			expect(map.sweep()).to.equal(3)
			expect(map.size).to.equal(0)
			map.set('d', 4)
			expect(map.get('d')).to.equal(4)
			expect(map.size).to.equal(1)
		})

		it('reports 0 on an empty map', () => {
			const map = new ExpiringMap<number>({ capacity: 8, ttlMs: 100 })
			expect(map.sweep()).to.equal(0)
			expect(map.size).to.equal(0)
			map.set('a', 1)
			expect(map.get('a')).to.equal(1)
		})

		it('drops only the expired entries in a mixed map', () => {
			const clock = fakeClock()
			const map = new ExpiringMap<number>({ capacity: 8, ttlMs: 100, now: clock.now })
			map.set('old', 1)
			clock.advance(60)
			map.set('new', 2)
			clock.advance(50) // 'old' is 110ms in (expired), 'new' is 50ms in (live)
			expect(map.sweep()).to.equal(1)
			expect(map.has('old')).to.equal(false)
			expect(map.get('new')).to.equal(2)
		})

		// Sweeping is what keeps the map bounded by *live* population rather than by peak: a burst
		// that fills it must not leave the map full of dead entries forever.
		it('a burst followed by a sweep shrinks the map back to its live population', () => {
			const clock = fakeClock()
			// Capacity 65 so the burst plus the later live entry fit without the cap binding —
			// this test is about the sweep reclaiming dead entries, not about eviction.
			const map = new ExpiringMap<number>({ capacity: 65, ttlMs: 100, now: clock.now })
			for (let i = 0; i < 64; i++) map.set(`burst-${i}`, i)
			expect(map.size).to.equal(64)
			clock.advance(101)
			map.set('live', 1)
			expect(map.sweep()).to.equal(64)
			expect(map.size).to.equal(1, 'only the live entry survives')
			expect(map.get('live')).to.equal(1)
		})
	})

	describe('keys()', () => {
		it('returns a snapshot that is safe to delete from while walking', () => {
			const map = new ExpiringMap<number>({ capacity: 16, ttlMs: 1000 })
			for (let i = 0; i < 8; i++) map.set(`k${i}`, i)
			const keys = map.keys()
			expect(keys).to.have.length(8)
			// The `pruneBackoffMap` pattern: walk the snapshot, delete a subset of the live map.
			for (const k of keys) {
				if (Number(k.slice(1)) % 2 === 0) map.delete(k)
			}
			expect(keys).to.have.length(8, 'the snapshot must be unaffected by the deletes')
			expect(map.size).to.equal(4)
			expect(map.keys().sort()).to.deep.equal(['k1', 'k3', 'k5', 'k7'])
		})

		it('omits expired keys without waiting for a sweep', () => {
			const clock = fakeClock()
			const map = new ExpiringMap<number>({ capacity: 16, ttlMs: 100, now: clock.now })
			map.set('old', 1)
			clock.advance(101)
			map.set('fresh', 2)
			expect(map.keys()).to.deep.equal(['fresh'])
			expect(map.size).to.equal(2, 'keys() reports live keys; it does not itself prune')
		})
	})

	describe('clear()', () => {
		it('empties the map and leaves it usable', () => {
			const map = new ExpiringMap<number>({ capacity: 4, ttlMs: 1000 })
			map.set('a', 1)
			map.set('b', 2)
			map.clear()
			expect(map.size).to.equal(0)
			expect(map.has('a')).to.equal(false)
			map.set('c', 3)
			expect(map.get('c')).to.equal(3)
		})
	})

	describe('delete()', () => {
		it('reports whether a key was present, expired entries included', () => {
			const clock = fakeClock()
			const map = new ExpiringMap<number>({ capacity: 4, ttlMs: 100, now: clock.now })
			map.set('a', 1)
			expect(map.delete('a')).to.equal(true)
			expect(map.delete('a')).to.equal(false)
			// An expired-but-not-yet-swept entry is still *retained*, so deleting it reclaims a slot.
			map.set('b', 2)
			clock.advance(101)
			expect(map.delete('b')).to.equal(true)
			expect(map.size).to.equal(0)
		})
	})

	// The invariant the whole class exists for, over an arbitrary interleaving of every operation
	// and arbitrary clock steps: the stated capacity is never exceeded, no matter the order.
	it('never exceeds its capacity under an arbitrary operation interleaving', () => {
		type Op =
			| { kind: 'set'; key: string }
			| { kind: 'get'; key: string }
			| { kind: 'delete'; key: string }
			| { kind: 'sweep' }
			| { kind: 'advance'; ms: number }

		const key = fc.integer({ min: 0, max: 24 }).map((n) => `k${n}`)
		const op: fc.Arbitrary<Op> = fc.oneof(
			key.map((k) => ({ kind: 'set', key: k }) as Op),
			key.map((k) => ({ kind: 'get', key: k }) as Op),
			key.map((k) => ({ kind: 'delete', key: k }) as Op),
			fc.constant({ kind: 'sweep' } as Op),
			fc.integer({ min: 0, max: 300 }).map((ms) => ({ kind: 'advance', ms }) as Op),
		)

		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 12 }),
				fc.integer({ min: 0, max: 500 }),
				fc.array(op, { minLength: 1, maxLength: 200 }),
				(capacity, ttlMs, ops) => {
					const clock = fakeClock()
					const map = new ExpiringMap<number>({ capacity, ttlMs, now: clock.now })
					let seq = 0
					for (const o of ops) {
						switch (o.kind) {
							case 'set': { map.set(o.key, seq++); break }
							case 'get': { map.get(o.key); break }
							case 'delete': { map.delete(o.key); break }
							case 'sweep': { map.sweep(); break }
							case 'advance': { clock.advance(o.ms); break }
						}
						expect(map.size).to.be.at.most(map.capacity)
						// `keys()` is a live-key subset of what is retained, so it is bounded too.
						expect(map.keys().length).to.be.at.most(map.capacity)
					}
					return true
				},
			),
			{ numRuns: 300 },
		)
	})

	// The other half of the capacity property: bounding size must not cost correctness on the
	// entries that survive. A key written and read back inside its TTL, on a map never pushed to
	// capacity, always reads back the value it was written with.
	it('returns the last written value for a live key when capacity never binds', () => {
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.integer({ min: 0, max: 5 }), fc.integer()), { minLength: 1, maxLength: 20 }),
				(writes) => {
					const clock = fakeClock()
					// Capacity above the key space, so nothing is ever evicted for room.
					const map = new ExpiringMap<number>({ capacity: 16, ttlMs: 10_000, now: clock.now })
					const model = new Map<string, number>()
					for (const [k, v] of writes) {
						map.set(`k${k}`, v)
						model.set(`k${k}`, v)
						clock.advance(1)
					}
					for (const [k, v] of model) {
						expect(map.get(k)).to.equal(v)
					}
					expect(map.size).to.equal(model.size)
					return true
				},
			),
			{ numRuns: 200 },
		)
	})
})
