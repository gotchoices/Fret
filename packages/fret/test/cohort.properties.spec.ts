import { describe, it } from 'mocha'
import { expect } from 'chai'
import fc from 'fast-check'
import { DigitreeStore } from '../src/store/digitree-store.js'
import { COORD_BYTES } from '../src/ring/hash.js'

const arbCoord = fc.uint8Array({ minLength: COORD_BYTES, maxLength: COORD_BYTES })

interface FakePeer { id: string; coord: Uint8Array }

const arbId = fc.stringMatching(/^[0-9a-f]{4,8}$/)

const arbPeer: fc.Arbitrary<FakePeer> = fc.record({
	id: arbId,
	coord: arbCoord,
})

const arbPeerSet = fc.uniqueArray(arbPeer, { selector: (p) => p.id, minLength: 1, maxLength: 60 })

function seedStore(peers: FakePeer[]): DigitreeStore {
	const store = new DigitreeStore()
	for (const p of peers) store.upsert(p.id, p.coord)
	return store
}

/**
 * Mirrors the assembleCohort logic from fret-service.ts but operates
 * directly on a DigitreeStore, avoiding the need for a full FretService.
 */
function assembleCohort(
	store: DigitreeStore,
	coord: Uint8Array,
	wants: number,
	exclude?: Set<string>
): string[] {
	const out: string[] = []
	const ex = exclude ?? new Set<string>()
	const succIds = store.neighborsRight(coord, wants * 2)
	const predIds = store.neighborsLeft(coord, wants * 2)
	let si = 0
	let pi = 0
	while (out.length < wants && (si < succIds.length || pi < predIds.length)) {
		if (out.length % 2 === 0 && si < succIds.length) {
			const id = succIds[si++]
			if (id && !ex.has(id)) out.push(id)
		} else if (pi < predIds.length) {
			const id = predIds[pi++]
			if (id && !ex.has(id)) out.push(id)
		} else if (si < succIds.length) {
			const id = succIds[si++]
			if (id && !ex.has(id)) out.push(id)
		}
	}
	return Array.from(new Set(out)).slice(0, wants)
}

describe('Cohort assembly properties', function () {
	this.timeout(30_000)

	const opts = { numRuns: 200 }

	describe('store neighbor invariants', () => {
		it('neighborsRight returns no duplicates', () => {
			fc.assert(fc.property(arbPeerSet, arbCoord, (peers, coord) => {
				const store = seedStore(peers)
				const m = Math.min(peers.length, 8)
				const right = store.neighborsRight(coord, m)
				return new Set(right).size === right.length
			}), opts)
		})

		it('neighborsLeft returns no duplicates', () => {
			fc.assert(fc.property(arbPeerSet, arbCoord, (peers, coord) => {
				const store = seedStore(peers)
				const m = Math.min(peers.length, 8)
				const left = store.neighborsLeft(coord, m)
				return new Set(left).size === left.length
			}), opts)
		})

		it('combined S/P unique count ≤ min(2m, n)', () => {
			fc.assert(fc.property(arbPeerSet, arbCoord, fc.integer({ min: 1, max: 16 }), (peers, coord, m) => {
				const store = seedStore(peers)
				const right = store.neighborsRight(coord, m)
				const left = store.neighborsLeft(coord, m)
				const combined = new Set([...right, ...left])
				return combined.size <= Math.min(2 * m, peers.length)
			}), opts)
		})

		it('wraps around the ring boundary', () => {
			// Deterministic edge case: peers near 0x00 and 0xFF boundaries
			const nearZero = new Uint8Array(COORD_BYTES)
			nearZero[COORD_BYTES - 1] = 1

			const nearMax = new Uint8Array(COORD_BYTES)
			nearMax.fill(0xff)
			nearMax[COORD_BYTES - 1] = 0xfe

			const store = new DigitreeStore()
			store.upsert('lo', nearZero)
			store.upsert('hi', nearMax)

			// Query from near the top of the ring — right should wrap to lo
			const query = new Uint8Array(COORD_BYTES)
			query.fill(0xff)
			query[COORD_BYTES - 1] = 0xf0

			const right = store.neighborsRight(query, 4)
			expect(right).to.include('hi')
			expect(right).to.include('lo')

			// Query from near the bottom — left should wrap to hi
			const query2 = new Uint8Array(COORD_BYTES)
			query2[COORD_BYTES - 1] = 0x05
			const left = store.neighborsLeft(query2, 4)
			expect(left).to.include('lo')
			expect(left).to.include('hi')
		})
	})

	describe('assembleCohort invariants', () => {
		it('returns no duplicates', () => {
			fc.assert(fc.property(arbPeerSet, arbCoord, fc.integer({ min: 1, max: 30 }), (peers, coord, wants) => {
				const store = seedStore(peers)
				const cohort = assembleCohort(store, coord, wants)
				return new Set(cohort).size === cohort.length
			}), opts)
		})

		it('size = min(wants, n)', () => {
			fc.assert(fc.property(arbPeerSet, arbCoord, fc.integer({ min: 1, max: 30 }), (peers, coord, wants) => {
				const store = seedStore(peers)
				const cohort = assembleCohort(store, coord, wants)
				return cohort.length === Math.min(wants, peers.length)
			}), opts)
		})

		it('monotonic expansion: wants₁ ⊆ wants₂', () => {
			fc.assert(fc.property(
				arbPeerSet, arbCoord,
				fc.integer({ min: 1, max: 15 }),
				fc.integer({ min: 1, max: 15 }),
				(peers, coord, w1, w2) => {
					const [small, big] = w1 <= w2 ? [w1, w2] : [w2, w1]
					const store = seedStore(peers)
					const c1 = new Set(assembleCohort(store, coord, small))
					const c2 = new Set(assembleCohort(store, coord, big))
					for (const id of c1) {
						if (!c2.has(id)) return false
					}
					return true
				}
			), opts)
		})

		it('exclusion is respected', () => {
			fc.assert(fc.property(arbPeerSet, arbCoord, (peers, coord) => {
				if (peers.length < 2) return true
				const store = seedStore(peers)
				const excludeId = peers[0]!.id
				const exclude = new Set([excludeId])
				const cohort = assembleCohort(store, coord, peers.length, exclude)
				return !cohort.includes(excludeId)
			}), opts)
		})

		it('is deterministic: same inputs → same result', () => {
			fc.assert(fc.property(arbPeerSet, arbCoord, fc.integer({ min: 1, max: 20 }), (peers, coord, wants) => {
				const store1 = seedStore(peers)
				const store2 = seedStore(peers)
				const c1 = assembleCohort(store1, coord, wants)
				const c2 = assembleCohort(store2, coord, wants)
				if (c1.length !== c2.length) return false
				for (let i = 0; i < c1.length; i++) {
					if (c1[i] !== c2[i]) return false
				}
				return true
			}), opts)
		})

		it('n=1: single peer always returned', () => {
			fc.assert(fc.property(
				arbId, arbCoord, arbCoord,
				(id, peerCoord, queryCoord) => {
					const store = new DigitreeStore()
					store.upsert(id, peerCoord)
					const cohort = assembleCohort(store, queryCoord, 5)
					return cohort.length === 1 && cohort[0] === id
				}
			), opts)
		})

		it('all peers at same coordinate: assembles correct count', () => {
			fc.assert(fc.property(
				fc.uniqueArray(arbId, { minLength: 2, maxLength: 20 }),
				arbCoord,
				fc.integer({ min: 1, max: 20 }),
				(ids, sharedCoord, wants) => {
					const store = new DigitreeStore()
					for (const id of ids) store.upsert(id, sharedCoord)
					const cohort = assembleCohort(store, sharedCoord, wants)
					return cohort.length === Math.min(wants, ids.length)
				}
			), opts)
		})
	})
})
