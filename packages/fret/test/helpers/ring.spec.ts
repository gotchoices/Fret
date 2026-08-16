import { describe, it } from 'mocha'
import { expect } from 'chai'
import fc from 'fast-check'
import { ringOffset, oppositeCoord, toBigInt } from './ring.js'
import { minDistance } from '../../src/ring/distance.js'
import { COORD_BYTES } from '../../src/ring/hash.js'

const RING = 1n << BigInt(COORD_BYTES * 8)

const ZERO = new Uint8Array(COORD_BYTES)
const ALL_FF = new Uint8Array(COORD_BYTES).fill(0xff)
const MID = (() => {
	const u = new Uint8Array(COORD_BYTES)
	u[0] = 0x42
	u[COORD_BYTES - 1] = 0x99
	return u
})()

describe('ringOffset', () => {
	it('adds at the least-significant byte, not the most-significant one', () => {
		// A most-significant-byte add (the legacy `offsetCoord`) would leave every byte but
		// the first untouched. An LSB add does the opposite.
		const out = ringOffset(ZERO, 1)
		expect(out[COORD_BYTES - 1]).to.equal(1)
		expect(out[0]).to.equal(0)
	})

	it('propagates carry across all 32 bytes on decrement-from-zero (borrow the whole way)', () => {
		const out = ringOffset(ZERO, -1)
		expect(toBigInt(out)).to.equal(RING - 1n)
		for (const byte of out) expect(byte).to.equal(0xff)
	})

	it('propagates carry across all 32 bytes on increment-past-all-ff (wraps to zero)', () => {
		const out = ringOffset(ALL_FF, 1)
		expect(toBigInt(out)).to.equal(0n)
	})

	// Callers offset one base coordinate several times over — `dialability.spec.ts` derives five
	// seeded positions from a single hashed key — so an in-place edit would silently corrupt
	// every offset after the first.
	it('does not mutate its input', () => {
		const base = new Uint8Array(MID)
		ringOffset(base, -1)
		expect(toBigInt(base)).to.equal(toBigInt(MID))
	})

	// The general statement of everything above: whatever the base and delta, the result is the
	// exact 256-bit sum. A carry dropped at any byte, or a delta applied at the wrong byte,
	// fails here — which is the class of bug this helper exists to retire, not just its
	// instances.
	it('matches BigInt arithmetic mod 2^256 for arbitrary base and delta', () => {
		fc.assert(fc.property(
			fc.uint8Array({ minLength: COORD_BYTES, maxLength: COORD_BYTES }),
			fc.integer({ min: -1_000_000, max: 1_000_000 }),
			(base, delta) => {
				const expected = ((toBigInt(base) + BigInt(delta)) % RING + RING) % RING
				return toBigInt(ringOffset(base, delta)) === expected
			}
		), { numRuns: 500 })
	})

	for (const delta of [-5, -2, -1, 0, 1, 2, 5]) {
		for (const [name, base] of [['ZERO', ZERO], ['ALL_FF', ALL_FF], ['MID', MID]] as const) {
			it(`round-trips ${name} through ${delta} then ${-delta}`, () => {
				const out = ringOffset(ringOffset(base, delta), -delta)
				expect(toBigInt(out)).to.equal(toBigInt(base))
			})

			it(`minDistance(ringOffset(${name}, ${delta}), ${name}) === |${delta}|`, () => {
				const dist = minDistance(ringOffset(base, delta), base)
				expect(toBigInt(dist)).to.equal(BigInt(Math.abs(delta)))
			})
		}
	}
})

describe('oppositeCoord', () => {
	it('flips the top bit, landing exactly half the ring away', () => {
		const dist = minDistance(oppositeCoord(ZERO), ZERO)
		expect(toBigInt(dist)).to.equal(RING >> 1n)
	})

	it('is its own inverse', () => {
		expect(toBigInt(oppositeCoord(oppositeCoord(MID)))).to.equal(toBigInt(MID))
	})

	it('does not mutate its input', () => {
		const base = new Uint8Array(MID)
		oppositeCoord(base)
		expect(toBigInt(base)).to.equal(toBigInt(MID))
	})
})
