import type { DigitreeStore } from '../store/digitree-store.js'
import { minDistance, lexLess, normalizedLogMagnitude } from '../ring/distance.js'

export type LinkQuality = (id: string) => number; // [0..1]
export type IsConnected = (id: string) => boolean;
export type BackoffPenalty = (id: string) => number; // [0..1]

export interface NextHopOptions {
	/** Near-radius threshold; distances ≤ this trigger strict mode. */
	nearRadius?: Uint8Array;
	/**
	 * The caller's own ring coordinate. Supplied, near mode measures strict improvement
	 * against *our* distance to the target rather than only ordering candidates among
	 * themselves, so a near hop can never be farther from the key than we already are.
	 * Omitted, the selector behaves as it did before this option existed.
	 *
	 * Optional because not every caller is choosing a hop *for itself*, and one that is
	 * may still want to reach past itself — see "Next-hop selection heuristic" in
	 * `docs/fret.md` for which call sites supply it and why. Ignored on the legacy path
	 * (no `nearRadius`), like `connectedToleranceBytes` is on the cost path.
	 */
	selfCoord?: Uint8Array;
	/** Confidence in network size estimate [0,1]; adjusts weight balance. */
	confidence?: number;
	/** Per-peer backoff penalty [0,1]; penalizes recently-failed peers. */
	backoffPenalty?: BackoffPenalty;
	/**
	 * Legacy tolerance: connected peers within this many leading-zero-byte
	 * difference are preferred (default 1).  Ignored when nearRadius is set.
	 */
	connectedToleranceBytes?: number;
}

function leadingByteIndex(u8: Uint8Array): number {
	for (let i = 0; i < u8.length; i++) if (u8[i] !== 0) return i;
	return Number.POSITIVE_INFINITY;
}

/** Magnitude equality, right-aligned to match `lexLess`. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	return !lexLess(a, b) && !lexLess(b, a);
}

function betterByDist(idA: string, distA: Uint8Array, idB: string, distB: Uint8Array): boolean {
	if (lexLess(distA, distB)) return true;
	if (lexLess(distB, distA)) return false;
	return idA < idB;
}

function isNear(dist: Uint8Array, nearRadius: Uint8Array): boolean {
	return !lexLess(nearRadius, dist); // dist <= nearRadius
}

// ── Cost function (fret.md §A5) ──────────────────────────────────────
//
// cost(peer) = w_d·normDist − w_conn·connected − w_q·linkQ + w_b·backoff
//
// Weight balance shifts with proximity and confidence:
//   far  → higher w_conn, lower w_d, slack ε
//   near → higher w_d, lower w_conn, strict ε ≈ 0
//   low confidence  → increase w_conn
//   high confidence → increase w_d

interface CostWeights { wD: number; wConn: number; wQ: number; wB: number }

function weightsForContext(near: boolean, confidence: number): CostWeights {
	// Base weights (far)
	let wD = 0.4;
	let wConn = 0.4;
	const wQ = 0.1;
	const wB = 0.1;

	if (near) {
		// Strict distance when close to target
		wD = 0.7;
		wConn = 0.1;
	}

	// Confidence adjustment: low confidence → rely on connections, not distance
	const cAdj = (confidence - 0.5) * 0.2; // range [-0.1, 0.1]
	wD = Math.max(0.1, wD + cAdj);
	wConn = Math.max(0.05, wConn - cAdj);

	return { wD, wConn, wQ, wB };
}

function cost(
	normDist: number,
	connected: boolean,
	linkQ: number,
	backoff: number,
	w: CostWeights
): number {
	return (
		w.wD * normDist
		- w.wConn * (connected ? 1 : 0)
		- w.wQ * linkQ
		+ w.wB * backoff
	);
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Select the best next hop from candidates.
 *
 * Backwards compatible: when called without options (or with just
 * connectedToleranceBytes), falls back to the original leading-byte heuristic.
 */
export function chooseNextHop(
	store: DigitreeStore,
	targetCoord: Uint8Array,
	candidates: string[],
	isConnected: IsConnected,
	linkQ: LinkQuality,
	optionsOrTolerance?: NextHopOptions | number
): string | undefined {
	const opts: NextHopOptions = typeof optionsOrTolerance === 'number'
		? { connectedToleranceBytes: optionsOrTolerance }
		: optionsOrTolerance ?? {};

	// If nearRadius is provided, use cost-function path
	if (opts.nearRadius) {
		return chooseNextHopCost(store, targetCoord, candidates, isConnected, linkQ, opts);
	}

	// Legacy connected-first heuristic (tolerance-bytes based)
	return chooseNextHopLegacy(
		store, targetCoord, candidates, isConnected, linkQ,
		opts.connectedToleranceBytes ?? 1
	);
}

function chooseNextHopCost(
	store: DigitreeStore,
	targetCoord: Uint8Array,
	candidates: string[],
	isConnected: IsConnected,
	linkQ: LinkQuality,
	opts: NextHopOptions
): string | undefined {
	const confidence = opts.confidence ?? 0.5;
	const backoff = opts.backoffPenalty ?? (() => 0);
	const nearRadius = opts.nearRadius!;

	// Depends only on (near, confidence), so there are two possible results for the whole
	// call; computing it per candidate re-derived the same two values N times. In near mode
	// the resulting cost is only ever a tertiary tie-break, so most of that work was discarded.
	const nearW = weightsForContext(true, confidence);
	const farW = weightsForContext(false, confidence);

	// Our own distance to the target, when the caller told us where it sits. Only a *near*
	// self constrains the choice; see the strict-improvement filter below.
	const selfDist = opts.selfCoord ? minDistance(opts.selfCoord, targetCoord) : undefined;
	const nearSelfDist = selfDist !== undefined && isNear(selfDist, nearRadius) ? selfDist : undefined;

	type Scored = { id: string; dist: Uint8Array; near: boolean; connected: boolean; costVal: number };
	const scored: Scored[] = [];

	for (const id of candidates) {
		const entry = store.getById(id);
		if (!entry) continue;
		const dist = minDistance(entry.coord, targetCoord);
		const near = isNear(dist, nearRadius);
		const connected = isConnected(id);
		const w = near ? nearW : farW;
		const costVal = cost(normalizedLogMagnitude(dist), connected, linkQ(id), backoff(id), w);
		scored.push({ id, dist, near, connected, costVal });
	}

	if (scored.length === 0) return undefined;

	// Partition: near-mode candidates use strict distance ordering;
	// far-mode candidates use cost function.
	let nearCandidates = scored.filter(s => s.near);
	const farCandidates = scored.filter(s => !s.near);

	if (nearSelfDist !== undefined) {
		// Strict improvement against *our own* distance: a candidate no closer than we already
		// are moves the message backwards, which ordering candidates among themselves cannot see.
		nearCandidates = nearCandidates.filter(s => lexLess(s.dist, nearSelfDist));
		// Deliberately no fall-through to far mode: every far candidate sits beyond
		// nearRadius ≥ nearSelfDist, so it is guaranteed worse than staying put. Both callers
		// handle `undefined` — it becomes a NearAnchor reply or an `exhausted` lookup.
		if (nearCandidates.length === 0) return undefined;
	}

	// Near mode: strict distance improvement (ε ≈ 0); connection only breaks ties
	if (nearCandidates.length > 0) {
		nearCandidates.sort((a, b) => {
			if (betterByDist(a.id, a.dist, b.id, b.dist)) return -1;
			if (betterByDist(b.id, b.dist, a.id, a.dist)) return 1;
			// Equal distance: prefer connected, then lower cost
			if (a.connected !== b.connected) return a.connected ? -1 : 1;
			return a.costVal - b.costVal;
		});
		return nearCandidates[0]!.id;
	}

	// Far mode: use cost function
	farCandidates.sort((a, b) => {
		if (a.costVal !== b.costVal) return a.costVal - b.costVal;
		return betterByDist(a.id, a.dist, b.id, b.dist) ? -1 : 1;
	});
	return farCandidates[0]!.id;
}

function chooseNextHopLegacy(
	store: DigitreeStore,
	targetCoord: Uint8Array,
	candidates: string[],
	isConnected: IsConnected,
	linkQ: LinkQuality,
	connectedToleranceBytes: number
): string | undefined {
	let bestByDist: { id: string; dist: Uint8Array } | undefined;
	const scored: Array<{ id: string; dist: Uint8Array; connected: boolean; score: number }> = [];

	for (const id of candidates) {
		const entry = store.getById(id);
		if (!entry) continue;
		const dist = minDistance(entry.coord, targetCoord);
		const connected = isConnected(id);
		const score = (connected ? 1 : 0) + 0.25 * linkQ(id);
		scored.push({ id, dist, connected, score });
		if (!bestByDist || betterByDist(id, dist, bestByDist.id, bestByDist.dist)) bestByDist = { id, dist };
	}
	if (!bestByDist) return undefined;

	const bestLead = leadingByteIndex(bestByDist.dist);
	let bestConnected: { id: string; dist: Uint8Array; score: number } | undefined;
	for (const s of scored) {
		if (!s.connected) continue;
		const lead = leadingByteIndex(s.dist);
		if (lead <= bestLead + connectedToleranceBytes) {
			if (!bestConnected) {
				bestConnected = { id: s.id, dist: s.dist, score: s.score };
				continue;
			}
			if (betterByDist(s.id, s.dist, bestConnected.id, bestConnected.dist)) {
				bestConnected = { id: s.id, dist: s.dist, score: s.score };
			} else if (equalBytes(s.dist, bestConnected.dist)) {
				if (s.score > bestConnected.score || (s.score === bestConnected.score && s.id < bestConnected.id)) {
					bestConnected = { id: s.id, dist: s.dist, score: s.score };
				}
			}
		}
	}

	return bestConnected?.id ?? bestByDist.id;
}
