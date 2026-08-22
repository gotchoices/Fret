description: When our own node runs out of network stream slots, several places in the service must react the same way — count it, blame nobody. Only one of those places had a test; a new table-driven test now covers all of them.
files: packages/fret/test/rpc.stream-caps-local-limit-arms.spec.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.stream-caps-local-limit-scoring.spec.ts
difficulty: medium

## What landed

One new file, `packages/fret/test/rpc.stream-caps-local-limit-arms.spec.ts`. **No source
changes** — this ticket was test-only by design, and the shipped behavior it pins was already
correct at HEAD.

The spec is a table (`Arm[]`) over the outcome-observing sites in `fret-service.ts`. Each row names
one site, names the protocol that site dials, and supplies a `drive()` that performs exactly one
outbound request through that site. The table is walked twice:

- **control block** — every row driven with no cap installed anywhere. Asserts `diag.streamLimit`
  does not move, no contact strike, peer alive; some rows add a positive proof that the call really
  reached the peer (`pingsOk`, `pingsSent`, `announcementsSent`).
- **capped block** — a `before` registers every protocol the table names on the *dialing* node at
  `maxOutboundStreams: 0`, then every row is driven `REFUSALS` (4) times. Asserts no contact
  strike, not dead, membership/relevance/failureCount/successCount/negotiateFailures unchanged, no
  backoff, and `diag.streamLimit` up by **exactly 4** — one per refusal.

Ordering between the two blocks is load-bearing and is called out in the file: a control running
after its own protocol was capped would assert nothing.

### Rows (8)

| Row | Site | Protocol dialed |
|---|---|---|
| `probeNeighborLatency` | `noteRpcFailure` `case 'local-limit'`, 882 | ping |
| `probeMembership` | same arm, off-ring pass (the pass whose *other* failure arms record backoff) | ping |
| shared-seam row | the five sites at 2472/2695/2754/3067/3436 that route into `noteRpcFailure` | ping |
| `pingWarmupTargets` | arm 2, 1699 | ping |
| `iterativeLookup` | arm 3, 3347 | maybeAct |
| `sendAnnouncementsRateLimited` | arm 4 via announce, 1616 | neighbors **announce** |
| leave notice | arm 4 via `sendLeave`, 1863 | leave |
| leave fan-out | arm 4 via `sendLeave` fan-out, 1881 | leave |

Note the announce row caps `PROTOCOL_NEIGHBORS_ANNOUNCE`, not `PROTOCOL_NEIGHBORS` — the ticket
flagged confusing that pair as the likeliest way to write a vacuously-passing row.

## Validation actually run

- `cd packages/fret && npx tsc --noEmit` — clean.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/rpc.stream-caps*.spec.ts" --timeout 30000`
  — 29 passing, including the 17 new cases.
- `yarn test` (full suite) — **1281 passing, 0 failing, ~9 min.** No pre-existing failures
  surfaced, so `tickets/.pre-existing-error.md` was not written.

## Known gaps — treat these as the starting line, not the finish

Written honestly; each is a real hole a reviewer could widen.

- **The two leave rows do not drive `sendLeaveToNeighbors`.** They produce a *real* refusal by
  calling `sendLeave` against the capped leave protocol and then hand that real outcome to
  `noteWriteOnlyOutcome`. So the helper and the refusal are genuine, but the fan-out loop wrapping
  them — its `isDoomedDial` skip, its `budget.signal.aborted` break, its `computeReplacements`
  work — is not exercised. The announce row (arm 4's third caller) **does** drive its real loop, so
  arm 4's production path is covered once; the leave rows add protocol coverage rather than loop
  coverage. Driving `sendLeaveToNeighbors` directly was skipped because it runs inside `stop()` and
  needs a cached self ring coordinate the deliberately-unstarted local service may not have. Worth
  a reviewer's attempt.
- **Nothing here is concurrent.** The ticket called out "exactly once per refusal under
  concurrency" as an edge case: the pooled passes (warm-up fan-out, stabilization tick) can refuse
  several tasks at once, and a shared-increment bug would read as "went up" under either shape. The
  `pingWarmupTargets` row drives a **single-id** fan-out, so it pins the arm but not the pool. A
  multi-peer warm-up row against several capped peers would close this.
- **The lookup row pins one refusal, not the walk's reaction to it.** `maxAttempts: 1` was chosen
  to make the count deterministic regardless of when `visited` gains the target. Consequently the
  `hop++` / `continue` behavior after a refusal (and the `NOTE:` at that site about over-spending a
  hop) is unpinned.
- **Private methods are reached by cast** (`svc as unknown as { ... }`), as the template spec does.
  A signature change in `fret-service.ts` will not break these rows at compile time — it will make
  them fail at runtime, or worse, silently drive nothing if a method is renamed and the cast still
  type-checks. The control block is the guard against that: a renamed method throws there first.
- **`REFUSALS = 4` is asserted against the live `cfg.deadAfterFailures`** in its own `it`, so the
  "would have killed the peer" claim is checked rather than assumed.

## Still open — companion ticket

`debt-local-limit-arms-noncounting` (sequence 42.5) extends **this same file** with the rows that
must *not* count (`cancelled` / `skipped`), plus the source `NOTE:` and the `docs/fret.md`
paragraph. Nothing in that scope was done here.

## Suggested review focus

- Is any row vacuous? The cheapest check: comment out one `registerRpcHandler` cap in the capped
  block's `before` and confirm the matching row fails.
- Is the `entry()` snapshot comparison (`start` vs `now`) actually sensitive? `relevance` in
  particular is compared by `===` against a value captured before the loop.
- Does the shared-seam row earn its place, or is it the same assertion as row 1 in different
  clothing?
