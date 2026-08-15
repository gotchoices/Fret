import { describe, it } from 'mocha'
import { DigitreeStore } from '../src/store/digitree-store.js'
import { chooseNextHop } from '../src/selector/next-hop.js'
import { computeNearRadius } from '../src/service/payload-heuristic.js'

function coordByte(b: number): Uint8Array {
	const u = new Uint8Array(32)
	u[31] = b
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
	// this is a genuine multi-hop descent rather than one jump to the global best. Fully
	// deterministic — the ring is laid out by hand, no randomness and no live nodes.
	it('converges monotonically over a multi-hop walk', () => {
		const store = new DigitreeStore()
		const target = coordByte(0)

		const ring = [2, 5, 9, 14, 20, 27, 35, 44, 54, 65, 77, 90]
		for (const b of ring) store.upsert(`p${b}`, coordByte(b))
		// The one connected peer is the *worse* of the two candidates on the first hop, so a
		// connected-first bias leaking into near mode would show up as a non-minimal choice.
		const connected = new Set(['p77'])

		const nearRadius = coordByte(0xff) // every distance in play counts as near
		/** The candidates a node at ring index `i` can see: its two neighbours on each side. */
		const localView = (i: number) => ring.slice(Math.max(0, i - 2), i + 3).map(b => `p${b}`)

		let idx = ring.length - 1 // start at the peer farthest from the key
		const path = [ring[idx]!]
		for (let hop = 0; hop < ring.length; hop++) {
			const self = ring[idx]!
			const visited = new Set(path.map(b => `p${b}`))
			const next = chooseNextHop(
				store, target,
				localView(idx).filter(id => !visited.has(id)),
				(id) => connected.has(id),
				() => 0.5,
				{ nearRadius, confidence: 0.9, selfCoord: coordByte(self) }
			)
			if (next === undefined) break
			const nextByte = Number(next.slice(1))
			if (nextByte >= self) {
				throw new Error(`hop ${path.join('->')} -> ${nextByte} did not reduce distance to the key`)
			}
			idx = ring.indexOf(nextByte)
			path.push(nextByte)
		}

		if (path[path.length - 1] !== ring[0]) {
			throw new Error(`walk stalled short of the nearest peer; path ${path.join('->')}`)
		}
		if (path.length < 4) {
			throw new Error(`expected a multi-hop descent, got ${path.join('->')}`)
		}
	})
})
