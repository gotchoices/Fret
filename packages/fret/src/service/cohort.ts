import type { DigitreeStore, PeerEntry } from '../store/digitree-store.js';

/**
 * Two-sided cohort assembly: an alternating successor/predecessor walk outward from
 * `hashedCoord`, returning up to `wants` distinct peer ids. Auto-adapts when fewer than
 * `wants` peers exist (`n < k`) by returning whatever the ring holds.
 *
 * Pure over the store — no libp2p/node state — so the same selection logic is shared by
 * `FretService.assembleCohort` and out-of-band consumers (e.g. the Optimystic design
 * simulator) with zero divergence.
 *
 * `filter` is forwarded to the underlying ring walks: with it, the walk skips non-matching
 * entries and keeps advancing (so a cluster of foreign peers near the key can't starve the
 * cohort — the over-fetch of `wants * 2` plus skip-and-continue still reaches `wants`
 * matching members). Defaults to no filter, leaving the standalone/simulator path unchanged.
 */
export function assembleCohort(
	store: DigitreeStore,
	hashedCoord: Uint8Array,
	wants: number,
	exclude?: Set<string>,
	filter?: (e: PeerEntry) => boolean
): string[] {
	const out: string[] = [];
	const ex = exclude ?? new Set<string>();
	const succIds = store.neighborsRight(hashedCoord, wants * 2, filter);
	const predIds = store.neighborsLeft(hashedCoord, wants * 2, filter);
	let si = 0,
		pi = 0;
	while (out.length < wants && (si < succIds.length || pi < predIds.length)) {
		if (out.length % 2 === 0 && si < succIds.length) {
			const id = succIds[si++];
			if (id && !ex.has(id)) out.push(id);
		} else if (pi < predIds.length) {
			const id = predIds[pi++];
			if (id && !ex.has(id)) out.push(id);
		} else if (si < succIds.length) {
			const id = succIds[si++];
			if (id && !ex.has(id)) out.push(id);
		}
	}
	return Array.from(new Set(out)).slice(0, wants);
}
