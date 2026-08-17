----
description: The limit on how many requests the service handles at once is checked today by poking its internal counter directly, so nothing verifies the counter actually goes up and back down around real request handling — including when a request fails partway.
files: packages/fret/test/inflight-concurrency.spec.ts (new), packages/fret/test/profile.behavior.spec.ts, packages/fret/src/service/fret-service.ts (handleMaybeAct ~1128-1187, read-only), docs/fret.md
difficulty: medium
----

## What is wrong today

`FretService` bounds how many inbound `maybeAct` messages it will work on at once with a
private counter, `inflightAct` (`fret-service.ts:192`). `handleMaybeAct` compares it against a
profile limit — **Core 16 / Edge 4** — answers `{busy: true, retry_after_ms: 500}` when the
limit is reached, otherwise increments it, does the routing work, and decrements in a `finally`:

```ts
const limit = this.cfg.profile === 'core' ? 16 : 4;
if (this.inflightAct >= limit) { this.diag.rejected.rateLimited++; return { v: 1, busy: true, retry_after_ms: 500 }; }
this.inflightAct++;
try {
    const result = await this.routeAct(msg, keyBytes);
    this.cacheResponse(msg, result);
    return result;
} catch (err) {
    log.error('routeAct failed - %e', err);
    return await this.nearAnchorOnly(msg, keyBytes);
} finally {
    this.inflightAct--;
}
```

The two tests covering this (`profile.behavior.spec.ts:248-281`, the `Edge allows
handleMaybeAct when inflightAct < 4, rejects at 4` / `Core ... < 16, rejects at 16` cases)
**assign** the counter — `(svc as any).inflightAct = 4` — and then fire a single request. That
proves only that the comparison on line 1175 reads the field. It cannot observe the
increment/decrement pairing at all, which is the whole point of a counter: the failure modes
are that the counter drifts upward until the service permanently answers busy, or that the
decrement is skipped on the exception path. Neither is reachable by writing the field.

Worse, those tests actively assert the wrong thing about the healthy arm: they check
`result?.retry_after_ms` is not `500` at limit−1. Under the current code that request is *not*
busy at all, so `retry_after_ms` is `undefined` and the assertion passes for reasons unrelated
to concurrency.

## Why this is testable without any transport

Three facts make a fully deterministic test possible with a single node and no network:

1. **A single-node service is in-cluster for every key.** After `start()` with no dials, the
   store holds only self, which is seeded `member`. `routeAct` computes
   `neighborDistance(selfId, coord, clusterWindow)`; the cohort is `[self]`, so the distance is
   `0` and `inCluster` is true. With `msg.activity` set and a handler installed via
   `setActivityHandler`, `routeAct` awaits that handler (`fret-service.ts:2383-2391`). A test
   handler that blocks is therefore the lever that holds `inflightAct` up.
2. **The whole guard chain up to `inflightAct++` is synchronous.** `handleMaybeAct` is `async`,
   but every statement from the token-bucket take down to the increment runs before the first
   `await` (`routeAct`). So calling it N times in a plain `for` loop *without awaiting* leaves
   the counter at exactly the cap when the loop returns, with the surplus calls already
   resolved busy. No sleeps, no polling, no timing assumptions.
3. **The token bucket must not be the binding constraint.** `bucketMaybeAct` holds 32 tokens on
   Core and 8 on Edge (`fret-service.ts:391-394`) and is taken *before* the inflight check, so a
   fan-out larger than the bucket produces bucket-busy replies that are indistinguishable from
   inflight-busy ones in `diag.rejected.rateLimited` (both increment it). Keep N inside the
   bucket capacity and the only busy replies are the inflight ones — discriminated further by
   `retry_after_ms === 500`, the fixed inflight sentinel (the bucket returns its own computed
   value, 250 ms at the Edge refill rate).

That fixes the fan-out sizes: **Edge N = 6** (cap 4, 8 tokens — 4 admitted, 2 busy, 2 tokens
spare) and **Core N = 20** (cap 16, 32 tokens — 16 admitted, 4 busy, 12 spare).

## Shape of the new spec

New file `packages/fret/test/inflight-concurrency.spec.ts`, named to match the existing
`stabilize-concurrency.spec.ts` / `preconnect-concurrency.spec.ts` pair, which are the other two
specs that pin a concurrency bound by observing real work rather than by writing a field. Follow
their idiom: assert the high-water mark **equals** the cap, so the test proves the calls actually
overlapped rather than merely that none exceeded the bound.

Setup per case: one `createMemNode()`, one `FretService`, a gated activity handler.

```ts
function makeGate() {
    let open!: () => void
    const opened = new Promise<void>((resolve) => { open = resolve })
    return { opened, open }
}

// entered/peak are mutated only from the handler body, which runs on the single JS thread
const gate = makeGate()
let entered = 0, peak = 0
svc.setActivityHandler(async () => {
    entered++
    peak = Math.max(peak, entered)
    await gate.opened
    entered--
    return { commitCertificate: 'ok' }
})
```

The message factory needs an `activity` field (any base64url string) and a **distinct
`correlation_id` per call** — the dedup cache is consulted before the inflight check, so reused
ids would short-circuit later calls. `profile.behavior.spec.ts` already has a
`makeMaybeActMsg(correlationId)`; the new spec needs its own local variant carrying `activity`
rather than importing across spec files.

### Cases

- **Cap admits exactly `limit` and refuses the surplus (one case per profile).**
  Fan out N calls synchronously into an array of promises without awaiting. Immediately after
  the loop — still before any microtask runs — assert `(svc as any).inflightAct === limit`
  (Edge 4 / Core 16). Then `gate.open()`, `await Promise.all(...)`, and assert:
  - exactly `N - limit` results have `busy === true` and `retry_after_ms === 500`;
  - exactly `limit` results are commit certificates (`{ commitCertificate: 'ok' }`);
  - `peak === limit` — the admitted calls were genuinely concurrent inside the handler, not
    serialized;
  - `diag.rejected.rateLimited` rose by exactly `N - limit` (attributable because the bucket
    was never the binding constraint).

- **The counter returns to zero once everything settles.** Same fan-out; after
  `await Promise.all(...)`, assert `(svc as any).inflightAct === 0`. Reading the private field
  is the observation this ticket is about; **writing** it is what is being removed.

- **The counter returns to zero when the activity handler throws.** Install a handler that
  increments its own call count and then throws. `routeAct` propagates, `handleMaybeAct` catches
  and answers via `nearAnchorOnly`, and the `finally` must still decrement. Assert:
  - every call *resolves* (none rejects) — the handler's throw must not escape `handleMaybeAct`;
  - each admitted call's result is a `NearAnchor` (has an `anchors` array, no
    `commitCertificate`);
  - `(svc as any).inflightAct === 0` afterwards.
  Run this arm on the profile whose cap is small (Edge) so the fan-out stays inside the bucket,
  and gate the throwing handler the same way so the throw happens *after* the fan-out has
  saturated the cap — a handler that throws synchronously on entry would let each slot free
  before the next call arrives and the cap would never be reached.

- **A slot freed is a slot reusable.** After the settle assertions of the first case, issue one
  further call and assert it is admitted (reaches the handler / returns a certificate) rather
  than busy. This is what distinguishes "the counter came back to 0" from "the counter came back
  to 0 but the service is wedged for another reason". A full *second* wave of N is deliberately
  not attempted: the token bucket does not refill fast enough to fund two full waves, and
  draining it would reintroduce exactly the ambiguity the fan-out sizes above avoid — note this
  in a comment so a later reader does not "strengthen" the test into a flaky one.

### Test hygiene

- **Teardown in `finally` (or an `afterEach`), not on the last line of the body.** A failing
  assertion otherwise skips `svc.stop()` / `node.stop()`, leaving stabilization timers live; the
  mocha exit watchdog then fails the run a second time with an open-handle dump that buries the
  real assertion message. `plan/21-cleanup-tests` is separately introducing a shared
  mesh-setup-and-teardown helper and lists `profile.behavior.spec.ts` among the specs that need
  it — do not add a new leak site for it to clean up.
- **The gate must always open, even on a failed assertion**, or the pending `handleMaybeAct`
  promises never settle and the suite hangs rather than reporting. Open it in the same `finally`
  as teardown.
- No `setTimeout`-based waits anywhere in this spec. Every ordering it depends on is either
  synchronous (the fan-out) or explicitly awaited (the gate).

### Deliberate boundary

These cases call `handleMaybeAct` directly rather than driving real streams between two nodes.
That is the right level: the counter and its guard live entirely inside that method, the inbound
stream/handler layer is already pinned by `rpc.handler-fuzz.spec.ts` and
`rpc.stream-errors.spec.ts`, and a two-node variant would add dial latency and flake without
observing anything new about the counter. State this in a comment at the top of the spec so it
reads as a decision rather than an omission.

## Edge cases & interactions

- **Guard ordering.** The bucket is taken *before* the inflight check, so a busy-from-bucket and
  a busy-from-inflight both increment `diag.rejected.rateLimited` and differ only in
  `retry_after_ms`. Keeping N within bucket capacity is load-bearing for the diagnostic
  assertion, not a convenience — say so in a comment.
- **Dedup cache vs. the cap.** The dedup lookup precedes the inflight check. Duplicate
  correlation ids would return cached answers without ever touching the counter, silently
  turning a fan-out of N into a fan-out of 1. Distinct ids per call.
- **Cache-on-success.** A successful activity-bearing call caches its commit certificate
  (`cacheResponse` stores only terminal answers for the activity phase). Harmless with distinct
  ids; relevant if a later edit reuses one.
- **Busy replies never touch the counter.** The refusal returns *before* the increment, so the
  post-fan-out reading must be exactly `limit`, never `limit + (N - limit)`. Assert equality, not
  `<=`.
- **The error path's fallback must not itself throw.** `nearAnchorOnly` hashes the key and walks
  the ring twice; on a single-node store both walks return self or nothing. It is safe today —
  but if it ever threw, `finally` would still decrement while the call *rejected*, so assert
  resolution explicitly rather than only checking the counter.
- **Profile parity.** Both caps must be pinned. Core 16 and Edge 4 are the numbers the deleted
  tests asserted and they must survive the replacement, expressed behaviorally (exactly `limit`
  handler entries out of N) rather than by reading the constant.
- **Single-node in-cluster premise.** The whole spec rests on "a lone node is in-cluster for
  every key". If a future change makes a single-node service refuse to act, every case here goes
  green-but-vacuous (zero handler entries, all calls returning `NearAnchor`). Guard it: assert at
  least one handler entry occurred, so the premise failing shows up as a failure rather than as
  silence.
- **Run isolation.** `svc.start()` arms the stabilization loop. Nothing in these cases needs it,
  but its ticks share the same store; keep each case's service freshly constructed so a tick from
  a previous case cannot mutate a later one's store.

## TODO

- Add `packages/fret/test/inflight-concurrency.spec.ts` with the cases above: cap-admits-exactly
  (Edge and Core), counter-returns-to-zero, counter-returns-to-zero-on-handler-throw, and
  slot-reuse-after-settle.
- Delete the two counter-writing cases from the `Concurrent act limits` block of
  `profile.behavior.spec.ts` (lines 248-281). Leave the three bucket-exhaustion cases in that
  block untouched — they test the token bucket, not the inflight cap.
- Replace the deleted cases with a short pointer comment naming the new spec and what it pins,
  matching the `Phase 5: Preconnect budget` comment already in that file
  (`profile.behavior.spec.ts:359-366`), which is the established shape for "this moved, and here
  is why the old version proved nothing".
- Add one line to `docs/fret.md` under *Operating profiles* stating the inbound `maybeAct`
  concurrency cap explicitly (Core 16 / Edge 4) and naming `test/inflight-concurrency.spec.ts` as
  what pins it, including the decrement-on-error-path invariant. The doc currently says only
  "Smaller/Higher inbound RPC concurrency" with no numbers, and describing behavior inline next
  to the spec that pins it is the pattern that has stayed current there.
- Run `cd packages/fret && npx tsc --noEmit`, then the new spec alone, then the full
  `yarn test` in the foreground (no redirection) to confirm no regression and no open handles.
