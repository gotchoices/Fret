description: Rate limiter fixed to reject a non-positive refill rate at construction and to clamp an oversized request cost, so both used to produce nonsense wait times.
files: packages/fret/src/utils/token-bucket.ts, packages/fret/test/token-bucket.spec.ts
difficulty: easy
----
Both edits from the implement ticket landed in `packages/fret/src/utils/token-bucket.ts` (already committed at b2627fa, this stage confirmed + finished the handoff):

- Constructor throws `if (!(refillPerSec > 0))` — rejects zero/negative refill rate at construction instead of letting `retryAfterMs` divide by it (`Infinity` or negative wait).
- `tryTake` and `retryAfterMs` both clamp `cost = Math.min(cost, this.capacity)` before using it, so an oversized request becomes satisfiable once the bucket refills to full instead of permanently unreachable.

## Test coverage
`packages/fret/test/token-bucket.spec.ts` (3 tests, all passing):
- Non-positive refill rate (0 and -1) throws at construction.
- Positive refill rate does not throw.
- Oversized cost (`cost > capacity`): drain bucket, request oversized cost (fails), read `retryAfterMs`, fast-forward the bucket's internal clock by exactly that reported wait, then confirm `tryTake` with the same oversized cost now succeeds. This is the load-bearing case — it wouldn't pass under the old unclamped code, since `tokens` caps at `capacity` in `refill()` and can never reach an oversized `cost`.

## Validation this stage
- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && yarn build` — clean.
- `cd packages/fret && yarn test` — 417 passing, 0 failing (full suite, ~5m). All 3 token-bucket tests pass.

## Gaps / things reviewer should know
- Two call sites only: `tryTake` and `retryAfterMs` in this one small file. No other module constructs `TokenBucket` with a literal non-positive rate or an oversized cost today (checked via `grep -rn "new TokenBucket" packages/fret/src` — all call sites pass profile-derived positive constants), so this is a defensive/correctness fix for the class's public contract rather than a fix for an observed runtime bug. Worth a quick scan of callers if the reviewer wants to double check no caller relied on the old (buggy) silent-accept behavior.
- No behavior change for the common case (cost ≤ capacity, positive rate) — both clamps and the constructor guard are no-ops on the path every existing caller already takes.
