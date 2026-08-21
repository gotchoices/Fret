import { describe, it } from 'mocha'
import { expect } from 'chai'
import fc from 'fast-check'
import { DigitreeStore, type PeerEntry } from '../src/store/digitree-store.js'
import { isLiveMember } from '../src/service/live-member.js'
import { ringNeighborsBothSides } from '../src/service/ring-walk.js'

/**
 * Ascending, distinct first-byte coordinates: `coordAt(i)` is `i * 7`, so a ring built from
 * `0..n-1` is in ring order `p0..p(n-1)` for any `n <= 24` (23 * 7 = 161 < 256).
 */
function coordAt(i: number): Uint8Array {
	const c = new Uint8Array(32)
	c[0] = i * 7
	return c
}

/**
 * A coordinate strictly between `coordAt(i)` and `coordAt(i + 1)`, for anchoring a walk on a
 * point where *no* entry sits. `i * 7 + 3` is never `j * 7` for any `j`, so it can never
 * collide with a stored peer.
 */
function betweenCoord(i: number): Uint8Array {
	const c = new Uint8Array(32)
	c[0] = i * 7 + 3
	return c
}

/** A ring of `p0..p(n-1)` at ascending coordinates. */
function ringStore(n: number): DigitreeStore {
	const store = new DigitreeStore()
	for (let i = 0; i < n; i++) store.upsert(`p${i}`, coordAt(i))
	return store
}

/** A coordinate whose first byte is `b` — used for the wrap-around fixtures. */
function firstByte(b: number): Uint8Array {
	const c = new Uint8Array(32)
	c[0] = b
	return c
}

const NO_SELF = 'not-a-stored-peer'

/**
 * Even indices are the successor side, odd the predecessor side — see the interleave rule.
 *
 * NOTE: the even/odd correspondence holds only while the two sides are **disjoint**. Once they
 * overlap, `interleave`'s dedup drops an id mid-list and every later index shifts parity, so these
 * two helpers report nonsense. Every case that uses them anchors on a window narrower than the
 * ring; the overlapping cases (wrap-around at count 4, the property) assert on the whole list
 * instead. If a case is ever added where the sides can meet, assert the full array, not the sides.
 */
const successorSide = (out: readonly string[]) => out.filter((_, i) => i % 2 === 0)
const predecessorSide = (out: readonly string[]) => out.filter((_, i) => i % 2 === 1)

/**
 * An **independent** oracle for the whole result, not just its size: walk the ring *by index* in
 * both directions from the anchor, take the first `perSide` reachable ids on each side, and weave
 * them. It is derived from the fixture's ring layout (`coordAt` is monotone in `i`, so index order
 * *is* ring order) rather than from the helper's own over-fetch arithmetic, so it pins **which**
 * peers come back and in what order. A size-only oracle cannot: a helper that walked the two
 * directions the wrong way round, or returned the wrong side first, returns the right count.
 */
function expectedWindow(
	n: number,
	anchorIdx: number,
	anchorOnPeer: boolean,
	reachable: ReadonlySet<string>,
	count: number
): string[] {
	const perSide = Math.min(Math.max(count, 0), reachable.size)
	if (perSide === 0) return []
	const walk = (start: number, step: number): string[] => {
		const side: string[] = []
		for (let k = 0; k < n && side.length < perSide; k++) {
			const id = `p${(((start + step * k) % n) + n) % n}`
			if (reachable.has(id)) side.push(id)
		}
		return side
	}
	// `betweenCoord(i)` sits strictly after `coordAt(i)`, so the successor walk starts at `i + 1`
	// while the predecessor walk still starts at `i`. Anchored *on* a peer, both start at `i` —
	// which is the off-by-one this helper exists to absorb.
	const successors = walk(anchorOnPeer ? anchorIdx : anchorIdx + 1, 1)
	const predecessors = walk(anchorIdx, -1)
	const out: string[] = []
	const seen = new Set<string>()
	for (let i = 0; i < perSide; i++) {
		for (const id of [successors[i], predecessors[i]]) {
			if (id === undefined || seen.has(id)) continue
			seen.add(id)
			out.push(id)
		}
	}
	return out
}

describe('ringNeighborsBothSides', () => {
	describe('the off-by-one it exists to fix', () => {
		// The direct regression. Both store walks return the entry sitting *exactly* on the
		// anchor: `ceilPath` seeks the hex coordinate followed by a pipe and a NUL and takes the
		// first key >= it, `floorPath` seeks the same prefix followed by U+FFFF and steps back,
		// so an entry keyed `hex(coord)|id` matches either way. A self-anchored
		// `neighborsRight(selfCoord, m)` therefore spends one of its `m` slots on self and
		// yields only `m - 1` other peers.
		it('a raw self-anchored store walk of m yields only m - 1 peers besides self', () => {
			const store = ringStore(20)
			const raw = store.neighborsRight(coordAt(0), 8)

			expect(raw).to.have.lengthOf(8)
			expect(raw[0], 'the walk starts on the entry sitting at the anchor').to.equal('p0')
			expect(raw.filter((id) => id !== 'p0'), 'the miscount: 8 asked for, 7 peers delivered')
				.to.have.lengthOf(7)
		})

		it('returns count peers on each side, self excluded, at the same anchor', () => {
			const store = ringStore(20)
			const out = ringNeighborsBothSides(store, coordAt(0), 8, 'p0')

			expect(out).to.deep.equal([
				'p1', 'p19', 'p2', 'p18', 'p3', 'p17', 'p4', 'p16',
				'p5', 'p15', 'p6', 'p14', 'p7', 'p13', 'p8', 'p12',
			])
			expect(successorSide(out)).to.deep.equal(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'])
			expect(predecessorSide(out)).to.deep.equal(['p19', 'p18', 'p17', 'p16', 'p15', 'p14', 'p13', 'p12'])
			expect(out).to.not.include('p0')
		})

		it('returns count peers on each side when no entry sits on the anchor either', () => {
			// The over-fetch has to be exact in *both* directions: when an entry sits on the
			// anchor the extra slot pays for it, and when none does the trim removes the surplus.
			const store = ringStore(20)
			const out = ringNeighborsBothSides(store, betweenCoord(9), 8, NO_SELF)

			expect(new Set(out).size, 'sixteen distinct peers').to.equal(16)
			expect(successorSide(out)).to.deep.equal(['p10', 'p11', 'p12', 'p13', 'p14', 'p15', 'p16', 'p17'])
			expect(predecessorSide(out)).to.deep.equal(['p9', 'p8', 'p7', 'p6', 'p5', 'p4', 'p3', 'p2'])
		})
	})

	describe('side lengths', () => {
		// Both walks lap the whole ring, so both see the same reachable set and each yields
		// exactly `min(count, reachable)`. The unequal-length branch of the private `interleave`
		// is consequently unreachable through this function — there is a NOTE: at that site
		// saying so and why it is kept. This case pins the invariant that makes it so, rather
		// than trying to construct an unequal case (which cannot be done).
		it('the two sides are always equal in length', () => {
			const store = ringStore(20)
			for (const count of [1, 3, 8, 9]) {
				const out = ringNeighborsBothSides(store, betweenCoord(9), count, NO_SELF)
				expect(successorSide(out).length, `successors at count ${count}`).to.equal(count)
				expect(predecessorSide(out).length, `predecessors at count ${count}`).to.equal(count)
			}
		})
	})

	describe('rings smaller than count', () => {
		for (const n of [1, 2, 3]) {
			it(`a ${n}-peer ring returns the whole ring: no duplicates, no padding, no spin`, () => {
				const store = ringStore(n)
				const out = ringNeighborsBothSides(store, coordAt(0), 8, NO_SELF)

				const expected = Array.from({ length: n }, (_, i) => `p${i}`)
				expect(out.slice().sort()).to.deep.equal(expected.slice().sort())
				expect(new Set(out).size).to.equal(out.length)
			})
		}

		it('a ring of exactly one peer, which is self, returns empty', () => {
			// Both walks return `[self]` and the drop removes it. That *callers* handle an empty
			// window is a separate concern (see `implement/23.05-ring-walk-migrate-call-sites`).
			const store = ringStore(1)
			expect(ringNeighborsBothSides(store, coordAt(0), 8, 'p0')).to.deep.equal([])
		})
	})

	describe('wrap-around', () => {
		const wrapRing = () => {
			const store = new DigitreeStore()
			store.upsert('c00', firstByte(0x00))
			store.upsert('c10', firstByte(0x10))
			store.upsert('c20', firstByte(0x20))
			store.upsert('cE0', firstByte(0xe0))
			store.upsert('cF0', firstByte(0xf0))
			return store
		}

		it('the window is the one contiguous run across the seam', () => {
			// Anchor 0xF8 sits between the last peer and the first. With count 2 the window is
			// `cE0, cF0 | anchor | c00, c10`; the far peer `c20` is outside it on both sides.
			const out = ringNeighborsBothSides(wrapRing(), firstByte(0xf8), 2, NO_SELF)

			expect(successorSide(out)).to.deep.equal(['c00', 'c10'])
			expect(predecessorSide(out)).to.deep.equal(['cF0', 'cE0'])
			expect(out, 'the far peer is not in the window').to.not.include('c20')
		})

		it('overlapping sides dedup to the whole ring rather than double-counting', () => {
			const out = ringNeighborsBothSides(wrapRing(), firstByte(0xf8), 4, NO_SELF)

			expect(new Set(out).size).to.equal(out.length)
			expect(out.slice().sort()).to.deep.equal(['c00', 'c10', 'c20', 'cE0', 'cF0'])
		})
	})

	describe('exclusions', () => {
		it('an exclude set blanketing one side is filled from further out', () => {
			// This is what the `+ exclude.size` over-fetch buys: the successor side is still 3
			// peers deep, drawn from past the excluded ones, rather than starved.
			const store = ringStore(20)
			const out = ringNeighborsBothSides(store, coordAt(0), 3, 'p0', {
				exclude: new Set(['p1', 'p2', 'p3']),
			})

			expect(out).to.deep.equal(['p4', 'p19', 'p5', 'p18', 'p6', 'p17'])
			for (const id of ['p0', 'p1', 'p2', 'p3']) expect(out).to.not.include(id)
		})
	})

	describe('degenerate asks', () => {
		it('a filter matching nothing returns empty and terminates', () => {
			// The store's one-lap `maxScan` guard is what makes this true rather than a spin.
			const store = ringStore(20)
			expect(ringNeighborsBothSides(store, coordAt(0), 8, NO_SELF, { filter: () => false }))
				.to.deep.equal([])
		})

		for (const count of [0, -1]) {
			it(`count ${count} returns empty, not one peer`, () => {
				// The over-fetch would otherwise turn a non-positive ask into a `reach` of 1 and
				// hand back a peer; the reachable case is a degenerate `m` of 0 in the config.
				const store = ringStore(20)
				expect(ringNeighborsBothSides(store, coordAt(0), count, NO_SELF)).to.deep.equal([])
			})
		}
	})

	describe('membership-filtered walks use the real predicate', () => {
		it('excludes non-members and fills the window from members further out', () => {
			// `upsert` defaults membership to 'unknown', so every peer needs marking 'member'
			// first — the predicate under test is the shipped `isLiveMember`, not a stand-in.
			const store = ringStore(20)
			for (let i = 0; i < 20; i++) store.setMembership(`p${i}`, 'member')
			for (const id of ['p1', 'p2', 'p19']) store.setMembership(id, 'foreign')

			const out = ringNeighborsBothSides(store, coordAt(0), 3, 'p0', { filter: isLiveMember })

			expect(successorSide(out)).to.deep.equal(['p3', 'p4', 'p5'])
			expect(predecessorSide(out)).to.deep.equal(['p18', 'p17', 'p16'])
		})

		it('excludes a dead member — the state half of the predicate, not only membership', () => {
			// `isLiveMember` is two independent conditions. A suite that only ever demotes
			// `membership` leaves `state !== 'dead'` unexercised, so a filter that dropped that
			// half would stay green.
			const store = ringStore(20)
			for (let i = 0; i < 20; i++) store.setMembership(`p${i}`, 'member')
			for (const id of ['p1', 'p2', 'p19']) store.setState(id, 'dead')

			const out = ringNeighborsBothSides(store, coordAt(0), 3, 'p0', { filter: isLiveMember })

			expect(successorSide(out)).to.deep.equal(['p3', 'p4', 'p5'])
			expect(predecessorSide(out)).to.deep.equal(['p18', 'p17', 'p16'])
		})
	})

	describe('property', function () {
		this.timeout(30_000)

		it('the union is exactly the oracle, self- and exclude-free, and drawn from the reachable set', () => {
			// Region tally, following `test/nexthop-cost.spec.ts`: a green run that never anchored
			// on a peer, or never met a ring smaller than `count`, would say nothing about the two
			// regions this helper exists for.
			const region = { anchorOnReachablePeer: 0, ringSmallerThanCount: 0, filtered: 0, unfiltered: 0 }

			fc.assert(fc.property(
				fc.integer({ min: 1, max: 20 }),                                   // ring population
				fc.integer({ min: -1, max: 12 }),                                  // count
				fc.integer({ min: -1, max: 19 }),                                  // self index, -1 = self not in the ring
				fc.uniqueArray(fc.integer({ min: 0, max: 19 }), { maxLength: 5 }), // exclude indices
				fc.boolean(),                                                      // anchor on a peer vs between peers
				fc.integer({ min: 0, max: 19 }),                                   // anchor index
				// `undefined` = no filter at all; otherwise the indices marked 'member'.
				fc.option(fc.uniqueArray(fc.integer({ min: 0, max: 19 }), { maxLength: 20 }), { nil: undefined }),
				(n, count, selfRaw, excludeRaw, anchorOnPeer, anchorRaw, memberRaw) => {
					const store = ringStore(n)
					const anchorIdx = anchorRaw % n
					const selfId = selfRaw < 0 ? NO_SELF : `p${selfRaw % n}`
					const exclude = new Set(excludeRaw.map((i) => `p${i % n}`))

					let filter: ((e: PeerEntry) => boolean) | undefined
					let matching: Set<string>
					if (memberRaw === undefined) {
						matching = new Set(Array.from({ length: n }, (_, i) => `p${i}`))
						region.unfiltered++
					} else {
						const members = new Set(memberRaw.map((i) => `p${i % n}`))
						for (const id of members) store.setMembership(id, 'member')
						filter = isLiveMember
						matching = members
						region.filtered++
					}

					const reachable = new Set(
						Array.from(matching).filter((id) => id !== selfId && !exclude.has(id))
					)
					const r = reachable.size
					const perSide = Math.min(Math.max(count, 0), r)
					const anchorInR = anchorOnPeer && reachable.has(`p${anchorIdx}`)
					// The anchor entry heads *both* sides, hence the -1; the whole union is capped
					// at the reachable population, which is what the two sides meeting produces.
					const expectedSize = count <= 0 || r === 0
						? 0
						: Math.min(anchorInR ? 2 * perSide - 1 : 2 * perSide, r)
					const expected = expectedWindow(n, anchorIdx, anchorOnPeer, reachable, count)

					if (anchorInR) region.anchorOnReachablePeer++
					if (count > 0 && n < count) region.ringSmallerThanCount++

					const coord = anchorOnPeer ? coordAt(anchorIdx) : betweenCoord(anchorIdx)
					const out = ringNeighborsBothSides(store, coord, count, selfId, { filter, exclude })

					// Two independently-derived oracles cross-checked against each other: the
					// arithmetic one reasons from the store's walk semantics, the enumerated one
					// from the ring layout. If the arithmetic reasoning is wrong, this disagrees
					// rather than being wrong in the same direction as the code.
					expect(expected.length, 'the two oracles disagree on size').to.equal(expectedSize)
					expect(out, 'the window is exactly the enumerated one').to.deep.equal(expected)
					expect(new Set(out).size, 'no duplicates').to.equal(out.length)
					expect(out, 'self is never present').to.not.include(selfId)
					for (const id of out) {
						expect(exclude.has(id), `excluded id ${id} present`).to.equal(false)
						expect(store.getById(id), `${id} is not in the store`).to.not.equal(undefined)
						expect(reachable.has(id), `${id} does not pass the filter`).to.equal(true)
					}
					return true
				}
			), { numRuns: 500 })

			expect(region.anchorOnReachablePeer, 'no anchor-on-a-reachable-peer case was generated')
				.to.be.greaterThan(0)
			expect(region.ringSmallerThanCount, 'no ring-smaller-than-count case was generated')
				.to.be.greaterThan(0)
			expect(region.filtered, 'no membership-filtered case was generated').to.be.greaterThan(0)
			expect(region.unfiltered, 'no unfiltered case was generated').to.be.greaterThan(0)
		})
	})
})
