import { describe, it } from 'mocha'
import { expect } from 'chai'
import fc from 'fast-check'
import { xorDistance, clockwiseDistance, lexLess } from '../src/ring/distance.js'
import {
	coordToHex, hexToCoord,
	coordToBase64url, base64urlToCoord,
	COORD_BYTES,
} from '../src/ring/hash.js'

const arbCoord = fc.uint8Array({ minLength: COORD_BYTES, maxLength: COORD_BYTES })

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
	return true
}

function isAllZero(u: Uint8Array): boolean {
	for (let i = 0; i < u.length; i++) if (u[i] !== 0) return false
	return true
}

/** Add two 256-bit big-endian unsigned integers mod 2^256 */
function addMod(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(COORD_BYTES)
	let carry = 0
	for (let i = COORD_BYTES - 1; i >= 0; i--) {
		const s = (a[i] ?? 0) + (b[i] ?? 0) + carry
		out[i] = s & 0xff
		carry = s >> 8
	}
	return out
}

describe('Ring arithmetic properties', function () {
	this.timeout(30_000)

	const opts = { numRuns: 200 }

	describe('xorDistance', () => {
		it('is symmetric: d(a,b) = d(b,a)', () => {
			fc.assert(fc.property(arbCoord, arbCoord, (a, b) => {
				return bytesEqual(xorDistance(a, b), xorDistance(b, a))
			}), opts)
		})

		it('self-distance is zero', () => {
			fc.assert(fc.property(arbCoord, (a) => {
				return isAllZero(xorDistance(a, a))
			}), opts)
		})

		it('identity of indiscernibles: d(a,b) = 0 iff a = b', () => {
			fc.assert(fc.property(arbCoord, arbCoord, (a, b) => {
				const dist = xorDistance(a, b)
				if (isAllZero(dist)) return bytesEqual(a, b)
				return !bytesEqual(a, b)
			}), opts)
		})
	})

	describe('clockwiseDistance', () => {
		it('self-distance is zero', () => {
			fc.assert(fc.property(arbCoord, (a) => {
				return isAllZero(clockwiseDistance(a, a))
			}), opts)
		})

		it('cw(a,b) + cw(b,a) = 2^256 for distinct a,b', () => {
			fc.assert(fc.property(arbCoord, arbCoord, (a, b) => {
				if (bytesEqual(a, b)) return true // skip equal case
				const ab = clockwiseDistance(a, b)
				const ba = clockwiseDistance(b, a)
				const sum = addMod(ab, ba)
				// 2^256 mod 2^256 = 0
				return isAllZero(sum)
			}), opts)
		})

		it('is non-negative (never negative result bytes)', () => {
			fc.assert(fc.property(arbCoord, arbCoord, (a, b) => {
				const d = clockwiseDistance(a, b)
				return d.length === Math.max(a.length, b.length)
			}), opts)
		})
	})

	describe('lexLess', () => {
		it('is irreflexive: !lexLess(a, a)', () => {
			fc.assert(fc.property(arbCoord, (a) => {
				return !lexLess(a, a)
			}), opts)
		})

		it('is antisymmetric: lexLess(a,b) implies !lexLess(b,a)', () => {
			fc.assert(fc.property(arbCoord, arbCoord, (a, b) => {
				if (lexLess(a, b)) return !lexLess(b, a)
				return true
			}), opts)
		})

		it('is total for distinct coords: exactly one of lexLess(a,b) or lexLess(b,a)', () => {
			fc.assert(fc.property(arbCoord, arbCoord, (a, b) => {
				if (bytesEqual(a, b)) return !lexLess(a, b) && !lexLess(b, a)
				return lexLess(a, b) !== lexLess(b, a)
			}), opts)
		})

		it('is transitive', () => {
			fc.assert(fc.property(arbCoord, arbCoord, arbCoord, (a, b, c) => {
				if (lexLess(a, b) && lexLess(b, c)) return lexLess(a, c)
				return true
			}), opts)
		})
	})

	describe('coordinate encoding round-trips', () => {
		it('hex round-trip: hexToCoord(coordToHex(c)) = c', () => {
			fc.assert(fc.property(arbCoord, (c) => {
				return bytesEqual(hexToCoord(coordToHex(c)), c)
			}), opts)
		})

		it('base64url round-trip: base64urlToCoord(coordToBase64url(c)) = c', () => {
			fc.assert(fc.property(arbCoord, (c) => {
				return bytesEqual(base64urlToCoord(coordToBase64url(c)), c)
			}), opts)
		})
	})
})
