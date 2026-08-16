import { ExpiringMap, type Clock as ExpiringMapClock } from '../utils/expiring-map.js';

/**
 * How long a deduplicated answer is remembered.
 *
 * Kept in lockstep with the default message-freshness window (`validateTimestamp`): a message
 * that is still fresh enough to accept must still be recognised as a repeat, or the gap between
 * the two is a window in which a captured message can be replayed and re-performed.
 */
export const DEDUP_TTL_MS = 30_000;

/** Re-exported so existing importers of the dedup cache's clock type keep working. */
export type Clock = ExpiringMapClock;

/**
 * Bounded TTL cache for correlation-ID deduplication.
 *
 * A named, single-purpose face on {@link ExpiringMap} — the TTL/capacity rules and the O(1)
 * nearest-expiry eviction live there, shared with the other capacity-bounded bookkeeping maps.
 * That eviction property matters most here: this is the one such map an attacker can churn at
 * their own rate, so an O(n) eviction would be a CPU denial-of-service.
 */
export class DedupCache<T> {
	private readonly entries: ExpiringMap<T>;

	constructor(ttlMs = DEDUP_TTL_MS, maxSize = 1024, now: Clock = Date.now) {
		this.entries = new ExpiringMap<T>({ capacity: maxSize, ttlMs, now });
	}

	get(key: string): T | undefined {
		return this.entries.get(key);
	}

	has(key: string): boolean {
		return this.entries.has(key);
	}

	set(key: string, result: T): void {
		this.entries.set(key, result);
	}
}
