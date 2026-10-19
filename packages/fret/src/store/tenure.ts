/**
 * Session tenure: how long this node has *itself* watched a peer stay up, measured from proof of
 * life only — a pure module with no clock of its own (callers pass `now`) and no service
 * dependencies, so the rules are unit-testable without sleeps.
 *
 * A **session** is a run of proofs of life in which no two consecutive proofs are more than
 * {@link TENURE_GAP_TOLERANCE_MS} apart. **Proven tenure** is `lastProvenAliveAt −
 * sessionStartedAt`: the span actually observed, frozen while the peer is silent — it never grows
 * on the clock alone, so a peer that went quiet gets no credit for the time it was away. The gap
 * is measured on our clock, so our own downtime past the tolerance restarts every session too: we
 * cannot vouch for time we did not observe.
 *
 * Nothing here is gossiped. Tenure is what *this* node saw, so no other peer can inflate it — the
 * same rule as frequency credit (`FretService.noteDiscovered`).
 */

/**
 * The longest silence a session survives. Covers "a few minutes of maintenance" with room to
 * spare, and must stay comfortably above the longest regular contact interval for a peer we
 * actively watch — the near pass at the idle-backoff cap (60 s) and the dead re-probe window
 * (at most 32 s) — or a healthy neighbour's session would break on its own. Not longer: a longer
 * tolerance lets an intermittent peer accumulate tenure across its absences.
 */
export const TENURE_GAP_TOLERANCE_MS = 15 * 60_000;
/** Below this many ms between stamps, a proof refreshes nothing (write coalescing). */
export const TENURE_STAMP_GRANULARITY_MS = 1_000;
/** Tenure at which the stability factor reaches half its maximum bonus. */
export const STABILITY_HALF_TENURE_MS = 60 * 60_000;
/** Maximum relevance multiplier bonus: factor ∈ [1, 1 + STABILITY_MAX_BONUS). */
export const STABILITY_MAX_BONUS = 0.5;

/** The two tenure stamps a routing-table entry carries — local-clock unix ms, 0 = never proven. */
export interface TenureFields {
	sessionStartedAt: number;
	lastProvenAliveAt: number;
}

/**
 * The patch a proof of life at `now` implies, or `undefined` when nothing needs writing.
 *
 * Continues the current session when the gap since the last proof is within the tolerance
 * (inclusive); otherwise — never proven, too long a silence, or `now` before the last stamp (the
 * clock went backwards, or the table came from a skewed clock) — starts a new one at `now`, so
 * tenure is never negative. A continuing proof less than {@link TENURE_STAMP_GRANULARITY_MS}
 * after the last stamp writes nothing, so a burst of RPCs costs one store write, not one per
 * message.
 */
export function noteProven(cur: TenureFields, now: number): TenureFields | undefined {
	const gap = now - cur.lastProvenAliveAt;
	// Written as "inside the window" rather than "outside it" so a non-finite stamp (a tampered
	// table) falls to a fresh session instead of continuing one.
	const continues = cur.lastProvenAliveAt !== 0 && gap >= 0 && gap <= TENURE_GAP_TOLERANCE_MS;
	if (!continues) return { sessionStartedAt: now, lastProvenAliveAt: now };
	if (gap < TENURE_STAMP_GRANULARITY_MS) return undefined;
	return { sessionStartedAt: cur.sessionStartedAt, lastProvenAliveAt: now };
}

/** Proven tenure in ms: 0 when never proven, and never negative or non-finite. */
export function provenTenureMs(cur: TenureFields): number {
	const t = cur.lastProvenAliveAt - cur.sessionStartedAt;
	return t > 0 ? t : 0;
}

/**
 * The relevance multiplier tenure earns: `1 + MAX · t / (t + HALF)` — 1 at zero tenure, about
 * 1.038 at 5 minutes, 1.25 at an hour, 1.49 at a day. Monotone and bounded below
 * `1 + STABILITY_MAX_BONUS`, so tenure can tip a close eviction but never dominate the other
 * relevance terms.
 */
export function stabilityFactor(tenureMs: number): number {
	const t = tenureMs > 0 ? tenureMs : 0;
	return 1 + STABILITY_MAX_BONUS * t / (t + STABILITY_HALF_TENURE_MS);
}
