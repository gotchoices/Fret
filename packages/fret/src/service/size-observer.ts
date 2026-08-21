/**
 * Network-size observation blending, extracted from `FretService` so the maths can be unit-tested
 * without standing up a libp2p node. The class owns nothing but its own observation array and a
 * clock: it never reads the routing store, so the caller's *local* FRET estimate is passed **in**
 * (`LocalSizeEstimate`) rather than reached out for. See `docs/fret.md`, *Network size estimation*.
 */

/** One reported network-size observation, local or peer-supplied. */
export interface SizeObservation {
	estimate: number;
	confidence: number;
	timestamp: number;
	/** Provenance for diagnostics only; nothing branches on it. */
	source: string;
}

/** The blended answer. */
export interface BlendedSize {
	size_estimate: number;
	confidence: number;
	/** Observations contributing, not distinct observers. */
	sources: number;
}

/** The caller's own locally-derived estimate, supplied per call. */
export interface LocalSizeEstimate {
	n: number;
	confidence: number;
}

export interface SizeObserverOptions {
	/** Sliding window; observations older than this are dropped. Default 300_000. */
	windowMs?: number;
	/** Hard count bound; the newest are kept. Default 100. */
	maxObservations?: number;
	/** Clock seam. Default `Date.now`. Injectable so decay and blend are testable without sleeps. */
	now?: () => number;
}

const DEFAULT_WINDOW_MS = 300000; // 5 minutes
const DEFAULT_MAX_OBSERVATIONS = 100;

export class SizeObserver {
	private observationList: SizeObservation[] = [];
	private readonly windowMs: number;
	private readonly maxObservations: number;
	private readonly now: () => number;

	constructor(opts?: SizeObserverOptions) {
		this.windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
		this.maxObservations = opts?.maxObservations ?? DEFAULT_MAX_OBSERVATIONS;
		this.now = opts?.now ?? Date.now;
	}

	/**
	 * Record an external observation, then trim by age and by count.
	 *
	 * Non-finite input is refused outright rather than stored: this class is the boundary now
	 * (`FretService.reportNetworkSize` is public, and `calibrateSizeFromSnapshot` feeds it
	 * wire-derived numbers), and a single `NaN` in the array poisons every subsequent blend —
	 * `weightedSum`/`totalWeight` are both `NaN` from then on, so `totalWeight === 0` never fires
	 * and the degenerate guard cannot catch it. Negative values are *not* refused: the caller
	 * gates on `> 0` and that behavior is carried across unchanged.
	 */
	report(estimate: number, confidence: number, source: string = 'external'): void {
		if (!Number.isFinite(estimate) || !Number.isFinite(confidence)) return;
		const now = this.now();
		this.observationList.push({ estimate, confidence, timestamp: now, source });

		// Trim old observations
		const cutoff = now - this.windowMs;
		this.observationList = this.observationList.filter(o => o.timestamp > cutoff);

		// Keep only most recent observations
		if (this.observationList.length > this.maxObservations) {
			this.observationList = this.observationList.slice(-this.maxObservations);
		}
	}

	/**
	 * Blend `local` with the recorded observations. `local` is always the first observation, so
	 * the population is never empty.
	 */
	blend(local: LocalSizeEstimate): BlendedSize {
		const now = this.now();
		const allObservations: SizeObservation[] = [
			{ estimate: local.n, confidence: local.confidence, timestamp: now, source: 'fret' },
			...this.observationList
		];

		// Weight recent observations more heavily with exponential decay. Two different
		// denominators are in play and mixing them up is what made the reported confidence
		// collapse: `size_estimate` is weighted by recency × confidence (a confident, recent
		// observation should dominate the size), while the average confidence is weighted by
		// recency *only* — dividing a recency-weighted numerator by an unweighted count drags
		// the result toward zero as observations age even when every one of them agrees.
		let totalWeight = 0;
		let weightedSum = 0;
		let confidenceSum = 0;
		let recencySum = 0;

		for (const obs of allObservations) {
			const age = now - obs.timestamp;
			const recencyWeight = Math.exp(-age / (this.windowMs / 3));
			const weight = recencyWeight * obs.confidence;

			weightedSum += obs.estimate * weight;
			confidenceSum += obs.confidence * recencyWeight;
			recencySum += recencyWeight;
			totalWeight += weight;
		}

		// Reachable when every observation carries confidence 0 (the local estimate is always
		// present, so an *empty* observation set is not).
		if (totalWeight === 0 || recencySum === 0) {
			return { size_estimate: 0, confidence: 0, sources: 0 };
		}

		const estimate = Math.round(weightedSum / totalWeight);
		const avgConfidence = confidenceSum / recencySum;

		return {
			size_estimate: estimate,
			confidence: Math.min(1, avgConfidence),
			// Observations contributing, not distinct observers: repeated snapshots from one
			// peer each add an entry. Diagnostic only — nothing branches on it.
			sources: allObservations.length
		};
	}

	/** Rate of change per minute across the window's recent vs older half. 0 when undecidable. */
	churnPerMinute(): number {
		if (this.observationList.length < 2) {
			return 0;
		}

		const now = this.now();
		const halfWindow = this.windowMs / 2;
		const cutoff = now - halfWindow;

		const recentObs = this.observationList.filter(o => o.timestamp > cutoff);
		const olderObs = this.observationList.filter(o => o.timestamp <= cutoff);

		if (recentObs.length === 0 || olderObs.length === 0) {
			return 0;
		}

		const recentAvg = recentObs.reduce((sum, o) => sum + o.estimate, 0) / recentObs.length;
		const olderAvg = olderObs.reduce((sum, o) => sum + o.estimate, 0) / olderObs.length;

		// Return change per minute
		const changePerMs = (recentAvg - olderAvg) / halfWindow;
		return changePerMs * 60000;
	}

	/**
	 * Sudden-drop / high-churn heuristic. Needs `local` because it consults the blended size.
	 */
	detectPartition(local: LocalSizeEstimate): boolean {
		if (this.observationList.length < 10) {
			return false; // Not enough data
		}

		const current = this.blend(local);
		if (current.confidence < 0.3) {
			return false; // Not confident enough
		}

		// Get estimate from 30 seconds ago
		const thirtySecondsAgo = this.now() - 30000;
		const oldObs = this.observationList.filter(o => o.timestamp < thirtySecondsAgo);

		if (oldObs.length < 3) {
			return false;
		}

		// Carried across verbatim from `FretService.detectPartition`. The divisor is written as
		// `Math.min(5, oldObs.length)` rather than as the slice's own length, but the two are
		// equal for every input (`slice(-5).length === Math.min(5, length)`), so this is a plain
		// mean of the newest at most 5 observations older than 30 s — not a truncated-numerator bug.
		const oldAvg = oldObs.slice(-5).reduce((sum, o) => sum + o.estimate, 0) / Math.min(5, oldObs.length);

		// Detect sudden drop of more than 50%
		const dropRatio = current.size_estimate / oldAvg;
		if (dropRatio < 0.5) {
			return true;
		}

		// Also check churn rate
		const churn = Math.abs(this.churnPerMinute());
		const churnThreshold = current.size_estimate * 0.1; // 10% per minute is suspicious

		return churn > churnThreshold;
	}

	/** Defensive copy, for diagnostics and tests. */
	observations(): SizeObservation[] {
		return this.observationList.map(o => ({ ...o }));
	}

	/** Drop every observation — a start → stop → start cycle is a fresh run. */
	clear(): void {
		this.observationList = [];
	}
}
