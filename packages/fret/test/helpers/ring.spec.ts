import { describe, it } from 'mocha'
import { expect } from 'chai'
import { ringOffset, oppositeCoord, COORD_BYTES } from './ring.js'
import { minDistance } from '../../src/ring/distance.js'

function toBigInt(u: Uint8Array): bigint {
	let v = 0n
	for (const b of u) v = (v << 8n) | BigInt(b)
	return v
}

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
		expect(toBigInt(out)).to.equal((1n << 256n) - 1n)
		for (const byte of out) expect(byte).to.equal(0xff)
	})

	it('propagates carry across all 32 bytes on increment-past-all-ff (wraps to zero)', () => {
		const out = ringOffset(ALL_FF, 1)
		expect(toBigInt(out)).to.equal(0n)
	})

	for (const delta of [-5, -2, -1, 0, 1, 2, 5]) {
		for (const [name, base] of [['ZERO', ZERO], ['ALL_FF', ALL_FF], ['MID', MID]] as const) {
			it(`round-trips ${name} through +${delta} then -${delta}`, () => {
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
		expect(toBigInt(dist)).to.equal(1n << 255n)
	})

	it('is its own inverse', () => {
		expect(toBigInt(oppositeCoord(oppositeCoord(MID)))).to.equal(toBigInt(MID))
	})
})
