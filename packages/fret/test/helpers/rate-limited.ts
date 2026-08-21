interface RateLimitedCounts {
	neighbors: number
	ping: number
	maybeAct: number
	leave: number
	announce: number
}

/**
 * Sum the five per-protocol `rejected.rateLimited` counters into one total. Deliberately
 * excludes the sibling `concurrencyLimited` field (the maybeAct inflight-cap rejection), which
 * is not one of the five rate-limited buckets.
 */
export function sumRateLimited(rateLimited: RateLimitedCounts): number {
	return (
		rateLimited.neighbors +
		rateLimited.ping +
		rateLimited.maybeAct +
		rateLimited.leave +
		rateLimited.announce
	)
}
