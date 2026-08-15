export function lexLess(a: Uint8Array, b: Uint8Array): boolean {
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
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
	const cw = clockwiseDistance(a, b);
	const ccw = clockwiseDistance(b, a);
	// Both arcs are max(a.length, b.length) bytes wide, so a big-endian byte
	// compare is a magnitude compare here.
	return lexLess(ccw, cw) ? ccw : cw;
}
