/**
 * How long a deduplicated answer is remembered.
 *
 * Kept in lockstep with the default message-freshness window (`validateTimestamp`): a message
 * that is still fresh enough to accept must still be recognised as a repeat, or the gap between
 * the two is a window in which a captured message can be replayed and re-performed.
 */
export const DEDUP_TTL_MS = 30_000;

/**
 * Source of "now" in unix ms.
 *
 * Injectable so expiry can be driven from a caller-controlled clock. The wall clock is the
 * only default a production caller wants, but a *test* that steps it explicitly is testing
 * the expiry rule rather than the host's scheduler accuracy — a sleep-based test asserts on
 * `setTimeout` overshoot, which is unbounded under load and is not a property of this class.
 */
export type Clock = () => number;

/** Bounded TTL cache for correlation-ID deduplication. */
export class DedupCache<T> {
	private readonly entries = new Map<string, { result: T; expires: number }>();
	private readonly ttlMs: number;
	private readonly maxSize: number;
	private readonly now: Clock;

	constructor(ttlMs = DEDUP_TTL_MS, maxSize = 1024, now: Clock = Date.now) {
		this.ttlMs = ttlMs;
		this.maxSize = maxSize;
		this.now = now;
	}

	get(key: string): T | undefined {
		const e = this.entries.get(key);
		if (!e) return undefined;
		if (e.expires < this.now()) {
			this.entries.delete(key);
			return undefined;
		}
		return e.result;
	}

	has(key: string): boolean {
		return this.get(key) !== undefined;
	}

	set(key: string, result: T): void {
		// Refreshing an existing key never grows the map, so it must never trigger eviction.
		// Deleting first also moves the re-`set` key to the newest Map-iteration-order slot,
		// so a just-refreshed entry is never mistaken for the oldest.
		if (this.entries.has(key)) this.entries.delete(key);
		else if (this.entries.size >= this.maxSize) this.evictOldest();
		this.entries.set(key, { result, expires: this.now() + this.ttlMs });
	}

	private evictOldest(): void {
		// Insertion order and expiry order agree (constant ttlMs, and `set` re-inserts a refreshed
		// key at the newest slot with a fresh expiry), so the first (oldest-inserted) entry is also
		// the one nearest to expiry — evicting it needs no O(n) scan of the map.
		// NOTE: that agreement assumes the clock is non-decreasing. A backwards step can leave a
		// live entry ahead of an expired one, so one eviction picks the wrong victim; it
		// self-corrects on the next insert. If wall-clock steps ever matter here, construct with
		// a monotonic `Clock` rather than reintroducing a scan.
		const first = this.entries.keys().next();
		if (!first.done) this.entries.delete(first.value);
	}
}
