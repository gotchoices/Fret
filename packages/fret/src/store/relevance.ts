import type { PeerEntry } from './digitree-store.js';
import { minDistance, normalizedLogMagnitude } from '../ring/distance.js';

export interface SparsityModel {
	centers: number[];
	occupancy: Float64Array;
	alpha: number;
	sigma: number;
	beta: number;
	sMin: number;
	sMax: number;
	eps: number;
}

export function createSparsityModel(
	m = 12,
	sigma = 0.08,
	alpha = 0.03,
	beta = 0.6,
	sMin = 0.7,
	sMax = 1.8,
	eps = 1e-6
): SparsityModel {
	const centers: number[] = [];
	for (let i = 0; i < m; i++) centers.push((i + 0.5) / m);
	return { centers, occupancy: new Float64Array(m), alpha, sigma, beta, sMin, sMax, eps };
}

/**
 * The KDE's x axis: normalized log ring distance ∈ [0,1] — 0 = coincident,
 * larger = farther.  Measured with `minDistance`, the same metric routing uses,
 * so a peer that routing calls near is near here too.
 */
export function normalizedLogDistance(selfCoord: Uint8Array, otherCoord: Uint8Array): number {
	return normalizedLogMagnitude(minDistance(selfCoord, otherCoord));
}

function gaussianKernel(dx: number, sigma: number): number {
	const z = dx / Math.max(1e-9, sigma);
	return Math.exp(-0.5 * z * z);
}

export function observeDistance(model: SparsityModel, x: number): void {
	for (let i = 0; i < model.centers.length; i++) {
		const k = gaussianKernel(Math.abs(x - model.centers[i]!), model.sigma);
		model.occupancy[i] = (1 - model.alpha) * model.occupancy[i]! + model.alpha * k;
	}
}

export function sparsityBonus(model: SparsityModel, x: number): number {
	let dens = 0;
	let ideal = 0;
	for (let i = 0; i < model.centers.length; i++) {
		const k = gaussianKernel(Math.abs(x - model.centers[i]!), model.sigma);
		dens += model.occupancy[i]! * k;
		ideal += 1 * k; // uniform target
	}
	const ratio = (ideal + model.eps) / (dens + model.eps);
	const s = Math.pow(ratio, model.beta);
	return Math.max(model.sMin, Math.min(model.sMax, s));
}

function recencyScore(entry: PeerEntry, now: number): number {
	const dt = Math.max(0, now - entry.lastAccess);
	const halfLifeMs = 60_000; // 1 minute half-life
	const lambda = Math.log(2) / halfLifeMs;
	return Math.exp(-lambda * dt);
}

// NOTE: log1p slows but does not cap — frequency is unbounded in principle. At accessCount 1e6
// the weighted term contributes 0.55 against recency/health ceilings of 0.4 each, so a
// high-traffic peer can outweigh both. Accrual is now bounded by proven contact — only `touch`
// and `recordSuccess` increment it, and the service calls neither for an id it was merely told
// about (see `FretService.noteDiscovered`) — so reaching 1e6 takes 1e6 real round trips. Not a
// defect today; if it ever shows up as a problem, cap or re-scale the term.
function frequencyScore(entry: PeerEntry): number {
	return Math.log1p(entry.accessCount) / 5; // saturates slowly
}

/**
 * Health ∈ [0,1] from the success/failure ratio and measured latency.
 *
 * An *unmeasured* peer (`avgLatencyMs === null`) takes the neutral 0.5 penalty, so it scores
 * strictly between a peer measured at 0 ms and one measured at 1000 ms. The test is on `null`
 * and not on `> 0`: a genuine 0 ms measurement is the best possible link and must score as
 * such, not be mistaken for the absence of a measurement.
 *
 * NOTE: accepted tradeoff — health is deliberately a pure rate (saturates after the first
 * success) rather than a term that also grows with volume; volume lives in `frequencyScore`
 * instead. Putting volume in both would double-count it and force every weight to be re-tuned.
 * Revisit if the frequency term is ever removed or re-weighted to near zero.
 *
 * NOTE: accepted tradeoff — latency enters relevance *only* as this bounded penalty, and a
 * further "nearness bonus" ranking peers against the population's RTT distribution (a z-score or
 * percentile over an EMA mean and variance) was proposed and declined. It would pull the routing
 * table toward topologically near peers, working directly against the sparsity model whose whole
 * purpose is a distance-balanced spine — the two terms would fight, and the sparsity model is the
 * one the routing design depends on. Revisit only if hop counts are measured to suffer from
 * latency-blind next-hop choice, which the routing guard spec does not currently show.
 */
export function healthScore(entry: PeerEntry): number {
	const total = entry.successCount + entry.failureCount;
	const successRate = total > 0 ? entry.successCount / total : 0.5;
	const latencyPenalty = entry.avgLatencyMs === null ? 0.5 : Math.min(1, entry.avgLatencyMs / 1000);
	const health = 0.5 * successRate + 0.5 * (1 - latencyPenalty);
	return Math.max(0, health);
}

function baseRelevance(entry: PeerEntry, now: number): number {
	const wRecency = 0.4;
	const wFreq = 0.2;
	const wHealth = 0.4;
	return (
		wRecency * recencyScore(entry, now) +
		wFreq * frequencyScore(entry) +
		wHealth * healthScore(entry)
	);
}

export function touch(entry: PeerEntry, x: number, model: SparsityModel, now = Date.now()): PeerEntry {
	observeDistance(model, x);
	const base = baseRelevance({ ...entry, accessCount: entry.accessCount + 1 }, now);
	const bonus = sparsityBonus(model, x);
	const relevance = base * bonus;
	return {
		...entry,
		lastAccess: now,
		relevance,
		accessCount: entry.accessCount + 1
	};
}

/**
 * Score a brand-new entry once, from its own empty counters.
 * No counter is incremented and the KDE is NOT observed: a name we were handed is not
 * a distance we accessed.
 */
export function initialRelevance(entry: PeerEntry, x: number, model: SparsityModel, now = Date.now()): number {
	const base = baseRelevance(entry, now);
	const bonus = sparsityBonus(model, x);
	return base * bonus;
}

/**
 * Blend a new latency sample into a peer's running average.
 *
 * `null` means never measured, so the first sample seeds the average outright instead of being
 * dragged toward a value that was never observed. A real 0 ms sample blends like any other.
 * `undefined` means the caller has no sample at all — the average is returned untouched rather
 * than fabricating one (see {@link recordSuccess}).
 */
function blendLatency(avg: number | null, sample: number | undefined): number | null {
	if (sample === undefined) return avg;
	if (avg === null) return sample;
	const alpha = 0.2; // EMA for latency
	return (1 - alpha) * avg + alpha * sample;
}

/**
 * Record a completed RPC against `entry`.
 *
 * `latencyMs` is **optional** because not every success carries a usable measurement — see
 * `blendLatency` above. Callers that supply no sample must likewise omit `avgLatencyMs` from
 * any patch they derive from the result.
 *
 * Frequency credit rule (settled): a completed RPC counts as an access, so `accessCount` is
 * incremented here exactly as `touch` increments it — repeated proven contact now raises
 * relevance instead of saturating after the first success. `recordFailure` does not accrue
 * frequency, and neither does being *named* by another peer: the gossip-ingestion paths score a
 * newly-created entry once with {@link initialRelevance} and leave an id they already hold
 * completely alone (`FretService.noteDiscovered`), so mention count is flat in relevance.
 */
export function recordSuccess(entry: PeerEntry, latencyMs: number | undefined, x: number, model: SparsityModel, now = Date.now()): PeerEntry {
	observeDistance(model, x);
	const avgLatencyMs = blendLatency(entry.avgLatencyMs, latencyMs);
	const base = baseRelevance({ ...entry, avgLatencyMs, successCount: entry.successCount + 1, accessCount: entry.accessCount + 1 }, now);
	const bonus = sparsityBonus(model, x);
	const relevance = base * bonus;
	return {
		...entry,
		lastAccess: now,
		relevance,
		successCount: entry.successCount + 1,
		accessCount: entry.accessCount + 1,
		avgLatencyMs
	};
}

export function recordFailure(entry: PeerEntry, x: number, model: SparsityModel, now = Date.now()): PeerEntry {
	observeDistance(model, x);
	// degrade relevance softly
	const base = baseRelevance({ ...entry, failureCount: entry.failureCount + 1 }, now) * 0.7;
	const bonus = sparsityBonus(model, x);
	const relevance = base * bonus;
	return {
		...entry,
		lastAccess: now,
		relevance,
		failureCount: entry.failureCount + 1
	};
}
