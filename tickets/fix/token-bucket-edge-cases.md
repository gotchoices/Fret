----
description: The rate-limiter mishandles a couple of degenerate inputs: a request that can never fit still reports a finite time to wait, and a non-positive refill rate produces infinite or negative wait times.
files: packages/fret/src/utils/token-bucket.ts
difficulty: easy
----
Two edge cases in the token bucket produce nonsensical results. A request whose cost exceeds the bucket capacity is permanently unsatisfiable, yet `retryAfterMs` returns a finite wait as if it would eventually succeed. And a refill rate less than or equal to zero yields Infinity or negative wait times. The core refill math is otherwise sound.

Expected behavior: an oversized request is handled deterministically rather than promising a wait that never pays off, and invalid refill rates are rejected at construction rather than producing degenerate waits at runtime.

Requirements:
- Clamp cost to capacity (or throw) so an oversized request has a well-defined outcome.
- Validate the refill rate at construction and reject non-positive values.

References: review RPC-section "Token bucket edge cases" (token-bucket.ts:14-29). Recommended fix: clamp/validate cost against capacity; assert refill rate is positive in the constructor.
