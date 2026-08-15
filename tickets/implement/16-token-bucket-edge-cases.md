description: The rate-limiter mishandles a couple of degenerate inputs: a request that can never fit still reports a finite time to wait, and a non-positive refill rate produces infinite or negative wait times.
files: packages/fret/src/utils/token-bucket.ts, packages/fret/test/token-bucket.spec.ts
difficulty: easy
----
Reproduced in `packages/fret/test/token-bucket.spec.ts` (added this stage, currently 2 of 3 tests failing against the unfixed `TokenBucket`):

1. **Non-positive refill rate.** `new TokenBucket(capacity, 0)` or a negative rate is accepted silently. `retryAfterMs` then divides by that rate (`deficit / this.refillPerSec`), producing `Infinity` (rate 0) or a negative wait (negative rate).
2. **Oversized cost.** `tryTake(cost)` with `cost > capacity` can never succeed — `refill()` caps `tokens` at `this.capacity` (token-bucket.ts:35), so `tokens` never reaches `cost`. But `retryAfterMs(cost)` still computes a finite `deficit = cost - this.tokens` and reports a plausible wait, as if the caller would eventually succeed by retrying. It never will. Confirmed in the repro test: after simulating the exact wait `retryAfterMs` reports having elapsed, `tryTake` with the same oversized cost still returns `false`.

Recommended fix (both edits in `packages/fret/src/utils/token-bucket.ts`):
- In the constructor, validate `refillPerSec > 0` and throw otherwise (e.g. `if (!(refillPerSec > 0)) throw new Error(...)`). This rejects the invalid rate at construction rather than producing degenerate waits at runtime.
- In `tryTake` and `retryAfterMs`, clamp `cost` to `this.capacity` (`Math.min(cost, this.capacity)`) before using it. This makes an oversized request deterministically satisfiable once the bucket refills to full, rather than permanently unreachable — and the reported `retryAfterMs` becomes true (time to refill to capacity), matching the repro test's expectation that `tryTake` succeeds once that wait elapses.

This exact approach was implemented and verified during the fix stage (typecheck clean, full `yarn test` suite green — 417 passing — with the repro test passing under the fix) before being reverted to hand off through the normal ticket pipeline; re-applying the two edits above should reproduce that result.

## TODO
- Validate `refillPerSec > 0` in the `TokenBucket` constructor; throw on non-positive values.
- Clamp `cost` to `this.capacity` in both `tryTake` and `retryAfterMs`.
- Confirm `packages/fret/test/token-bucket.spec.ts` passes (all 3 tests).
- `cd packages/fret && npx tsc --noEmit` and `yarn test` clean.
