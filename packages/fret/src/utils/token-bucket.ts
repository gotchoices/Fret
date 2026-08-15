/**
 * A simple global token bucket used to rate-limit a single protocol or path.
 *
 * Both entry seams validate their inputs, so a bucket that exists is always a
 * bucket that limits: the constructor rejects a capacity or refill rate that
 * cannot produce a meaningful limit, and every cost is normalized once before
 * it is compared against `tokens`.
 */
export class TokenBucket {
	private capacity: number;
	private refillPerSec: number;
	private tokens: number;
	private last: number;

	constructor(capacity: number, refillPerSec: number) {
		assertPositiveFinite(capacity, 'capacity');
		assertPositiveFinite(refillPerSec, 'refillPerSec');
		this.capacity = capacity;
		this.refillPerSec = refillPerSec;
		this.tokens = capacity;
		this.last = Date.now();
	}

	tryTake(cost = 1): boolean {
		const want = this.normalizeCost(cost);
		this.refill();
		if (this.tokens >= want) {
			this.tokens -= want;
			return true;
		}
		return false;
	}

	retryAfterMs(cost = 1): number {
		const want = this.normalizeCost(cost);
		this.refill();
		if (this.tokens >= want) return 0;
		const deficit = want - this.tokens;
		const sec = deficit / this.refillPerSec;
		return Math.ceil(sec * 1000);
	}

	/**
	 * A cost above capacity can never be covered — `refill` caps `tokens` at
	 * `capacity` — so it is clamped rather than left permanently unsatisfiable
	 * with a wait time that never pays off. A negative or non-finite cost is a
	 * caller bug, not a rate-limit decision: unclamped it would *credit* tokens.
	 */
	private normalizeCost(cost: number): number {
		if (!(Number.isFinite(cost) && cost >= 0)) {
			throw new Error(`cost must be a non-negative finite number, got ${cost}`);
		}
		return Math.min(cost, this.capacity);
	}

	private refill(): void {
		const now = Date.now();
		const deltaSec = (now - this.last) / 1000;
		if (deltaSec > 0) {
			this.tokens = Math.min(this.capacity, this.tokens + deltaSec * this.refillPerSec);
			this.last = now;
		}
	}
}

function assertPositiveFinite(value: number, name: string): void {
	if (!(Number.isFinite(value) && value > 0)) {
		throw new Error(`${name} must be a positive finite number, got ${value}`);
	}
}
