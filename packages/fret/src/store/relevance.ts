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
	const lambda = Math.log(2) / Math.max(1, halfLifeMs);
	return Math.exp(-lambda * dt);
}

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

function withCounters(entry: PeerEntry, patch: Partial<PeerEntry>): PeerEntry {
	return { ...entry, ...patch };
}

export function touch(entry: PeerEntry, x: number, model: SparsityModel, now = Date.now()): PeerEntry {
	observeDistance(model, x);
	const base = baseRelevance(entry, now);
	const bonus = sparsityBonus(model, x);
	const relevance = base * bonus;
	return withCounters(entry, {
		lastAccess: now,
		relevance,
		accessCount: entry.accessCount + 1
	});
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
 * `latencyMs` is **optional** because not every success carries a usable measurement. Timing a
 * forwarded route, for instance, measures the whole downstream subtree rather than the link to
 * the next hop, so recording it would penalize a healthy adjacent peer for a long path behind
 * it. Such callers omit the argument and the peer's `avgLatencyMs` is left exactly as it was —
 * still `null` if it has never been pinged. Callers must likewise omit `avgLatencyMs` from any
 * patch they derive from the result when they supplied no sample.
 *
 * NOTE: a *repeated* success does not raise relevance, and successful contact earns no frequency
 * credit at all. `successCount` feeds only the success/failure ratio in {@link healthScore},
 * which saturates the moment the first success lands — measured at a fixed clock, ten successive
 * calls score an identical 1.2600, and an entry with 500 recorded successes scores exactly what
 * one with a single success does. Meanwhile `accessCount`, the only input to the frequency term,
 * is incremented by {@link touch} alone, and `touch` is what an *inbound* snapshot naming a peer
 * runs — so a peer we merely heard about 500 times scores 1.5275, above a peer we successfully
 * called 500 times. Those two figures hold the sparsity bonus fixed at `sMax` (a fresh model per
 * call); on one shared model, whose occupancy every call moves, the same pair measures 1.0449 vs
 * 0.8619 — lower, same ordering, since the taper applies to both alike.
 * Whether that ranking is intended is an open question owned by
 * `tickets/backlog/bug-frequency-credit-only-from-gossip`; `test/relevance.properties.spec.ts`
 * therefore asserts only that a success outranks a failure, and pins no direction on either
 * behavior described here.
 */
export function recordSuccess(entry: PeerEntry, latencyMs: number | undefined, x: number, model: SparsityModel, now = Date.now()): PeerEntry {
	observeDistance(model, x);
	const avgLatencyMs = blendLatency(entry.avgLatencyMs, latencyMs);
	const base = baseRelevance({ ...entry, avgLatencyMs, successCount: entry.successCount + 1 }, now);
	const bonus = sparsityBonus(model, x);
	const relevance = base * bonus;
	return withCounters(entry, {
		lastAccess: now,
		relevance,
		successCount: entry.successCount + 1,
		avgLatencyMs
	});
}

export function recordFailure(entry: PeerEntry, x: number, model: SparsityModel, now = Date.now()): PeerEntry {
	observeDistance(model, x);
	// degrade relevance softly
	const base = baseRelevance({ ...entry, failureCount: entry.failureCount + 1 }, now) * 0.7;
	const bonus = sparsityBonus(model, x);
	const relevance = base * bonus;
	return withCounters(entry, {
		lastAccess: now,
		relevance,
		failureCount: entry.failureCount + 1
	});
}
