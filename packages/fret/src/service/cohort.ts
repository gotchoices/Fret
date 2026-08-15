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
 * cohort — the over-fetch plus skip-and-continue still reaches `wants` matching members).
 * Defaults to no filter, leaving the standalone/simulator path unchanged.
 *
 * Callers must pass exclusions via `exclude` rather than filtering the returned array:
 * excluded ids are skipped *during* the walk and the over-fetch is widened to cover them,
 * so the result still holds `wants` ids when the ring has them. Post-filtering instead
 * silently under-fills.
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
	const seen = new Set<string>();
	// Each walk over-fetches: `wants * 2` covers the two walks overlapping on a small ring,
	// `+ ex.size` covers the caller's exclusions landing entirely inside one walk's window.
	// Walks cap at the ring size, so an over-large request just returns every matching entry.
	// NOTE: an unfiltered walk shorter than `reach` re-circles the ring and dedups at the end,
	// so cost is O(reach), not O(n). Fine while exclusions stay small (breadcrumbs, self); if a
	// caller ever passes a large exclude set, cap `reach` at the store size instead.
	const reach = wants * 2 + ex.size;
	const succIds = store.neighborsRight(hashedCoord, reach, filter);
	const predIds = store.neighborsLeft(hashedCoord, reach, filter);
	let si = 0,
		pi = 0;
	const take = (id: string | undefined) => {
		if (id && !ex.has(id) && !seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	};
	while (out.length < wants && (si < succIds.length || pi < predIds.length)) {
		if (out.length % 2 === 0 && si < succIds.length) {
			take(succIds[si++]);
		} else if (pi < predIds.length) {
			take(predIds[pi++]);
		} else if (si < succIds.length) {
			take(succIds[si++]);
		}
	}
	// Distinct by construction, and the loop guard admits at most one id per pass — no
	// trailing dedup/truncation, which is what let the old version under-fill.
	return out;
}
