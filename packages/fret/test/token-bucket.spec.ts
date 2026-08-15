import { expect } from 'chai';
import { TokenBucket } from '../src/utils/token-bucket.js';

describe('TokenBucket edge cases', () => {
	it('rejects non-positive refill rate at construction', () => {
		expect(() => new TokenBucket(10, 0)).to.throw();
		expect(() => new TokenBucket(10, -1)).to.throw();
	});

	it('accepts a positive refill rate', () => {
		expect(() => new TokenBucket(10, 1)).to.not.throw();
	});

	it('an oversized cost is deterministically satisfiable after the wait it reports, not permanently stuck', () => {
		const bucket = new TokenBucket(5, 5);
		expect(bucket.tryTake(5)).to.equal(true); // drain to 0
		expect(bucket.tryTake(10)).to.equal(false); // cost exceeds capacity

		const wait = bucket.retryAfterMs(10);
		expect(wait).to.be.greaterThan(0);

		// Simulate the reported wait elapsing.
		(bucket as unknown as { last: number }).last -= wait;

		// A cost that can never be reached (> capacity) must still resolve
		// deterministically once the reported wait has elapsed, rather than
		// the promised wait being a lie that never pays off.
		expect(bucket.tryTake(10)).to.equal(true);
	});
});
