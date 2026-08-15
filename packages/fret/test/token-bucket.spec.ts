import { expect } from 'chai';
import { TokenBucket } from '../src/utils/token-bucket.js';

// The bucket reads Date.now() directly, so a test cannot advance real time.
// Rewinding `last` by N ms is equivalent to N ms having elapsed.
// NOTE: this reaches into a private field; if TokenBucket ever needs a second
// test-only affordance, give it an injectable clock instead of widening this.
function elapse(bucket: TokenBucket, ms: number): void {
	(bucket as unknown as { last: number }).last -= ms;
}

describe('TokenBucket edge cases', () => {
	describe('construction', () => {
		it('rejects a non-positive refill rate', () => {
			expect(() => new TokenBucket(10, 0)).to.throw(/refillPerSec/);
			expect(() => new TokenBucket(10, -1)).to.throw(/refillPerSec/);
		});

		it('rejects a non-finite refill rate', () => {
			expect(() => new TokenBucket(10, Number.NaN)).to.throw(/refillPerSec/);
			expect(() => new TokenBucket(10, Number.POSITIVE_INFINITY)).to.throw(/refillPerSec/);
		});

		// A zero capacity clamps every cost to zero, so `tokens >= cost` always
		// holds and the bucket silently stops limiting anything.
		it('rejects a non-positive or non-finite capacity', () => {
			expect(() => new TokenBucket(0, 5)).to.throw(/capacity/);
			expect(() => new TokenBucket(-1, 5)).to.throw(/capacity/);
			expect(() => new TokenBucket(Number.NaN, 5)).to.throw(/capacity/);
			expect(() => new TokenBucket(Number.POSITIVE_INFINITY, 5)).to.throw(/capacity/);
		});

		it('accepts positive finite parameters', () => {
			expect(() => new TokenBucket(10, 1)).to.not.throw();
		});
	});

	describe('cost validation', () => {
		// Unclamped, `tokens -= cost` with a negative cost *credits* the bucket
		// above capacity, handing the caller free future requests.
		it('rejects a negative cost rather than crediting tokens', () => {
			const bucket = new TokenBucket(5, 5);
			expect(() => bucket.tryTake(-3)).to.throw(/cost/);
			expect(() => bucket.retryAfterMs(-3)).to.throw(/cost/);
			// Budget untouched by the rejected call.
			expect(bucket.tryTake(5)).to.equal(true);
			expect(bucket.tryTake(1)).to.equal(false);
		});

		it('rejects a non-finite cost rather than poisoning the budget', () => {
			const bucket = new TokenBucket(5, 5);
			expect(() => bucket.tryTake(Number.NaN)).to.throw(/cost/);
			expect(() => bucket.tryTake(Number.POSITIVE_INFINITY)).to.throw(/cost/);
			expect(bucket.tryTake(5)).to.equal(true);
		});

		it('treats a zero cost as always satisfiable and free', () => {
			const bucket = new TokenBucket(5, 5);
			expect(bucket.tryTake(5)).to.equal(true); // drain
			expect(bucket.tryTake(0)).to.equal(true);
			expect(bucket.retryAfterMs(0)).to.equal(0);
		});
	});

	describe('happy path', () => {
		it('spends from a full bucket until it is empty', () => {
			const bucket = new TokenBucket(3, 1);
			expect(bucket.tryTake()).to.equal(true);
			expect(bucket.tryTake()).to.equal(true);
			expect(bucket.tryTake()).to.equal(true);
			expect(bucket.tryTake()).to.equal(false);
			expect(bucket.retryAfterMs()).to.be.greaterThan(0);
		});

		it('reports zero wait while tokens remain', () => {
			const bucket = new TokenBucket(5, 5);
			expect(bucket.retryAfterMs(5)).to.equal(0);
		});

		it('refills over elapsed time, capped at capacity', () => {
			const bucket = new TokenBucket(4, 2);
			expect(bucket.tryTake(4)).to.equal(true); // drain
			expect(bucket.tryTake(1)).to.equal(false);

			elapse(bucket, 1000); // 2 tokens/sec => 2 tokens
			expect(bucket.tryTake(2)).to.equal(true);
			expect(bucket.tryTake(1)).to.equal(false);

			elapse(bucket, 60_000); // far more than capacity's worth
			expect(bucket.tryTake(4)).to.equal(true); // capped at capacity, not 120
			expect(bucket.tryTake(1)).to.equal(false);
		});

		it('honours the wait it reports for a satisfiable cost', () => {
			const bucket = new TokenBucket(5, 5);
			expect(bucket.tryTake(5)).to.equal(true); // drain
			const wait = bucket.retryAfterMs(3);
			expect(wait).to.be.greaterThan(0);
			elapse(bucket, wait);
			expect(bucket.tryTake(3)).to.equal(true);
		});
	});

	describe('oversized cost', () => {
		it('is deterministically satisfiable after the wait it reports, not permanently stuck', () => {
			const bucket = new TokenBucket(5, 5);
			expect(bucket.tryTake(5)).to.equal(true); // drain to 0
			expect(bucket.tryTake(10)).to.equal(false); // cost exceeds capacity

			const wait = bucket.retryAfterMs(10);
			expect(wait).to.be.greaterThan(0);

			elapse(bucket, wait);

			// A cost that can never be reached (> capacity) must still resolve
			// deterministically once the reported wait has elapsed, rather than
			// the promised wait being a lie that never pays off.
			expect(bucket.tryTake(10)).to.equal(true);
		});

		// The clamp must not let an oversized cost cost *less* than capacity.
		it('still drains the whole bucket', () => {
			const bucket = new TokenBucket(5, 5);
			expect(bucket.tryTake(100)).to.equal(true);
			expect(bucket.tryTake(1)).to.equal(false);
		});
	});

	// The bucket must not manufacture tokens if the wall clock jumps backwards.
	it('ignores a backwards clock rather than crediting tokens', () => {
		const bucket = new TokenBucket(4, 2);
		expect(bucket.tryTake(4)).to.equal(true); // drain
		elapse(bucket, -10_000); // `last` moves into the future
		expect(bucket.tryTake(1)).to.equal(false);
	});
});
