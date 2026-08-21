import type { DigitreeStore, PeerEntry } from '../store/digitree-store.js'
import { ringNeighborsBothSides } from '../ring/ring-walk.js'

export type SizeEstimate = { n: number; confidence: number };

export interface SizeEstimateOptions {
	/** Restrict the estimate to a subset of the store (e.g. same-network members only). */
	filter?: (e: PeerEntry) => boolean;
	/**
	 * Ring position *and* id of the local node. When supplied, gaps are drawn from the
	 * successor/predecessor window around it — the intended arc-length method. Omitting it
	 * selects the degraded whole-store fallback (see {@link estimateSizeAndConfidence}).
	 *
	 * The two travel as one field because the window walk drops the anchor entry by *id* (self
	 * contributes offset 0 explicitly) — a coordinate without its id silently costs the window
	 * one gap per side, so the half-specified anchor is made unrepresentable rather than
	 * defaulted away.
	 */
	self?: { coord: Uint8Array; id: string };
}

const RING_SIZE = 1n << 256n;
const HALF_RING = 1n << 255n;

function bytesToBigInt(u8: Uint8Array): bigint {
	let v = 0n;
	for (let i = 0; i < u8.length; i++) v = (v << 8n) | BigInt(u8[i]!);
	return v;
}

function ascending(a: bigint, b: bigint): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function medianBigInt(values: bigint[]): bigint {
	if (values.length === 0) return 0n;
	const arr = [...values].sort(ascending);
	const mid = Math.floor(arr.length / 2);
	return arr.length % 2 === 0 ? (arr[mid - 1]! + arr[mid]!) / 2n : arr[mid]!;
}

function meanBigInt(values: bigint[]): bigint {
	if (values.length === 0) return 0n;
	let sum = 0n;
	for (const v of values) sum += v;
	return sum / BigInt(values.length);
}

/**
 * Differences between adjacent entries of an ascending list.
 *
 * The wrap-around gap (last back round to first) is deliberately **not** included. A node's
 * knowledge of the ring is never complete, so that gap spans the arc it has not sampled — it is
 * the single largest outlier in the population and says nothing about inter-peer spacing.
 */
function consecutiveGaps(ascendingValues: bigint[]): bigint[] {
	const gaps: bigint[] = [];
	for (let i = 1; i < ascendingValues.length; i++) gaps.push(ascendingValues[i]! - ascendingValues[i - 1]!);
	return gaps;
}

/**
 * Gaps between adjacent members of the successor/predecessor window around `selfCoord`.
 *
 * Coordinates are re-centred on self as *signed* offsets in (−2^255, 2^255] rather than compared
 * raw, so a window straddling coordinate 0 stays one contiguous run. Sorting raw coordinates
 * would split such a window in two and manufacture an interior gap the size of the rest of the
 * ring — precisely the outlier this method exists to avoid.
 *
 * The walk is {@link ringNeighborsBothSides}, whose `count` already means *peers besides self* —
 * it over-fetches and drops the anchor entry itself, which is exactly the compensation this
 * function used to hand-roll as a local `m + 1`. Self is seeded here as offset 0 instead, and
 * offsets are collected in a `Set` so a coordinate coincident with self contributes once. The
 * window is therefore self + m successors + m predecessors, i.e. G = 2m gaps at the default m.
 */
function windowGaps(
	store: DigitreeStore,
	m: number,
	selfCoord: Uint8Array,
	selfId: string,
	filter?: (e: PeerEntry) => boolean
): bigint[] {
	const selfBig = bytesToBigInt(selfCoord);
	const offsets = new Set<bigint>([0n]);
	const addById = (id: string): void => {
		const entry = store.getById(id);
		if (!entry) return;
		let d = (bytesToBigInt(entry.coord) - selfBig) % RING_SIZE;
		if (d < 0n) d += RING_SIZE;
		offsets.add(d > HALF_RING ? d - RING_SIZE : d);
	};
	for (const id of ringNeighborsBothSides(store, selfCoord, m, selfId, { filter })) addById(id);
	return consecutiveGaps([...offsets].sort(ascending));
}

/**
 * Relative standard error of the mean gap, as a [0,1] sample-quality factor.
 *
 * Gaps on a uniform-random ring are exponentially distributed, so a coefficient of variation
 * near 1 is the *healthy* value rather than a defect. Flooring cv at 1 encodes that prior: a
 * synthetically perfect (evenly spaced) sample cannot claim zero sampling error from a handful
 * of gaps. The factor is then monotone in window size, capping confidence at 0.5 + 0.5·(1 −
 * 1/√G) — 0.875 at G = 16 (a full S/P window at the default m = 8), ~0.65 at G = 2.
 *
 * NOTE: this measures *local* spacing regularity only. A node whose neighbors are all packed
 * into a tiny, evenly-spaced arc — an eclipse, or a very young ring — scores high here while
 * `n` is wildly wrong, because no statistic over the sampled arc can see the arc that was never
 * sampled. The defense is corroboration from peer-reported estimates (`reportNetworkSize` /
 * `calibrateSizeFromSnapshot`), not a better local formula.
 */
function dispersionFactor(gaps: bigint[]): number {
	const count = gaps.length;
	if (count === 0) return 0;
	const values = gaps.map(Number);
	let sum = 0;
	for (const v of values) sum += v;
	const mean = sum / count;
	// Degenerate: every sampled peer sits at one coordinate, so there is no spacing to judge.
	if (mean <= 0) return 0;
	let squared = 0;
	for (const v of values) squared += (v - mean) ** 2;
	const cv = Math.sqrt(squared / count) / mean;
	const rse = Math.max(cv, 1) / Math.sqrt(count);
	return Math.max(0, Math.min(1, 1 - rse));
}

/**
 * The gap population the estimate rests on, plus the representative gap derived from it.
 *
 * With `self` this is the successor/predecessor window and its arithmetic **mean** — the
 * arc-length method from docs/fret.md. Without it, the degraded fallback: every known
 * coordinate, and the **median** to blunt the outliers a whole-store population carries.
 *
 * The fallback is degraded because a node's knowledge is deliberately non-uniform — it knows
 * every peer near itself but only a sparsity-weighted scattering of far ones — so whole-store
 * gaps mix ~2m near-true spacings with a long tail of huge far-peer gaps. Once far peers
 * outnumber near ones (the normal steady state) even the median lands in that tail and `n`
 * collapses by an order of magnitude.
 */
function collectGaps(
	store: DigitreeStore,
	m: number,
	peers: PeerEntry[],
	filter?: (e: PeerEntry) => boolean,
	self?: { coord: Uint8Array; id: string }
): { gaps: bigint[]; representativeGap: bigint } {
	if (self) {
		const gaps = windowGaps(store, m, self.coord, self.id, filter);
		if (gaps.length > 0) return { gaps, representativeGap: meanBigInt(gaps) };
	}
	const gaps = consecutiveGaps(peers.map((p) => bytesToBigInt(p.coord)).sort(ascending));
	return { gaps, representativeGap: medianBigInt(gaps) };
}

/**
 * Online network-size estimate from inter-peer ring gaps: `n = 2^256 / gap`.
 *
 * `options.self` selects the successor/predecessor window as the gap population and is the
 * intended path; omitting it falls back to whole-store gaps (see {@link collectGaps}).
 * `options.filter` scopes the estimate to a subset of the store (e.g. same-network members only)
 * so foreign peers from a co-resident network can't inflate `n` and the derived cluster span /
 * near-radius. It defaults to counting every entry, leaving the standalone/simulator path
 * unchanged.
 *
 * Confidence blends sample count against 2m with the dispersion factor above.
 */
export function estimateSizeAndConfidence(store: DigitreeStore, m: number, options?: SizeEstimateOptions): SizeEstimate {
	// NOTE: `list()` walks and materializes every entry, but on the `self` path only its
	// length is used (for `sizeFactor`) — the gap population comes from the S/P window instead.
	// That is an O(store) allocation per call, and the estimator is called once per inbound
	// maybeAct. Fine at today's capacity (2048) and message rates; if either grows, give the
	// store a `countWhere(filter)` and build the list only for the whole-store fallback.
	const peers = options?.filter ? store.list().filter(options.filter) : store.list();
	const count = peers.length;
	if (count === 0) return { n: 0, confidence: 0 };
	if (count === 1) return { n: 1, confidence: 0.2 };

	const { gaps, representativeGap } = collectGaps(store, m, peers, options?.filter, options?.self);
	const safeGap = representativeGap > 0n ? representativeGap : RING_SIZE / BigInt(count);
	const nEst = Math.max(1, Math.min(Number(RING_SIZE / safeGap), 1_000_000_000));

	const sizeFactor = Math.min(1, count / Math.max(1, m * 2));
	const confidence = Math.max(0.05, Math.min(1, 0.5 * sizeFactor + 0.5 * dispersionFactor(gaps)));
	return { n: nEst, confidence };
}
