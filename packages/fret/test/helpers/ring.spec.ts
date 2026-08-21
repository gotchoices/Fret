import { describe, it } from 'mocha'
import { expect } from 'chai'
import fc from 'fast-check'
import { ringOffset, oppositeCoord, toBigInt, toCoord, refMinDistance } from './ring.js'
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

	// The bigint arm of the `number | bigint` signature: `pick-anchors.spec.ts` offsets by
	// `1n << 200n`, a magnitude no `number` can represent exactly, and its assertions are about
	// anchor ordering rather than about the offset. Pin the arithmetic here instead.
	it('matches BigInt arithmetic mod 2^256 for bigint deltas beyond 2^53', () => {
		fc.assert(fc.property(
			fc.uint8Array({ minLength: COORD_BYTES, maxLength: COORD_BYTES }),
			// Floored at 2^54 so every run is a magnitude `number` cannot represent exactly —
			// the arm is provably exercised rather than merely reachable.
			fc.bigInt({ min: 1n << 54n, max: RING - 1n }),
			fc.boolean(),
			(base, magnitude, negative) => {
				const d = negative ? -magnitude : magnitude
				const expected = ((toBigInt(base) + d) % RING + RING) % RING
				return toBigInt(ringOffset(base, d)) === expected
			}
		), { numRuns: 500 })
	})

	it('gives identical bytes for a number delta and the equivalent bigint delta', () => {
		for (const delta of [-1_000_000, -1, 0, 1, 1_000_000]) {
			expect(toBigInt(ringOffset(MID, delta))).to.equal(toBigInt(ringOffset(MID, BigInt(delta))))
		}
	})
})

// `refMinDistance` is the independent oracle `ring.properties.spec.ts` checks the shipped
// `minDistance` against, so a bug in it would let that property pass against a wrong answer.
// These vectors are hand-computed and deliberately do NOT consult `src/ring/distance.ts` —
// independence from that module is the whole reason the oracle exists.
describe('refMinDistance', () => {
	const ONE = toCoord(1n)

	it('is 0 for a coordinate against itself', () => {
		expect(refMinDistance(ZERO, ZERO)).to.equal(0n)
	})

	it('is 1 for adjacent coordinates', () => {
		expect(refMinDistance(ZERO, ONE)).to.equal(1n)
	})

	// The short way round the wrap, not the long way: ALL_FF sits one unit *below* ZERO.
	it('measures across the wrap, not around it', () => {
		expect(refMinDistance(ZERO, ALL_FF)).to.equal(1n)
	})

	it('is 2^255 for antipodal coordinates — the metric maximum', () => {
		expect(refMinDistance(ZERO, oppositeCoord(ZERO))).to.equal(RING >> 1n)
		expect(refMinDistance(MID, oppositeCoord(MID))).to.equal(RING >> 1n)
	})

	it('is symmetric and never exceeds half the ring', () => {
		fc.assert(fc.property(
			fc.uint8Array({ minLength: COORD_BYTES, maxLength: COORD_BYTES }),
			fc.uint8Array({ minLength: COORD_BYTES, maxLength: COORD_BYTES }),
			(a, b) => refMinDistance(a, b) === refMinDistance(b, a) && refMinDistance(a, b) <= RING >> 1n
		), { numRuns: 500 })
	})
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
