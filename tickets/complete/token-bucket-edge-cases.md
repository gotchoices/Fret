----
description: The rate limiter now rejects nonsense settings and nonsense request sizes up front, so a bucket that exists always actually limits — previously a bad setting could silently turn limiting off or produce impossible wait times.
files: packages/fret/src/utils/token-bucket.ts, packages/fret/test/token-bucket.spec.ts
----

`TokenBucket` is the global per-protocol rate limiter behind every inbound FRET RPC
(seven buckets, constructed in `fret-service.ts`). Its two entry points — construction
and per-call cost — now both validate, so a bucket that exists is a bucket that limits.

### Final behavior

- **Constructor** rejects a `capacity` or `refillPerSec` that is not positive and finite.
- **Cost** is normalized once, at a single private seam used by both `tryTake` and
  `retryAfterMs`: a negative or non-finite cost throws; a cost above `capacity` is
  clamped to `capacity`.
- Refill still ignores a backwards wall clock, so a clock jump cannot mint tokens.

## Review findings

### Read the implement diff first
`b2627fa` is three lines in `packages/fret/src/utils/token-bucket.ts`: the
`refillPerSec > 0` constructor guard and the `Math.min(cost, capacity)` clamp in each of
`tryTake` / `retryAfterMs`. Both are correct as far as they go, and the implementer's
oversized-cost test is genuinely load-bearing (it fails against the unclamped code).
The findings below are about the *halves that were left open*, all at the same site.

### Major — none filed as tickets
Both defects found are one-line input-validation gaps in the same 42-line file the
ticket already owned, with no caller depending on the old behavior. Fixing them inline
was strictly cheaper than a ticket, so nothing was filed. Checked the board first with
`grep -rl` over the five working stages: `tickets/plan/12-test-coverage-gaps.md`,
`tickets/plan/13-rpc-codec-fuzzing.md` and `tickets/backlog/impl/4-per-peer-rate-limiting.md`
name `TokenBucket`, but none claims the input-validation site — 12 wants a refill-over-time
test (now covered here, which shrinks its scope), 13 is about wire codecs, 4 is a future
per-peer bucket that will *inherit* these guards. No accepted-tradeoff `NOTE:` exists at
the site, so nothing was previously declined here.

### Minor — fixed in this pass

- **`capacity` was unvalidated while `refillPerSec` was guarded, and the asymmetry was
  the worse half.** `new TokenBucket(0, r)` clamps every cost to `0`, so `tokens >= cost`
  always holds and the bucket admits every request forever — a rate limiter that silently
  stops limiting, which is a security-relevant failure mode rather than a bad wait time.
  `NaN` and `Infinity` capacities are equally nonsense. Now rejected at construction.
- **The cost clamp was one-sided, so a negative cost credited the bucket.**
  `Math.min(cost, capacity)` has no floor, so `tryTake(-3)` reached `this.tokens -= -3`
  and *added* three tokens — handing the caller free future requests, i.e. the exact
  inverse of the limiter's job. A non-finite cost was equally unhandled: `NaN` propagates
  through `tokens >= cost` (false) and out of `retryAfterMs` as a `NaN` wait, which is the
  same nonsense-wait-time class the ticket was opened to close. Both now throw — a
  negative or `NaN` cost is a caller bug, not a rate-limit decision, so it should be loud.
- **Architecture, not two more point guards.** The clamp was duplicated verbatim in
  `tryTake` and `retryAfterMs`; a third public method added later would have had to
  remember it. Both now call one private `normalizeCost`, and the constructor's two
  checks share one `assertPositiveFinite` helper. That makes the bad state
  unrepresentable at both entry seams rather than per-method, so this whole
  bad-number-in class is retired for the file. File is 71 lines — no size concern
  (`wc -l packages/fret/src/utils/token-bucket.ts`).

### Test coverage — expanded from 3 to 14
The implementer's three tests covered the two changed lines and nothing else; the file
had no happy-path or regression coverage at all, so the clamp could have been rewritten
into a no-op without a failure. Now grouped and covering:
- *Construction*: non-positive and non-finite refill rate; non-positive and non-finite
  capacity; positive-finite accepted.
- *Cost validation*: negative cost rejected **and budget proven untouched** by the
  rejected call; non-finite cost rejected; zero cost satisfiable and free.
- *Happy path* (previously absent): drain-to-empty, `retryAfterMs` returns 0 while
  tokens remain, refill over elapsed time **capped at capacity** (a 60 s jump must yield
  `capacity`, not 120 tokens), and a satisfiable cost honouring its own reported wait.
- *Oversized cost*: the implementer's wait-is-not-a-lie test, plus its missing companion —
  an oversized cost must still drain the **whole** bucket, so the clamp cannot make an
  over-ask cheaper than a full-capacity ask.
- *Regression*: a backwards clock must not credit tokens (`refill`'s `deltaSec > 0` guard
  was untested).

### Tripwires — parked, not filed
- The test suite advances time by rewinding the bucket's private `last` field. Parked as
  a `NOTE:` on the `elapse` helper in `test/token-bucket.spec.ts`: fine for one affordance,
  but a second test-only reach-in should become an injectable clock instead of widening
  this one. Not a ticket — it costs nothing today and only becomes work if the class grows.

### Docs — checked, no change needed
Read every `docs/fret.md` section naming token buckets: *Rate limiting & backpressure (A7)*,
*Cheap-guard rejections*, and *Security → Current state*. All three describe **where** the
bucket is taken relative to the other guards and how it is profile-tuned; none states a
constructor or cost contract, so nothing there was falsified or made stale by this change.
The new guards are a util-level invariant below the altitude that document works at, so
adding them would be noise. No `docs/` edit made — deliberately, not by omission.

### Validation
- `npx tsc --noEmit` — clean.
- `yarn build` — clean.
- `yarn test` — **428 passing, 0 failing** (full suite, ~5m); up from the implementer's
  417 by the 11 net new token-bucket tests. All 7 `fret-service` buckets construct fine
  under the new constructor guard (`profile.behavior.spec.ts` asserts each capacity/refill
  pair and passes), and every production call site uses the default `cost = 1`, so no
  caller is affected by the cost validation.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
