import type { DigitreeStore } from '../store/digitree-store.js'
import { minDistance, lexLess, normalizedLogMagnitude } from '../ring/distance.js'

export type LinkQuality = (id: string) => number; // [0..1]
export type IsConnected = (id: string) => boolean;
export type BackoffPenalty = (id: string) => number; // [0..1]

export interface NextHopOptions {
	/** Near-radius threshold; distances ≤ this trigger strict mode. */
	nearRadius?: Uint8Array;
	/**
	 * The caller's own ring coordinate. Supplied, the selector measures strict improvement
	 * against *our* distance to the target rather than only ordering candidates among
	 * themselves, so the chosen hop can never be farther from the key than we already are.
	 * This is one rule applied in **both** near and far mode, not a near-mode special case:
	 * ordering candidates against each other cannot see a pool that is entirely behind us.
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

/**
 * Minimum under a strict "a beats b" predicate. Only the winner is ever read, so a scan does
 * the work a full sort did. It is also the safer shape: `beats` is false in *both* directions
 * for two entries carrying the same id (a remote-supplied anchor list may repeat one), which
 * is an inconsistent `sort` comparator but a well-defined scan.
 */
function best<T>(items: T[], beats: (a: T, b: T) => boolean): T {
	let winner = items[0]!;
	for (let i = 1; i < items.length; i++) if (beats(items[i]!, winner)) winner = items[i]!;
	return winner;
}

// ── Cost function (fret.md §A5) ──────────────────────────────────────
//
// cost(peer) = w_d·adjNormDist + w_b·backoff
//
// where adjNormDist is the peer's normalized log distance to the key *discounted by an
// allowance stated in binary orders of ring distance* — see `connectedSlackOrders` and
// `QUALITY_SLACK_ORDERS`.
//
// The connection and link-quality preferences used to be flat cost units subtracted
// beside the distance term (`− w_conn·connected − w_q·linkQ`), and those units were not
// commensurable with it. `normalizedLogMagnitude` is a log-scale *position*: its whole
// dynamic range of 1.0 is spread over 256 binary orders, so one order of ring distance is
// worth only w_d/256 ≈ 0.0016 of cost. A flat w_conn of 0.4 therefore outranked 256 orders
// — the entire ring — and a connected candidate beat a disconnected one at any separation a
// real candidate pool can express. Expressing the same preferences as a bounded number of
// orders keeps the bias and states its price.
//
// The cost function is **far mode's** ordering only. Near candidates are ordered by strict
// distance with the ring's lexicographic peer-id tie-break, which is already a total order,
// so cost never arbitrates there and is not computed for them.
//
// Confidence still shifts the balance:
//   low confidence  → widen the connected allowance, lower w_d
//   high confidence → narrow the allowance, raise w_d

interface CostWeights { wD: number; wB: number }

function farWeights(confidence: number): CostWeights {
	// NOTE: backoff is deliberately left able to dominate distance. At these weights
	// (w_d ≈ 0.4, w_b = 0.1) a fully backed-off peer concedes 0.1 / (w_d / 256) ≈ 64 binary
	// orders of ring distance, far more than the connected allowance below. That is the
	// intended reading rather than an accident of scale: a peer in backoff failed us
	// recently and may be gone, so a hop through it likely spends a full timeout and buys no
	// progress at all — worse than a working hop that is merely farther. Revisit if backoff
	// peers are ever measured to recover fast enough that skipping them costs more hops than
	// it saves.
	const wB = 0.1;

	// Confidence adjustment: a confident size estimate makes the distance term more
	// trustworthy. The *connected* half of this adjustment now lives in `connectedSlackOrders`.
	const wD = Math.max(0.1, 0.4 + (confidence - 0.5) * 0.2); // cAdj range [-0.1, 0.1]

	return { wD, wB };
}

/**
 * Connected-first bias, as the number of binary orders of ring distance a connected peer
 * may give up against a disconnected one. 8 orders is one byte, matching the legacy path's
 * `connectedToleranceBytes` default of 1, so both selector paths agree on what "slightly
 * farther" means.
 *
 * NOTE: 8 ± 4 is reasoned from that legacy correspondence, not measured — nothing under
 * `test/simulation/` drives the shipped selector today, so there is no routing-success or
 * hop-count number to tune against. Retune once such a harness exists.
 */
const CONNECTED_SLACK_ORDERS = 8;
const CONNECTED_SLACK_CONFIDENCE_SWING = 4;

/** Low confidence widens the allowance (trust the link we have); high confidence narrows it. */
function connectedSlackOrders(confidence: number): number {
	return CONNECTED_SLACK_ORDERS + (0.5 - confidence) * 2 * CONNECTED_SLACK_CONFIDENCE_SWING;
}

/**
 * Link-quality allowance: a perfect-quality peer may sit this many binary orders farther
 * than a zero-quality one. Deliberately smaller than the connection allowance — quality is
 * the softer signal, and at the old flat w_q of 0.1 it was worth 64 orders, a quarter of
 * the ring.
 */
const QUALITY_SLACK_ORDERS = 4;

function cost(
	normDist: number,
	slackOrders: number,
	totalOrders: number,
	backoff: number,
	w: CostWeights
): number {
	// The allowance discounts *distance* rather than sitting beside it, which is what makes
	// it commensurable: it moves the candidate a stated number of binary orders closer.
	const adjNormDist = normDist - slackOrders / totalOrders;
	return w.wD * adjNormDist + w.wB * backoff;
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

	// Our own distance to the target, when the caller told us where it sits. Constrains the
	// choice in every mode; see the strict-improvement filter below.
	const selfDist = opts.selfCoord ? minDistance(opts.selfCoord, targetCoord) : undefined;

	type Scored = { id: string; dist: Uint8Array; near: boolean };
	const scored: Scored[] = [];

	for (const id of candidates) {
		const entry = store.getById(id);
		if (!entry) continue;
		const dist = minDistance(entry.coord, targetCoord);
		scored.push({ id, dist, near: isNear(dist, nearRadius) });
	}

	if (scored.length === 0) return undefined;

	// Strict improvement against *our own* distance, in **every** mode. A candidate no closer
	// than we already are moves the message backwards, which ordering candidates among
	// themselves cannot see. Applied before the near/far partition, so it is one rule rather
	// than a near-mode special case — and it subsumes the near-only filter it replaced:
	//
	//  • self near, some near candidate closer → that candidate is closer than self and so is
	//    itself near; it survives and near mode picks it. Unchanged.
	//  • self near, no near candidate closer → every far candidate has dist > nearRadius ≥
	//    selfDist, so the filter removes those too and the answer is `undefined`. That is the
	//    deliberate "no fall-through to far mode", now falling out of the general rule.
	//  • self far, a near candidate exists → dist ≤ nearRadius < selfDist, so it survives.
	//    Unchanged.
	//  • self far, all candidates far → a candidate behind us is now ineligible. The fix.
	//
	// The floor is strict (`dist < selfDist`), not slack past self: the subsumption above
	// depends on it, and slack belongs among candidates, never against our own position.
	// Both callers handle `undefined` — it becomes a NearAnchor reply or an `exhausted`
	// lookup. A forwarding node sits at index ≥ 2 of the key's cohort, so a strictly-improving
	// hop normally exists; no hop means the closer peers were all excluded as breadcrumbs or
	// as undialable, i.e. a genuinely exhausted local view.
	const eligible = selfDist !== undefined ? scored.filter(s => lexLess(s.dist, selfDist)) : scored;
	if (eligible.length === 0) return undefined;

	// Partition: near-mode candidates use strict distance ordering;
	// far-mode candidates use cost function.
	const nearCandidates = eligible.filter(s => s.near);
	const farCandidates = eligible.filter(s => !s.near);

	// Near mode: strict distance improvement (ε ≈ 0), with the ring's lexicographic peer-id
	// tie-break for equal distances (docs/fret.md, "Identifier space and hashing"). That
	// tie-break makes `betterByDist` a total order over distinct ids, so connectedness and
	// cost never arbitrate here — the allowance applies to far mode alone.
	//
	// NOTE: backoff is inert here too, so near mode will pick the nearest peer over a live one
	// a step behind it even when the nearest just failed us. That is the long-standing near-mode
	// rule (distance alone) rather than something this partition introduced, and inside r_near
	// the alternative hop is barely farther, so the timeout buys little. Revisit if near-mode
	// hops are ever measured to stall on backed-off peers.
	if (nearCandidates.length > 0) {
		return best(nearCandidates, (a, b) => betterByDist(a.id, a.dist, b.id, b.dist)).id;
	}

	// Far mode: use the cost function, evaluated once per surviving far candidate.
	const w = farWeights(confidence);
	const connectedSlack = connectedSlackOrders(confidence);
	const farScored = farCandidates.map(s => {
		const slack = (isConnected(s.id) ? connectedSlack : 0) + linkQ(s.id) * QUALITY_SLACK_ORDERS;
		const costVal = cost(normalizedLogMagnitude(s.dist), slack, s.dist.length * 8, backoff(s.id), w);
		return { ...s, costVal };
	});
	return best(farScored, (a, b) => (
		a.costVal !== b.costVal ? a.costVal < b.costVal : betterByDist(a.id, a.dist, b.id, b.dist)
	)).id;
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
