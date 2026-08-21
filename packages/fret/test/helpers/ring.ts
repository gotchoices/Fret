import { COORD_BYTES } from '../../src/ring/hash.js'

/** 2^256 — the ring's full span. */
const RING = 1n << BigInt(COORD_BYTES * 8)

/**
 * `base` shifted by `delta` ring units — the exact 256-bit sum, reduced mod 2^256. Any
 * magnitude works, not only nearby offsets, and a negative `delta` borrows across the wrap
 * (`ringOffset(ZERO, -1)` is all-`0xff`). The input is never mutated, and the result is always
 * `COORD_BYTES` wide regardless of `base.length` — every caller passes a 32-byte coordinate,
 * so that is inert today.
 *
 * Do not hand-roll this again as byte arithmetic. The legacy helper added its delta into the
 * *most*-significant byte, so one "step" was 2^248 ring units — 1/128th of the ring rather
 * than a nearby point — which scattered seeded "near" candidates across a wide arc and made
 * the calling specs flaky.
 */
export function ringOffset(base: Uint8Array, delta: number | bigint): Uint8Array {
	return toCoord(toBigInt(base) + BigInt(delta))
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
