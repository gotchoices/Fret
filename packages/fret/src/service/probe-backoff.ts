import { ExpiringMap } from '../utils/expiring-map.js';

/**
 * Per-peer probe backoff: the escalating window that keeps the off-ring probe passes and the
 * routing cost function from hammering a peer that has just failed.
 *
 * Extracted from `FretService` so the escalation arithmetic can be unit-tested without sleeps or
 * a libp2p node, following the house pattern `SizeObserver` sets: the class reads nothing but its
 * own state and an injectable clock. One clock drives **both** the window stamp and the retention
 * TTL, which is what lets a spec step a fake clock across a whole escalation schedule.
 *
 * See `docs/fret.md`, *Security and abuse considerations* → the bounded bookkeeping maps.
 */
export interface ProbeBackoffOptions {
	/**
	 * Hard entry ceiling, forwarded to the backing {@link ExpiringMap}. Required — see the sizing
	 * note at the `FretService` call site.
	 */
	capacity: number;
	/** First window; doubled per failure. Default {@link ProbeBackoff.DEFAULT_BASE_MS}. */
	baseMs?: number;
	/**
	 * Cap on the doubling factor; longest window is `baseMs * maxFactor`.
	 * Default {@link ProbeBackoff.DEFAULT_MAX_FACTOR}.
	 *
	 * NOTE: a `maxFactor` of 0 makes {@link ProbeBackoff.penalty} return `NaN` from the second
	 * failure onward (`Math.min(1, 0 / 0)`), which would poison the routing cost sum silently.
	 * Unreachable today — the only production caller passes the static default and no config knob
	 * reaches here — so it is left unguarded rather than validated in the constructor, matching the
	 * retention-inequality decision below. Revisit if this ever becomes caller- or config-supplied.
	 */
	maxFactor?: number;
	/**
	 * How long an escalation is remembered after the last failure. Must exceed
	 * `baseMs * maxFactor`. Default {@link ProbeBackoff.DEFAULT_RETAIN_MS}.
	 */
	retainMs?: number;
	/**
	 * Clock seam. Default `Date.now`. Drives BOTH the window stamp and the retention TTL, so a
	 * caller stepping a fake clock moves the whole schedule together.
	 */
	now?: () => number;
}

/** One peer's live escalation: when its current window closes, and how far it has escalated. */
interface BackoffEntry {
	until: number;
	factor: number;
}

export class ProbeBackoff {
	/**
	 * First backoff window, doubled on each further failure up to {@link DEFAULT_MAX_FACTOR}.
	 *
	 * A named constant rather than a literal inside `record` so the retention inequality below can
	 * be asserted against the real value instead of a copy of it.
	 */
	static readonly DEFAULT_BASE_MS = 1000;
	/** Cap on the doubling factor: the longest window is `DEFAULT_BASE_MS × DEFAULT_MAX_FACTOR`. */
	static readonly DEFAULT_MAX_FACTOR = 32;
	/**
	 * How long a peer's backoff *escalation* is remembered after its last failure — deliberately
	 * not the backoff window itself.
	 *
	 * {@link penalty} keeps an entry whose `until` has passed so the next {@link record} doubles
	 * `factor` instead of restarting at 1; that escalation is what tapers a genuinely foreign or
	 * dead peer toward ~once/32 s. So retention means "forget a peer's escalation once it has gone
	 * this long without failing again", and it must comfortably exceed the longest backoff window
	 * (`DEFAULT_BASE_MS × DEFAULT_MAX_FACTOR` = 32 s) — otherwise a peer re-probed at the slowest
	 * cadence would have its entry forgotten *between* probes and silently reset to factor 1, which
	 * is exactly the escalation this constant exists to preserve. 5 min is ~9× the longest window;
	 * `test/probe-backoff.spec.ts` pins the inequality so tuning either side fails loudly.
	 */
	static readonly DEFAULT_RETAIN_MS = 300_000;

	readonly baseMs: number;
	readonly maxFactor: number;
	readonly retainMs: number;
	/** Retained entries; what `capacity` bounds. Normalized by the backing map. */
	readonly capacity: number;

	private readonly entries: ExpiringMap<BackoffEntry>;
	private readonly now: () => number;

	constructor(opts: ProbeBackoffOptions) {
		this.baseMs = opts.baseMs ?? ProbeBackoff.DEFAULT_BASE_MS;
		this.maxFactor = opts.maxFactor ?? ProbeBackoff.DEFAULT_MAX_FACTOR;
		this.retainMs = opts.retainMs ?? ProbeBackoff.DEFAULT_RETAIN_MS;
		this.now = opts.now ?? Date.now;
		// NOTE: `retainMs <= baseMs * maxFactor` is a misconfiguration, deliberately not a runtime
		// throw — it is pinned as a test over the shipped defaults instead, matching how
		// `test/stabilize-budget-invariants.spec.ts` treats the tick budgets. Specs construct with
		// deliberately tiny windows, so a constructor assert would fire in them.
		this.entries = new ExpiringMap<BackoffEntry>({
			capacity: opts.capacity,
			ttlMs: this.retainMs,
			now: this.now,
		});
		this.capacity = this.entries.capacity;
	}

	get size(): number {
		return this.entries.size;
	}

	/**
	 * One more failure: start at factor 1, or double the retained factor up to {@link maxFactor}.
	 * Restarts the retention window.
	 */
	record(id: string): void {
		// Absent *or* retention-expired both read as `undefined` here, and both mean the same
		// thing: this peer's escalation is forgotten, so the next window starts at factor 1.
		const existing = this.entries.get(id);
		const factor = existing ? Math.min(existing.factor * 2, this.maxFactor) : 1;
		// `set`, never a read-modify-write of the retained entry: `ExpiringMap.set` deletes then
		// re-inserts, which both restarts the retention window (so retention is measured from the
		// last failure rather than the first — see DEFAULT_RETAIN_MS) and moves the refreshed key
		// to the newest iteration slot so it is not chosen as the next eviction victim.
		this.entries.set(id, { until: this.now() + this.baseMs * factor, factor });
	}

	/** Forget one peer's escalation entirely (proof of life). */
	clear(id: string): void {
		this.entries.delete(id);
	}

	/** Forget every peer's escalation (a start → stop → start cycle is a fresh run). */
	clearAll(): void {
		this.entries.clear();
	}

	/**
	 * Is this peer inside an open window right now? The off-backoff gate.
	 *
	 * Exactly `penalty(id) === 0` negated, and provably so: a retained entry always carries
	 * `factor >= 1`, so an open window always yields `penalty > 0`, and `penalty === 0` means
	 * "no live entry, or window closed". Pinned by the agreement test in the spec.
	 */
	isBackedOff(id: string): boolean {
		const entry = this.entries.get(id);
		if (!entry) return false;
		return entry.until >= this.now();
	}

	/** Routing-cost term in [0,1]: `min(1, factor / maxFactor)` while the window is open, else 0. */
	penalty(id: string): number {
		const entry = this.entries.get(id);
		if (!entry) return 0;
		// Window over; the entry is retained so `factor` grows on the next `record`.
		if (entry.until < this.now()) return 0;
		return Math.min(1, entry.factor / this.maxFactor);
	}

	/**
	 * Escalation factor, 0 when nothing is retained. The ordering key for the re-probe arms.
	 *
	 * Distinct from {@link isBackedOff} and {@link penalty}: a *closed window* and a *forgotten
	 * entry* both read as not-backed-off with penalty 0, and only this tells them apart.
	 */
	factor(id: string): number {
		return this.entries.get(id)?.factor ?? 0;
	}

	/** Drop retention-expired entries. */
	sweep(): void {
		this.entries.sweep();
	}

	/**
	 * Drop entries for peers the predicate says are gone.
	 *
	 * **Orthogonal to {@link sweep}, not a duplicate of it**: a peer evicted from the routing table
	 * may still be well inside its retention window, and no TTL can see that it is gone. Walks the
	 * key *snapshot* `ExpiringMap.keys()` returns, so deleting while iterating is safe.
	 */
	prune(isKnown: (id: string) => boolean): void {
		for (const id of this.entries.keys()) {
			if (!isKnown(id)) this.entries.delete(id);
		}
	}
}
