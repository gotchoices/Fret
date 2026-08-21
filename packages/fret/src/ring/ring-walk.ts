import type { DigitreeStore, PeerEntry } from '../store/digitree-store.js';

/** Options for {@link ringNeighborsBothSides}. */
export interface RingWalkOptions {
	/**
	 * Predicate passed *into* the store walk, never applied to its result.
	 *
	 * Filtering the returned array instead shrinks the window below the requested count even
	 * when the ring holds enough admissible peers — the same rule the cohort assembly and the
	 * routing-candidate paths follow. The store skips and keeps advancing on a miss, so a
	 * cluster of non-matching peers sitting nearest `coord` cannot starve either side.
	 *
	 * Must be **pure** (same entry, same answer): the store's ring walk exits on the first
	 * repeated id and so relies on the first match re-matching after a lap. This helper
	 * therefore never wraps the caller's predicate in anything stateful — exclusion happens
	 * *after* the walk, on the returned id list.
	 */
	filter?: (e: PeerEntry) => boolean;
	/** Additional ids to drop. Self is excluded separately and always. */
	exclude?: ReadonlySet<string>;
}

/**
 * Union of the `count` ring neighbors on each side of `coord`, self-excluded and deduped,
 * returned **side-interleaved** (s1, p1, s2, p2, ...).
 *
 * This is the one two-sided ring walk. It exists because the idiom was copy-pasted across the
 * service with three defects baked into every copy:
 *
 * 1. **Off-by-one against the configured window.** A walk anchored *exactly* on a stored
 *    coordinate returns that entry as its own first result on **both** sides — `ceilPath` seeks
 *    `hex(coord)` followed by `|` and a NUL, `floorPath` seeks `hex(coord)` followed by `|` and
 *    U+FFFF and steps back, so an entry sitting at `coord` matches either way. A self-anchored
 *    `neighborsRight(selfCoord, m)` therefore yields self plus only `m - 1` other peers, and the
 *    ubiquitous trailing `.filter(id => id !== selfStr)` was the tell: the count had already been
 *    spent on self. Hence `count` here means *peers besides self*, and each side is asked for
 *    `count + 1 + exclude.size` and trimmed back to `count` after exclusion. The over-fetch is
 *    exact either way: when an entry sits on `coord` the extra slot pays for it, and when none
 *    does the trim removes the surplus. Excluded ids consume walk slots too, which is why
 *    `exclude.size` is in the over-fetch rather than only the `+ 1` for self.
 * 2. **A cap applied to the concatenation of the two walks.** Bounding `[...right, ...left]`
 *    eats the *second* walk, so the predecessor side is what disappears. There is deliberately
 *    **no** `limit` parameter here: a caller that needs a budget slices its own result, and in
 *    doing so has to decide explicitly whether it is bounding *who we contact* or *what our
 *    window is*. This helper only ever answers the second.
 * 3. **Side-major ordering**, which makes any downstream truncation lose one whole side.
 *    Interleaving means a truncated result loses the outermost peers on both sides instead —
 *    which retires that consequence regardless of what any caller does afterwards.
 *
 * A `count <= 0` ask returns empty rather than over-fetching `1` and handing back a peer; the
 * store already treats a non-positive count as empty, but the over-fetch would defeat that (the
 * reachable case is a degenerate `m` of 0 in the config).
 *
 * Everything else the store already guarantees and is deliberately not restated here: both
 * walks return distinct ids, a walk that laps the ring exits on the first repeated id (so a ring
 * smaller than `count` returns the whole ring — never duplicates, never pads, never spins), and
 * a filtered walk is capped at one full traversal (so a filter matching nothing terminates).
 */
export function ringNeighborsBothSides(
	store: DigitreeStore,
	coord: Uint8Array,
	count: number,
	selfId: string,
	opts?: RingWalkOptions
): string[] {
	if (count <= 0) return [];
	const exclude = opts?.exclude;
	const drop = (id: string): boolean => id === selfId || exclude?.has(id) === true;
	const reach = count + 1 + (exclude?.size ?? 0);
	const successors = trimSide(store.neighborsRight(coord, reach, opts?.filter), count, drop);
	const predecessors = trimSide(store.neighborsLeft(coord, reach, opts?.filter), count, drop);
	return interleave(successors, predecessors);
}

/** Drops excluded ids from one over-fetched side, then trims it back to `count`. */
function trimSide(ids: readonly string[], count: number, drop: (id: string) => boolean): string[] {
	const out: string[] = [];
	for (const id of ids) {
		if (drop(id)) continue;
		out.push(id);
		if (out.length >= count) break;
	}
	return out;
}

/**
 * Weaves two sides into one deduped list: s1, p1, s2, p2, ...
 *
 * NOTE: the unequal-length branch is unreachable through {@link ringNeighborsBothSides} as it
 * stands — both walks lap the whole ring, so each side yields exactly
 * `min(count, reachable ring size)` and the two are always equal. It is written for the general
 * case anyway because assuming equal lengths would fail *silently* (a trailing `undefined`, or a
 * dropped tail) if the per-side trim ever grew a side-specific rule, and the guard costs one
 * `Math.max`. `test/ring-walk.spec.ts` pins the equal-length invariant so a change to it is
 * visible.
 */
function interleave(a: readonly string[], b: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (id: string | undefined): void => {
		if (id === undefined || seen.has(id)) return;
		seen.add(id);
		out.push(id);
	};
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		push(a[i]);
		push(b[i]);
	}
	return out;
}
