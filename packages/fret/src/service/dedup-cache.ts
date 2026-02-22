/** Bounded TTL cache for correlation-ID deduplication. */
export class DedupCache<T> {
	private readonly entries = new Map<string, { result: T; expires: number }>();
	private readonly ttlMs: number;
	private readonly maxSize: number;

	constructor(ttlMs = 30_000, maxSize = 1024) {
		this.ttlMs = ttlMs;
		this.maxSize = maxSize;
	}

	get(key: string): T | undefined {
		const e = this.entries.get(key);
		if (!e) return undefined;
		if (e.expires < Date.now()) {
			this.entries.delete(key);
			return undefined;
		}
		return e.result;
	}

	has(key: string): boolean {
		return this.get(key) !== undefined;
	}

	set(key: string, result: T): void {
		if (this.entries.size >= this.maxSize) this.evictExpired();
		if (this.entries.size >= this.maxSize) this.evictOldest();
		this.entries.set(key, { result, expires: Date.now() + this.ttlMs });
	}

	private evictExpired(): void {
		const now = Date.now();
		for (const [k, v] of this.entries) {
			if (v.expires < now) this.entries.delete(k);
		}
	}

	private evictOldest(): void {
		// Delete the first (oldest-inserted) entry
		const first = this.entries.keys().next();
		if (!first.done) this.entries.delete(first.value);
	}
}
