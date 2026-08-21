import { describe, it } from 'mocha'
import { expect } from 'chai'
import fc from 'fast-check'
import { minDistance, clockwiseDistance, lexLess, normalizedLogMagnitude } from '../src/ring/distance.js'
import {
	coordToHex, hexToCoord,
	coordToBase64url, base64urlToCoord,
	COORD_BYTES,
} from '../src/ring/hash.js'
import { toBigInt, toCoord, refMinDistance } from './helpers/ring.js'

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

/** 2^255 — half the ring; the largest value a min-arc distance can take. */
const HALF_RING = (() => {
	const u = new Uint8Array(COORD_BYTES)
	u[0] = 0x80
	return u
})()

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

const RING = 1n << BigInt(COORD_BYTES * 8)

describe('Ring arithmetic properties', function () {
	this.timeout(30_000)

	const opts = { numRuns: 200 }

	describe('minDistance', () => {
		it('is symmetric: d(a,b) = d(b,a)', () => {
			fc.assert(fc.property(arbCoord, arbCoord, (a, b) => {
				return bytesEqual(minDistance(a, b), minDistance(b, a))
			}), opts)
		})

		it('self-distance is zero', () => {
			fc.assert(fc.property(arbCoord, (a) => {
				return isAllZero(minDistance(a, a))
			}), opts)
		})

		it('identity of indiscernibles: d(a,b) = 0 iff a = b', () => {
			fc.assert(fc.property(arbCoord, arbCoord, (a, b) => {
				const dist = minDistance(a, b)
				if (isAllZero(dist)) return bytesEqual(a, b)
				return !bytesEqual(a, b)
			}), opts)
		})

		it('never exceeds half the ring (2^255)', () => {
			fc.assert(fc.property(arbCoord, arbCoord, (a, b) => {
				return !lexLess(HALF_RING, minDistance(a, b))
			}), opts)
		})

		it('is the smaller of the two arcs', () => {
			fc.assert(fc.property(arbCoord, arbCoord, (a, b) => {
				const cw = clockwiseDistance(a, b)
				const ccw = clockwiseDistance(b, a)
				const smaller = lexLess(ccw, cw) ? ccw : cw
				return bytesEqual(minDistance(a, b), smaller)
			}), opts)
		})

		it('matches an independent BigInt reference', () => {
			fc.assert(fc.property(arbCoord, arbCoord, (a, b) => {
				return toBigInt(minDistance(a, b)) === refMinDistance(a, b)
			}), opts)
		})

		it('satisfies the triangle inequality: d(a,c) ≤ d(a,b) + d(b,c)', () => {
			fc.assert(fc.property(arbCoord, arbCoord, arbCoord, (a, b, c) => {
				return toBigInt(minDistance(a, c))
					<= toBigInt(minDistance(a, b)) + toBigInt(minDistance(b, c))
			}), opts)
		})

		it('is exactly half the ring at the antipode, from both directions', () => {
			fc.assert(fc.property(arbCoord, (a) => {
				const anti = toCoord(toBigInt(a) + (RING >> 1n))
				return bytesEqual(minDistance(a, anti), HALF_RING)
					&& bytesEqual(minDistance(anti, a), HALF_RING)
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

		// Right-alignment: a short operand is the smaller-width integer it looks
		// like, not that integer scaled up by the missing bytes.  A left-aligned
		// compare reads [0x01] as 2^248 and calls it larger than a full-width 2.
		it('treats a shorter operand as zero-padded on the left', () => {
			fc.assert(fc.property(
				fc.uint8Array({ minLength: 1, maxLength: COORD_BYTES }),
				fc.uint8Array({ minLength: 1, maxLength: COORD_BYTES }),
				(a, b) => {
					const pad = (u: Uint8Array) => {
						const out = new Uint8Array(COORD_BYTES)
						out.set(u, COORD_BYTES - u.length)
						return out
					}
					return lexLess(a, b) === lexLess(pad(a), pad(b))
				}
			), opts)
		})

		it('orders a short operand against a wide one by magnitude', () => {
			expect(lexLess(new Uint8Array([0x01]), toCoord(2n))).to.equal(true)
			expect(lexLess(toCoord(2n), new Uint8Array([0x01]))).to.equal(false)
		})
	})

	describe('normalizedLogMagnitude', () => {
		it('is 0 for a zero distance and 1 at the antipode', () => {
			expect(normalizedLogMagnitude(new Uint8Array(COORD_BYTES))).to.equal(0)
			expect(normalizedLogMagnitude(HALF_RING)).to.equal(1)
		})

		it('stays within [0,1] for every ring distance', () => {
			fc.assert(fc.property(arbCoord, arbCoord, (a, b) => {
				const x = normalizedLogMagnitude(minDistance(a, b))
				return x >= 0 && x <= 1
			}), opts)
		})

		// Only the antipode sets the top bit, so every other pair is capped a
		// step below 1 — the claim docs/fret.md makes about the KDE's x axis.
		it('caps below 1 for every non-antipodal pair', () => {
			fc.assert(fc.property(arbCoord, arbCoord, (a, b) => {
				const d = minDistance(a, b)
				if (bytesEqual(d, HALF_RING)) return true
				return normalizedLogMagnitude(d) <= 1 - 1 / 256
			}), opts)
		})

		it('is monotone non-decreasing in magnitude', () => {
			fc.assert(fc.property(arbCoord, arbCoord, (a, b) => {
				const [lo, hi] = lexLess(b, a) ? [b, a] : [a, b]
				return normalizedLogMagnitude(lo!) <= normalizedLogMagnitude(hi!)
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

		it('base64urlToCoord throws on wrong-length input', () => {
			expect(() => base64urlToCoord('')).to.throw()
			expect(() => base64urlToCoord(coordToBase64url(new Uint8Array(COORD_BYTES - 1)))).to.throw()
			expect(() => base64urlToCoord(coordToBase64url(new Uint8Array(COORD_BYTES + 1)))).to.throw()
		})

		it('hexToCoord throws on wrong-length input', () => {
			expect(() => hexToCoord('')).to.throw()
			expect(() => hexToCoord('ab'.repeat(COORD_BYTES - 1))).to.throw()
			expect(() => hexToCoord('ab'.repeat(COORD_BYTES + 1))).to.throw()
		})

		it('hexToCoord throws on non-hex charset instead of coercing to zero bytes', () => {
			expect(() => hexToCoord('zz'.repeat(COORD_BYTES))).to.throw()
			expect(() => hexToCoord('gg' + 'ab'.repeat(COORD_BYTES - 1))).to.throw()
		})
	})
})
