/**
 * Magnitude compare of two big-endian unsigned integers: `a < b`.
 *
 * Operands are right-aligned — a shorter array is read as zero-padded on the
 * *left*, which is what it is numerically, and matches the arithmetic in
 * `clockwiseDistance`.  Comparing from index 0 would instead read a 16-byte
 * value as a 32-byte one scaled by 2^128.  Equal-length inputs (every caller
 * today) compare byte-for-byte from the top, unchanged.
 */
export function lexLess(a: Uint8Array, b: Uint8Array): boolean {
	const len = Math.max(a.length, b.length);
	for (let i = len - 1; i >= 0; i--) {
		const av = a[a.length - 1 - i] ?? 0;
		const bv = b[b.length - 1 - i] ?? 0;
		if (av < bv) return true;
		if (av > bv) return false;
	}
	return false;
}

export function clockwiseDistance(a: Uint8Array, b: Uint8Array): Uint8Array {
	// distance from a to b moving forward (a < b ? b-a : 2^n - (a-b))
	const len = Math.max(a.length, b.length);
	const out = new Uint8Array(len);
	let borrow = 0;
	// Compute b - a mod 2^n
	for (let i = 0; i < len; i++) {
		const ai = a[a.length - 1 - i] ?? 0;
		const bi = b[b.length - 1 - i] ?? 0;
		let v = bi - ai - borrow;
		if (v < 0) {
			v += 256;
			borrow = 1;
		} else {
			borrow = 0;
		}
		out[len - 1 - i] = v;
	}
	return out;
}

/**
 * True ring distance: the shorter of the two arcs between a and b, on a ring of
 * 2^(8·len).  This is the single distance metric FRET uses — routing, payload
 * inclusion, and the relevance sparsity model all measure with it, so the
 * wrap-around point behaves like every other point on the ring.  Maximum value
 * is 2^(8·len − 1) (half the ring), not 2^(8·len) − 1.
 */
export function minDistance(a: Uint8Array, b: Uint8Array): Uint8Array {
	// NOTE: allocates both arcs (2 × 32 bytes) to discard one, on a path walked
	// per routing candidate and per relevance update.  Measured cost has not been
	// an issue; if distance ever shows up in a profile, compare the arcs in place
	// (cw < half-ring ⇒ cw is the shorter one) and build only the winner.
	const cw = clockwiseDistance(a, b);
	const ccw = clockwiseDistance(b, a);
	return lexLess(ccw, cw) ? ccw : cw;
}

/**
 * Position of a distance magnitude on a log scale, normalized to [0,1]: 0 for a
 * zero distance, rising toward 1 as the leading-zero-bit count falls.  Shared by
 * the next-hop cost function and the relevance sparsity model so both read the
 * ring at the same resolution.
 *
 * A `minDistance` result reaches exactly 1 only at the antipode (2^255, whose
 * top bit is set); every other pair lands at 1 − 1/256 or below.  The value is
 * consumed as a relative position, so that near-unreachable top step needs no
 * rescaling.
 */
export function normalizedLogMagnitude(dist: Uint8Array): number {
	const totalBits = dist.length * 8;
	if (totalBits === 0) return 0;
	let lzBits = 0;
	for (const byte of dist) {
		if (byte === 0) { lzBits += 8; continue; }
		lzBits += Math.clz32(byte) - 24; // clz32 counts over 32 bits; drop the 24 above the byte
		break;
	}
	return 1 - lzBits / totalBits;
}
