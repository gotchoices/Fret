/** Inverse of toCoord in test/helpers/ring.ts: 32-byte big-endian Uint8Array -> BigInt. */
export function coordToBigInt(coord: Uint8Array): bigint {
	let v = 0n
	for (let i = 0; i < 32; i++) {
		v = (v << 8n) | BigInt(coord[i]!)
	}
	return v
}

/**
 * How clumped a ring is: scan an arc one even-spacing wide (ringSize / peers) anchored at each
 * peer in turn, wrapping, and return the most peers any such arc contains.
 *
 * This replaced a largest-gap-over-even-spacing statistic, which was vacuous here: piling every
 * joiner into one sliver makes that sliver denser while the surviving evenly-placed initial
 * population still holds the largest hole down, so the number barely moves — and on the pure
 * batch-join case the buggy and fixed placements produced bit-identical readings.
 */
export function maxPeersInOneSpacingArc(coords: readonly bigint[]): number {
	const ringSize = 1n << 256n
	const sorted = [...coords].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
	if (sorted.length === 0) return 0
	const arcWidth = ringSize / BigInt(sorted.length)

	let worst = 0
	for (const anchor of sorted) {
		let inArc = 0
		for (const other of sorted) {
			const offset = (other - anchor + ringSize) % ringSize
			if (offset < arcWidth) inArc++
		}
		if (inArc > worst) worst = inArc
	}
	return worst
}

/** Seeds every placement reading below is taken over. */
export const PLACEMENT_SEEDS = [8008, 8009, 8010, 4242, 99]

/**
 * Peers-in-one-even-spacing-arc readings, over PLACEMENT_SEEDS at n=40 / k=15 / m=8 /
 * stabilize 500ms / 10s:
 *
 *   join pattern     uniform (fixed)   clumped-joiners (the bug)
 *   batch burst      3 3 3 3 3         11 11 11 11 11
 *   steady trickle   3 3 3 4 3         18 18 16 16 16
 *
 * Worst fixed reading 4, best buggy reading 11, nothing in between — so 7 sits 1.75x above
 * everything the fixed placement produced and 1.57x below everything the bug produced. Both
 * arms are asserted below, so the threshold's separating power is re-proved on every run
 * rather than measured once at authoring time.
 */
export const MAX_PEERS_IN_ONE_SPACING_ARC = 7
