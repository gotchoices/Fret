import { COORD_BYTES } from '../../src/ring/hash.js'

/** 2^256 — the ring's full span. */
const RING = 1n << BigInt(COORD_BYTES * 8)

/**
 * NOTE: this module is the landing place for coordinate arithmetic hand-rolled inside specs.
 * Copies still living in `test/ring.properties.spec.ts` (`toCoord`, `refMinDistance`) and
 * `test/size-estimator.spec.ts` (`bigIntToCoord`) should migrate here rather than multiply.
 */

/**
 * `base` shifted by `delta` ring units, exact modulo 2^256. The delta is added at the
 * *least-significant* byte (index `length - 1`) with carry/borrow propagated leftward across
 * every byte — dropping the carry anywhere along the chain would change the coordinate by more
 * than `delta`. This is the load-bearing half of the helper: a naive single-byte add is
 * silently wrong at the wrap (`(0 - 1) & 0xff` is 255, a change of +255, not -1), which is
 * exactly the class of bug this replaces. Any overflow out of byte 0 is the modulo-2^256
 * wraparound and is discarded, same as it would be for a 256-bit register.
 *
 * Offsets here are meant to be *near* a target on the ring — a handful of units — which is
 * only true at this least-significant-byte scale. The legacy helper this replaced added its
 * delta into the most-significant byte, so one "step" was 2^248 ring units: 1/128th of the
 * ring's full span, not a nearby point. That made seeded "near" candidates actually scattered
 * across a wide arc, which is what let a uniformly random self coordinate land among them by
 * chance and made the calling specs flaky.
 */
export function ringOffset(base: Uint8Array, delta: number): Uint8Array {
	const out = new Uint8Array(base.length)
	let carry = delta
	for (let i = base.length - 1; i >= 0; i--) {
		const v = (base[i] ?? 0) + carry
		carry = Math.floor(v / 256)
		out[i] = ((v % 256) + 256) % 256
	}
	return out
}

/**
 * Ring coordinate exactly half the ring away from `base` (top bit flipped) — exact regardless
 * of scale.
 *
 * NOTE: no spec calls this today; it is kept deliberately rather than deleted. Hand-rolled
 * coordinate arithmetic in a spec is precisely what produced the flake this module replaced, so
 * a correct, tested "half the ring away" is worth more here than a smaller export surface.
 */
export function oppositeCoord(base: Uint8Array): Uint8Array {
	const c = new Uint8Array(base)
	c[0] = (c[0]! ^ 0x80) & 0xff
	return c
}

/** Big-endian ring coordinate as a bigint — the shared oracle for coordinate assertions. */
export function toBigInt(u: Uint8Array): bigint {
	let v = 0n
	for (const b of u) v = (v << 8n) | BigInt(b)
	return v
}

/**
 * Big-endian bigint → ring coordinate, reduced mod 2^256 so a negative or over-wide value
 * still yields a well-formed coordinate.
 */
export function toCoord(v: bigint): Uint8Array {
	let x = ((v % RING) + RING) % RING
	const out = new Uint8Array(COORD_BYTES)
	for (let i = COORD_BYTES - 1; i >= 0; i--) {
		out[i] = Number(x & 0xffn)
		x >>= 8n
	}
	return out
}

/**
 * Independent BigInt oracle for the ring metric — deliberately shares no code with
 * `src/ring/distance.ts`, so a bug in `clockwiseDistance` or `lexLess` cannot hide behind a
 * spec that re-derives the answer from the same helpers. Only `COORD_BYTES`, a width constant,
 * is taken from `src/`.
 */
export function refMinDistance(a: Uint8Array, b: Uint8Array): bigint {
	const cw = (toBigInt(b) - toBigInt(a) + RING) % RING
	return cw <= RING - cw ? cw : RING - cw
}
