import { describe, it } from 'mocha'
import { shouldIncludePayload, computeNearRadius } from '../src/service/payload-heuristic.js'

function coordByte(b: number): Uint8Array {
	const u = new Uint8Array(32)
	u[31] = b
	return u
}

describe('Payload inclusion heuristic', () => {
	it('returns false when confidence is zero', () => {
		const dist = coordByte(1)
		if (shouldIncludePayload(dist, 100, 0, 15)) {
			throw new Error('should not include when confidence is zero')
		}
	})

	it('returns false when size estimate is zero', () => {
		const dist = coordByte(1)
		if (shouldIncludePayload(dist, 0, 0.8, 15)) {
			throw new Error('should not include when size estimate is zero')
		}
	})

	it('returns true when very close to target with high confidence', () => {
		// Distance of 0 means we're right on the key
		const dist = new Uint8Array(32) // all zeros = distance 0
		if (!shouldIncludePayload(dist, 100, 0.9, 15)) {
			throw new Error('should include when distance is zero and confidence high')
		}
	})

	it('returns false when far from target', () => {
		// Distance with high byte set = very far
		const dist = new Uint8Array(32)
		dist[0] = 0xff
		if (shouldIncludePayload(dist, 100, 0.8, 15)) {
			throw new Error('should not include when very far from target')
		}
	})

	it('respects custom threshold', () => {
		const dist = coordByte(1)
		// With very high threshold, should be harder to include
		const low = shouldIncludePayload(dist, 10, 0.5, 15, 2, 0.01)
		const high = shouldIncludePayload(dist, 10, 0.5, 15, 2, 0.99)
		// Low threshold should be more permissive than high
		if (!low && high) throw new Error('low threshold should be more permissive')
	})
})

describe('computeNearRadius', () => {
	it('returns zero when size estimate is zero', () => {
		const r = computeNearRadius(0, 15)
		const allZero = r.every(b => b === 0)
		if (!allZero) throw new Error('expected all zeros for zero estimate')
	})

	it('returns a non-zero radius for reasonable estimates', () => {
		const r = computeNearRadius(100, 15)
		const hasNonZero = r.some(b => b !== 0)
		if (!hasNonZero) throw new Error('expected non-zero radius for N=100, k=15')
	})

	it('smaller network produces larger near radius', () => {
		const small = computeNearRadius(10, 15)
		const large = computeNearRadius(1000, 15)
		// Smaller network → larger cluster span → larger near radius
		// Compare lexicographically (big-endian)
		let smallBigger = false
		for (let i = 0; i < 32; i++) {
			if (small[i]! > large[i]!) { smallBigger = true; break }
			if (small[i]! < large[i]!) break
		}
		if (!smallBigger) throw new Error('smaller network should have larger near radius')
	})
})
