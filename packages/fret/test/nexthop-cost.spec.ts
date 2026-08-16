import { describe, it } from 'mocha'
import { expect } from 'chai'
import fc from 'fast-check'
import { DigitreeStore } from '../src/store/digitree-store.js'
import { chooseNextHop } from '../src/selector/next-hop.js'
import { computeNearRadius } from '../src/service/payload-heuristic.js'
import { lexLess, minDistance } from '../src/ring/distance.js'
import { COORD_BYTES } from '../src/ring/hash.js'

function coordByte(b: number): Uint8Array {
	const u = new Uint8Array(32)
	u[31] = b
	return u
}

/** Coordinate at b·2^248 — spread across the ring rather than bunched near zero. */
function coordTopByte(b: number): Uint8Array {
	const u = new Uint8Array(32)
	u[0] = b
	return u
}

/** Coordinate with a single bit set, at 2^p (p ∈ [0, 255]). */
function pow2Coord(p: number): Uint8Array {
	const u = new Uint8Array(COORD_BYTES)
	u[COORD_BYTES - 1 - (p >> 3)] = 1 << (p & 7)
	return u
}

describe('Next-hop cost-function mode', () => {
	it('prefers closer peer when near target (strict mode)', () => {
		const store = new DigitreeStore()
		const target = coordByte(200)

		store.upsert('close-disconnected', coordByte(201))
		store.upsert('far-connected', coordByte(220))

		const nearRadius = computeNearRadius(10, 5) // large near radius
		const result = chooseNextHop(
			store, target,
			['close-disconnected', 'far-connected'],
			(id) => id === 'far-connected',
			() => 0.5,
			{ nearRadius, confidence: 0.9 }
		)

		// In near/strict mode with high confidence, distance is weighted heavily
		// close-disconnected at dist=1 should beat far-connected at dist=20
		if (result !== 'close-disconnected') {
			throw new Error(`expected close-disconnected in near/strict mode, got ${result}`)
		}
	})

	it('prefers connected peer when far from target (slack mode)', () => {
		const store = new DigitreeStore()
		// Target at one end, candidates far away → far mode
		const target = coordByte(100)

		store.upsert('closer-disconnected', coordByte(110))
		store.upsert('farther-connected', coordByte(115))

		// Tiny near radius so both peers are "far"
		const nearRadius = coordByte(1)
		const result = chooseNextHop(
			store, target,
			['closer-disconnected', 'farther-connected'],
			(id) => id === 'farther-connected',
			() => 0.5,
			{ nearRadius, confidence: 0.5 }
		)

		// In far mode, connected bias should make farther-connected preferable
		if (result !== 'farther-connected') {
			throw new Error(`expected farther-connected in far/slack mode, got ${result}`)
		}
	})

	it('penalizes peers with high backoff', () => {
		const store = new DigitreeStore()
		const target = coordByte(50)

		// Both at similar distance; both far from target (near radius = 0)
		store.upsert('penalized', coordByte(60))
		store.upsert('ok', coordByte(61))

		const nearRadius = new Uint8Array(32) // zero → all candidates are far
		const result = chooseNextHop(
			store, target,
			['penalized', 'ok'],
			() => false,
			() => 0.5,
			{
				nearRadius,
				confidence: 0.5,
				backoffPenalty: (id) => id === 'penalized' ? 1 : 0
			}
		)

		if (result !== 'ok') {
			throw new Error(`expected non-penalized peer, got ${result}`)
		}
	})

	it('falls back to legacy mode without nearRadius', () => {
		const store = new DigitreeStore()
		const target = coordByte(200)

		store.upsert('far-connected', coordByte(210))
		store.upsert('near-disconnected', coordByte(201))

		// No nearRadius → legacy tolerance-bytes heuristic
		const result = chooseNextHop(
			store, target,
			['far-connected', 'near-disconnected'],
			(id) => id === 'far-connected',
			() => 0.5,
			1
		)

		if (result !== 'far-connected') {
			throw new Error(`legacy mode should prefer connected within tolerance, got ${result}`)
		}
	})
})

describe('Next-hop near-mode strict improvement (selfCoord)', () => {
	// Near radius large enough that both self and every candidate below count as "near".
	const nearRadius = computeNearRadius(10, 5)

	it('returns undefined when every near candidate is behind the node', () => {
		const store = new DigitreeStore()
		const target = coordByte(200)

		store.upsert('behind-a', coordByte(210)) // dist 10
		store.upsert('behind-b', coordByte(220)) // dist 20

		const result = chooseNextHop(
			store, target,
			['behind-a', 'behind-b'],
			() => false,
			() => 0.5,
			{ nearRadius, confidence: 0.9, selfCoord: coordByte(201) } // self dist 1
		)

		if (result !== undefined) {
			throw new Error(`expected no hop when all candidates are farther than self, got ${result}`)
		}
	})

	it('picks the strictly-closer candidate and never one behind the node', () => {
		const store = new DigitreeStore()
		const target = coordByte(200)

		store.upsert('behind', coordByte(215))  // dist 15
		store.upsert('ahead', coordByte(205))   // dist 5

		const result = chooseNextHop(
			store, target,
			['behind', 'ahead'],
			(id) => id === 'behind', // connectedness must not rescue a backwards hop
			() => 0.5,
			{ nearRadius, confidence: 0.9, selfCoord: coordByte(190) } // self dist 10
		)

		if (result !== 'ahead') {
			throw new Error(`expected the strictly-closer candidate, got ${result}`)
		}
	})

	it('does not filter when the node itself is far from the key', () => {
		const store = new DigitreeStore()
		const target = coordByte(200)

		store.upsert('near-candidate', coordByte(202)) // dist 2, inside the near radius

		// Tiny near radius: the candidate is near, self (dist 60) is not.
		const result = chooseNextHop(
			store, target,
			['near-candidate'],
			() => false,
			() => 0.5,
			{ nearRadius: coordByte(5), confidence: 0.9, selfCoord: coordByte(140) }
		)

		if (result !== 'near-candidate') {
			throw new Error(`far node should still take a near hop, got ${result}`)
		}
	})

	it('leaves near-mode selection unchanged when no selfCoord is supplied', () => {
		const store = new DigitreeStore()
		const target = coordByte(200)

		store.upsert('behind-a', coordByte(210))
		store.upsert('behind-b', coordByte(220))

		const result = chooseNextHop(
			store, target,
			['behind-a', 'behind-b'],
			() => false,
			() => 0.5,
			{ nearRadius, confidence: 0.9 }
		)

		if (result !== 'behind-a') {
			throw new Error(`without selfCoord the closest candidate still wins, got ${result}`)
		}
	})

	// The first test above saturates the near radius, so it proves "no near candidate qualifies
	// → undefined" without a far candidate ever existing. This one keeps a far candidate in the
	// pool to prove the absence of a fall-through, which is the actual claim.
	it('returns undefined rather than falling through to an available far candidate', () => {
		const store = new DigitreeStore()
		const target = coordByte(200)

		// Near radius 20: self (dist 10) and 'behind' (dist 15) are near; 'way-out' (dist 55) is far.
		store.upsert('behind', coordByte(215))
		store.upsert('way-out', coordByte(255))

		const result = chooseNextHop(
			store, target,
			['behind', 'way-out'],
			(id) => id === 'way-out', // connected, so far mode would happily pick it
			() => 0.5,
			{ nearRadius: coordByte(20), confidence: 0.9, selfCoord: coordByte(190) }
		)

		if (result !== undefined) {
			throw new Error(`a near node must not fall through to a far candidate, got ${result}`)
		}
	})

	it('ignores selfCoord on the legacy path, where there is no near radius', () => {
		const store = new DigitreeStore()
		const target = coordByte(200)

		store.upsert('behind-a', coordByte(210))
		store.upsert('behind-b', coordByte(220))

		// No nearRadius → legacy connected-first heuristic, which has no self-distance concept.
		const result = chooseNextHop(
			store, target,
			['behind-a', 'behind-b'],
			() => false,
			() => 0.5,
			{ selfCoord: coordByte(201) }
		)

		if (result !== 'behind-a') {
			throw new Error(`legacy path must ignore selfCoord, got ${result}`)
		}
	})

	// The invariant selfCoord exists to provide, exercised over a whole walk rather than one
	// call: hand the selector each hop's own coordinate and the distance to the key must fall
	// on every hop until no improving peer is left. Each hop sees only its ring neighbours, so
	// this is a genuine multi-hop descent rather than one jump to the global best. One harness,
	// driven at two radii — see the two cases below. Fully deterministic: both rings are laid
	// out by hand, no randomness and no live nodes.
	//
	// `ring` is ascending in distance from a key at coordinate 0, and `coordOf` maps a ring
	// value to a coordinate below 2^255, so `minDistance(coord, 0)` *is* the value — which is
	// what makes "ring value falls" and "distance to the key falls" the same statement.
	function walkRing(opts: {
		ring: number[]
		coordOf: (v: number) => Uint8Array
		nearRadius: Uint8Array
		connected: Set<string>
	}): number[] {
		const { ring, coordOf, nearRadius, connected } = opts
		const store = new DigitreeStore()
		for (const v of ring) store.upsert(`p${v}`, coordOf(v))
		const target = new Uint8Array(32)

		/** The candidates a node at ring index `i` can see: its two neighbours on each side. */
		const localView = (i: number) => ring.slice(Math.max(0, i - 2), i + 3).map(v => `p${v}`)

		let idx = ring.length - 1 // start at the peer farthest from the key
		const path = [ring[idx]!]
		for (let hop = 0; hop < ring.length; hop++) {
			const self = ring[idx]!
			const visited = new Set(path.map(v => `p${v}`))
			const next = chooseNextHop(
				store, target,
				localView(idx).filter(id => !visited.has(id)),
				(id) => connected.has(id),
				() => 0.5,
				{ nearRadius, confidence: 0.9, selfCoord: coordOf(self) }
			)
			if (next === undefined) break
			const nextValue = Number(next.slice(1))
			if (nextValue >= self) {
				throw new Error(`hop ${path.join('->')} -> ${nextValue} did not reduce distance to the key`)
			}
			idx = ring.indexOf(nextValue)
			path.push(nextValue)
		}
		return path
	}

	function expectFullDescent(path: number[], ring: number[]): void {
		expect(path[path.length - 1], `walk stalled short of the nearest peer; path ${path.join('->')}`)
			.to.equal(ring[0])
		expect(path.length, `expected a multi-hop descent, got ${path.join('->')}`).to.be.at.least(4)
	}

	it('converges monotonically over a multi-hop walk (near-saturating radius)', () => {
		const ring = [2, 5, 9, 14, 20, 27, 35, 44, 54, 65, 77, 90]
		expectFullDescent(walkRing({
			ring,
			coordOf: coordByte,
			nearRadius: coordByte(0xff), // every distance in play counts as near
			// The one connected peer is the *worse* of the two candidates on the first hop, so a
			// connected-first bias leaking into near mode would show up as a non-minimal choice.
			connected: new Set(['p77']),
		}), ring)
	})

	it('converges monotonically over a multi-hop walk (far-mode radius)', () => {
		// Coordinates spread across the ring: `coordTopByte(v)` sits at v·2^248, and
		// computeNearRadius(1000, 15) ≈ 7.68·2^248, so peers at v ≥ 8 are *far*. The walk
		// therefore starts in far mode, crosses the radius, and finishes in near mode — the
		// regime the self-distance floor previously did not cover.
		const ring = [1, 2, 3, 5, 8, 12, 17, 23, 30, 40, 52, 66]
		expectFullDescent(walkRing({
			ring,
			coordOf: coordTopByte,
			nearRadius: computeNearRadius(1000, 15),
			// Connected, and the worse of the two candidates on the first hop. Far mode's
			// connected-first allowance may legitimately pick it; the floor must still make
			// every hop reduce the distance to the key.
			connected: new Set(['p52']),
		}), ring)
	})
})

describe('Next-hop strict-improvement invariant (property)', function () {
	this.timeout(60_000)

	const arbCoord = fc.uint8Array({ minLength: COORD_BYTES, maxLength: COORD_BYTES })
	const arbId = fc.stringMatching(/^[0-9a-f]{4,8}$/)
	const arbPeerSet = fc.uniqueArray(
		fc.record({ id: arbId, coord: arbCoord }),
		{ selector: (p) => p.id, minLength: 1, maxLength: 24 }
	)

	/**
	 * Near radii spanning the ring log-uniformly (2^p) as well as arbitrary ones, so all-near,
	 * all-far and mixed pools are all generated. Arbitrary 32-byte radii alone would almost
	 * always dwarf, or be dwarfed by, the distances between uniformly random coordinates, and
	 * far mode — the partition this invariant was missing — would go untested.
	 */
	const arbNearRadius = fc.oneof(
		fc.integer({ min: 0, max: 255 }).map(pow2Coord),
		arbCoord
	)

	/** Peers plus the connected / backed-off subsets drawn from those same ids. */
	const arbScenario = arbPeerSet.chain((peers) => {
		const ids = peers.map((p) => p.id)
		return fc.record({
			peers: fc.constant(peers),
			connected: fc.subarray(ids),
			backedOff: fc.subarray(ids),
		})
	})

	it('never returns a hop farther from the key than the caller, in any mode', () => {
		const outcome = { near: 0, far: 0, none: 0 }

		fc.assert(fc.property(
			arbScenario, arbCoord, arbCoord, arbNearRadius,
			fc.double({ min: 0, max: 1, noNaN: true }),
			({ peers, connected, backedOff }, targetCoord, selfCoord, nearRadius, confidence) => {
				const store = new DigitreeStore()
				for (const p of peers) store.upsert(p.id, p.coord)
				const connectedSet = new Set(connected)
				const backedOffSet = new Set(backedOff)

				const chosen = chooseNextHop(
					store, targetCoord, peers.map((p) => p.id),
					(id) => connectedSet.has(id),
					() => 0.5,
					{
						nearRadius,
						selfCoord,
						confidence,
						backoffPenalty: (id) => (backedOffSet.has(id) ? 1 : 0),
					}
				)

				if (chosen === undefined) {
					outcome.none++
					return true
				}

				const entry = store.getById(chosen)
				if (!entry) return false
				const dist = minDistance(entry.coord, targetCoord)
				if (lexLess(nearRadius, dist)) outcome.far++
				else outcome.near++

				// The whole invariant: strictly closer to the key than the caller, or no hop.
				return lexLess(dist, minDistance(selfCoord, targetCoord))
			}
		), { numRuns: 500 })

		// The generators must actually reach both partitions and the no-hop outcome. A green run
		// over near-mode pools alone would merely restate the near-only filter this replaced.
		expect(outcome.near, 'no near-mode decision was generated').to.be.greaterThan(0)
		expect(outcome.far, 'no far-mode decision was generated').to.be.greaterThan(0)
		expect(outcome.none, 'the no-hop outcome was never generated').to.be.greaterThan(0)
	})
})
