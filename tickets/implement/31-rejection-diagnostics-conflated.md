description: Finish updating tests and docs after the rejection-counter split landed in the service code, then verify the build and test suite pass.
files: packages/fret/test/profile.behavior.spec.ts, packages/fret/test/inflight-concurrency.spec.ts, docs/fret.md, packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/maybe-act.ts
difficulty: easy
tradeoffs: n/a (implement ticket)
---

<!-- resume-note -->
**All 9 source edits from the prior ticket (`31-rejection-diagnostics-conflated`) landed** — this
is a clean continuation, not a resume-from-failure. Killed by `BUDGET_WARNING`, not by an error.
Do NOT re-verify the source edits below; they are done and confirmed by diagnostics during the
prior run. Only steps 6-9 remain.

## What already landed (do not redo)

`packages/fret/src/service/fret-service.ts`:
- `diag.rejected` (~line 415) now has `rateLimited: { neighbors, ping, maybeAct, leave,
  announce }` (all 0) instead of a flat `rateLimited: 0`, plus a new sibling field
  `concurrencyLimited: 0` with a doc comment distinguishing it from a token-bucket rejection.
- The six former `this.diag.rejected.rateLimited++` sites now write to the keyed field:
  `handleNeighborsRequest` → `.neighbors++`, `handlePingRequest` → `.ping++`, the maybeAct token
  bucket check → `.maybeAct++`, `handleLeave` → `.leave++`, `handleAnnounce` → `.announce++`.
- The maybeAct **inflight concurrency cap** rejection (separate from the token bucket, ~line
  1423) now increments the new `this.diag.rejected.concurrencyLimited` field instead of
  `rateLimited` — this is the actual conflation the ticket exists to fix: a token-bucket flood
  and an inflight-capacity issue are different mechanisms with different remediation.
- The `registerMaybeAct(...)` call site inside `registerRpcHandlers` now passes a 5th arg,
  `() => { this.diag.rejected.malformed++; }`, as `onMalformed`.

`packages/fret/src/rpc/maybe-act.ts`:
- Imports `createLogger` from `../logger.js` and constructs `const log =
  createLogger('rpc:maybe-act');`.
- `registerMaybeAct` takes a new optional 5th param `onMalformed?: () => void`.
- The handler body now wraps `decodeJson<RouteAndMaybeActV1>(bytes)` in try/catch: on decode
  failure it logs (`log.error('%s: undecodable body - dropping - %e', protocol, err)`), calls
  `onMalformed?.()`, replies with a static empty `NearAnchorV1` (`{ v: 1, anchors: [],
  cohort_hint: [], estimated_cluster_size: 0, confidence: 0 }`), and returns — instead of
  throwing out of the handler (which previously made `registerRpcHandler` abort the stream with
  no diagnostic counted at all).

**Not yet checked**: whether `tsc --noEmit` is clean after these edits. It was not clean
immediately after the six `rateLimited++` edits landed one-by-one (arithmetic-on-object errors,
expected mid-sequence) but every site has since been converted to the keyed form. No compiler run
has confirmed the final state — that is part of step 9 below, do it first before touching tests.

## Steps remaining

6. `packages/fret/test/inflight-concurrency.spec.ts`: assert on `diag.rejected.concurrencyLimited`
   (not `rateLimited.maybeAct` — that would silently re-merge the two counters this ticket splits
   apart). Drop/rewrite the comment about the shared counter being unambiguous by construction —
   it relied on sizing fan-out to stay inside the token bucket so no too-fast rejection mixed into
   the tally; once split that constraint is no longer load-bearing.
7. `packages/fret/test/profile.behavior.spec.ts`: update every read of `diag.rejected.rateLimited`
   to the keyed shape (`diag.rejected.rateLimited.<protocol>`); if any site sums across protocols,
   sum the record's values there instead.
8. `docs/fret.md` — three sites name the old flat counter, update all three:
   - departure-notice section (*Leave*): "The only local signal is
     `diag.rejected.rateLimited`" → name the specific keyed field, `rateLimited.leave`.
   - concurrency-cap bullet under *Operating profiles*: "a bucket rejection and an inflight
     rejection both increment `diag.rejected.rateLimited` and differ only in `retry_after_ms`" —
     this sentence is now **false**; rewrite to say they increment different fields
     (`rateLimited.maybeAct` vs `concurrencyLimited`), which is the fix.
   - security section's rate-limiting bullet (*Security and abuse considerations* → *Current
     state*) mentioning `diag.rejected.rateLimited` generically — update to describe the
     per-protocol keyed shape.
   - Do not touch the other five `rejected.*` fields (`payloadTooLarge`, `timestampBounds`,
     `ttlExpired`, `identityMismatch`, `malformed`) — already unambiguous, out of scope.
9. `cd packages/fret && npx tsc --noEmit && yarn test` (targeted specs first — the two above —
   then full suite) before handoff to review/. Fix any fallout from the source edits (e.g. other
   test or non-test call sites reading `diag.rejected.rateLimited` as a number) discovered along
   the way; grep for `rejected.rateLimited` and `rejected\.rateLimited` across `packages/fret/src`
   and `packages/fret/test` to find every remaining site before declaring done.

## End

No other scope. Once 6-9 pass, write the review/ handoff per the ticket workflow (distilled
summary emphasizing test/validation use cases, honest about any gaps found in step 9).
