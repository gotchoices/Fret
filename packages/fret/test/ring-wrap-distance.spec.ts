import { describe, it } from 'mocha'
import { expect } from 'chai'
import { DigitreeStore } from '../src/store/digitree-store.js'
import { chooseNextHop } from '../src/selector/next-hop.js'
import { minDistance } from '../src/ring/distance.js'
import { normalizedLogDistance } from '../src/store/relevance.js'
import { computeNearRadius, shouldIncludePayload } from '../src/service/payload-heuristic.js'
import { toBigInt } from './helpers/ring.js'

// Regression vectors for the ring's wrap-around seam.
//
// These three coordinates straddle the top-bit boundary. On the ring, SELF sits
// exactly one arc-unit counter-clockwise of KEY and RIVAL sits 2^244 clockwise of
// it, so SELF is overwhelmingly the better hop. Under a bit-XOR metric the
// relationship inverts: SELF shares no high bit with KEY and scores as maximally
// distant (2^256 − 1) while RIVAL scores 2^244. Every assertion below fails if a
// decision point ever measures with XOR again.

function coord(...prefix: number[]): Uint8Array {
	const u = new Uint8Array(32)
	u.set(prefix)
	return u
}

/** 0x80 followed by 31 zero bytes — the coordinate just clockwise of the seam. */
const KEY = coord(0x80)

/** 0x7f followed by 31 0xff bytes — one arc-unit counter-clockwise of KEY. */
const SELF = (() => {
	const u = new Uint8Array(32).fill(0xff)
	u[0] = 0x7f
	return u
})()

/** 0x8010 followed by zeros — 2^244 clockwise of KEY. */
const RIVAL = coord(0x80, 0x10)

describe('Ring distance across the wrap-around seam', () => {
	it('measures the seam-adjacent peer as one arc-unit away', () => {
		expect(toBigInt(minDistance(SELF, KEY))).to.equal(1n)
		expect(toBigInt(minDistance(RIVAL, KEY))).to.equal(1n << 244n)
	})

	it('legacy next-hop path picks the ring-nearer peer', () => {
		const store = new DigitreeStore()
		store.upsert('self-side', SELF)
		store.upsert('rival', RIVAL)

		const hop = chooseNextHop(
			store, KEY,
			['self-side', 'rival'],
			() => false,
			() => 0.5
		)
		expect(hop).to.equal('self-side')
	})

	it('cost next-hop path picks the ring-nearer peer', () => {
		const store = new DigitreeStore()
		store.upsert('self-side', SELF)
		store.upsert('rival', RIVAL)

		const nearRadius = computeNearRadius(1000, 15)
		const hop = chooseNextHop(
			store, KEY,
			['self-side', 'rival'],
			() => false,
			() => 0.5,
			{ nearRadius, confidence: 0.9 }
		)
		expect(hop).to.equal('self-side')
	})

	it('includes the payload for a ring-adjacent node', () => {
		// nearZone = β·k·2^256/n_est ≈ 3.47e75; the true arc length (1) sits well
		// inside it, while the XOR magnitude (2^256 − 1) blew past it.
		expect(shouldIncludePayload(minDistance(SELF, KEY), 1000, 0.9, 15)).to.equal(true)
	})

	it('scores a ring-adjacent peer as near in the sparsity model', () => {
		// XOR put this peer at the far end of the distance histogram (x = 1.0).
		expect(normalizedLogDistance(SELF, KEY)).to.be.lessThan(0.01)
	})
})
