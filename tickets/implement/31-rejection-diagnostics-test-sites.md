description: Update the first group of test files to read the new per-protocol rejection counters instead of the single shared tally that was just split apart.
files: packages/fret/test/inflight-concurrency.spec.ts, packages/fret/test/profile.behavior.spec.ts, packages/fret/test/announce-rate-limit.spec.ts, packages/fret/test/payload-bounds-ttl.spec.ts
difficulty: easy
tradeoffs: n/a (implement ticket)
---

**Split 1 of 3, by the gardener 2026-08-21.** The original `31-rejection-diagnostics-conflated`
was killed on `BUDGET_WARNING` four consecutive times with zero test edits landed — not because
its instructions were vague (they were precise) but because the remaining work is more than one
budget holds, and each run re-read 172 lines before starting. Siblings:
`31.5` (`rpc.codec-properties.spec.ts`, ~17 sites) and `31.7` (docs + full gate).

## Already landed — do not redo, do not re-verify

All source edits are in, confirmed clean against `src/` by `npx tsc --noEmit`:

`src/service/fret-service.ts`
- `diag.rejected.rateLimited` is now a record `{ neighbors, ping, maybeAct, leave, announce }`
  instead of a flat number, with a new **sibling** field `concurrencyLimited: 0` beside it.
- The six former `rateLimited++` sites write to the keyed field: `handleNeighborsRequest` →
  `.neighbors`, `handlePingRequest` → `.ping`, the maybeAct token-bucket check → `.maybeAct`,
  `handleLeave` → `.leave`, `handleAnnounce` → `.announce`.
- The maybeAct **inflight concurrency cap** rejection now increments `concurrencyLimited`. This is
  the conflation the ticket exists to fix: a token-bucket flood and an inflight-capacity limit are
  different mechanisms with different remediation.
- `registerMaybeAct(...)` gains a 5th arg `() => { this.diag.rejected.malformed++; }`.

`src/rpc/maybe-act.ts`
- Wraps `decodeJson` in try/catch: logs, calls `onMalformed?.()`, replies with a static empty
  `NearAnchorV1`, returns — instead of throwing out of the handler, which made
  `registerRpcHandler` abort the stream with no diagnostic counted at all.

The site inventory below was cross-verified by three independent methods (grep, tsc error list,
direct read) and is final. **Spend this run's budget on edits, not triage.**

## Edits

1. **`test/inflight-concurrency.spec.ts`** (~166 `rateLimitedBefore`, ~198 the delta assertion) —
   assert on `diag.rejected.concurrencyLimited`, **not** `rateLimited.maybeAct`; using the latter
   would silently re-merge the two counters this ticket splits. Rewrite the comment at ~25 about
   the shared counter being "unambiguous by construction" — it depended on sizing fan-out to stay
   inside the token bucket, a constraint that is no longer load-bearing once split.
2. **`test/profile.behavior.spec.ts`** (~250, ~332, ~339) — keyed shape
   `diag.rejected.rateLimited.<protocol>`. If a site sums across protocols, sum the record's
   values there.
3. **`test/announce-rate-limit.spec.ts`** (87, 94, 107, 113) — both tests drive `handleAnnounce`,
   so every `before`/delta read wants `.rateLimited.announce`.
4. **`test/payload-bounds-ttl.spec.ts`** (365, plus the rest of its `describe('rate limit busy
   response', ...)` block, roughly 335–450) — read the whole block in one pass and key each read
   to whichever handler that sub-test drains (neighbors-bucket test → `.neighbors`, the maybeAct
   one → `.maybeAct`, and so on).

## Gate

`cd packages/fret && npx tsc --noEmit`, then run the four specs above. The full suite belongs to
`31.7`; do not run it here.

## Handoff

Leave `31.5` and `31.7` untouched. If a site outside these four files surfaces, add it to `31.5`
rather than fixing it here — the point of the split is that each piece fits one budget.
