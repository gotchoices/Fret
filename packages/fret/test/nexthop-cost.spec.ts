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
})
