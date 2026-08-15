/**
 * Payload inclusion heuristic — decides whether to include the activity
 * payload in a RouteAndMaybeAct message based on proximity to the target
 * cluster and current confidence in the size estimate.
 *
 * When the estimated probability of being in-cluster exceeds threshold T,
 * the payload should be included to save an extra round-trip.
 */

function bytesToBigInt(u8: Uint8Array): bigint {
	let v = 0n;
	for (let i = 0; i < u8.length; i++) v = (v << 8n) | BigInt(u8[i]!);
	return v;
}

const RING_SIZE = 1n << 256n;

/**
 * Estimate the probability that the given distance falls within the cluster
 * span, scaled by confidence.
 *
 * @param distToKey  Ring distance from self (or candidate) to the target key —
 *   `minDistance`, the shorter of the two arcs.  It must be an arc length, since
 *   the near-zone it is compared against is derived from the ring circumference.
 * @param sizeEstimate  Estimated number of peers in the network.
 * @param confidence  Confidence in the size estimate [0,1].
 * @param k  Cluster size target.
 * @param beta  Multiplier on the cluster span to create a "near" zone (default 2).
 * @param threshold  Minimum probability to include payload (default 0.5).
 */
export function shouldIncludePayload(
	distToKey: Uint8Array,
	sizeEstimate: number,
	confidence: number,
	k: number,
	beta = 2,
	threshold = 0.5
): boolean {
	if (sizeEstimate < 1 || confidence <= 0) return false;

	const dist = bytesToBigInt(distToKey);
	// clusterSpan ≈ k * (2^256 / n_est)
	const clusterSpan = BigInt(k) * (RING_SIZE / BigInt(Math.max(1, Math.round(sizeEstimate))));
	const nearZone = clusterSpan * BigInt(beta);

	if (nearZone === 0n) return false;
	if (dist > nearZone) return false;

	// Linear probability falloff within the near zone
	const probability = Number(nearZone - dist) / Number(nearZone);
	return probability * confidence >= threshold;
}

/**
 * Compute the near-radius for routing decisions.
 * nearRadius ≈ β × clusterSpan where clusterSpan = k × (2^256 / n_est).
 *
 * Returns a 32-byte Uint8Array representing the near radius as a big-endian
 * integer, suitable for comparison with ring distances (`minDistance`).
 */
export function computeNearRadius(
	sizeEstimate: number,
	k: number,
	beta = 2
): Uint8Array {
	const out = new Uint8Array(32);
	if (sizeEstimate < 1) return out;

	const span = BigInt(k) * (RING_SIZE / BigInt(Math.max(1, Math.round(sizeEstimate))));
	let val = span * BigInt(beta);
	// Clamp to ring size.
	// NOTE: ring distance never exceeds half the ring (2^255), so once n_est drops
	// below ~2·β·k (≈60 at the defaults) the radius covers every possible distance
	// and the selector's cost path treats all candidates as near — pure strict
	// distance, no connected-first bias.  That is the right reading for a network
	// that small (the cluster really is a quarter of the ring), and it is what the
	// XOR metric did too, so it is not a regression.  If profiles ever want the
	// connection bias back on small rings, cap at 2^255 and scale β instead.
	if (val >= RING_SIZE) val = RING_SIZE - 1n;

	for (let i = 31; i >= 0; i--) {
		out[i] = Number(val & 0xffn);
		val >>= 8n;
	}
	return out;
}
