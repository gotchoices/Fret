description: Finish updating tests and docs after the rejection-counter split landed in the service code, then verify the build and test suite pass.
files: packages/fret/test/profile.behavior.spec.ts, packages/fret/test/inflight-concurrency.spec.ts, docs/fret.md, packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/maybe-act.ts
difficulty: easy
tradeoffs: n/a (implement ticket)
---

<!-- resume-note -->
**All 9 source edits landed** (confirmed again this run via direct read of
`fret-service.ts:398-426`) — clean continuation, not resume-from-failure. Killed by
`BUDGET_WARNING` a second time, before any edit this run. Do NOT re-verify source edits.

**New this run: a full-repo grep for `rejected.rateLimited` / `concurrencyLimited` already ran**
(`grep -n "rejected.rateLimited\|rejected\.rateLimited\|concurrencyLimited" -r src test`), so the
next agent should NOT redo that discovery — the site list below is exhaustive as of this commit.
It surfaced **two more affected test files beyond the ticket's original `files:` list**:
`test/announce-rate-limit.spec.ts` and `test/payload-bounds-ttl.spec.ts`, plus confirms
`test/rpc.codec-properties.spec.ts` has many sites too (not in original `files:` list either).

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

6. `packages/fret/test/inflight-concurrency.spec.ts` (lines ~166, ~198 — `rateLimitedBefore` /
   the delta assertion at ~198): assert on `diag.rejected.concurrencyLimited` (not
   `rateLimited.maybeAct` — that would silently re-merge the two counters this ticket splits
   apart). Drop/rewrite the comment at line ~25 about the shared counter being unambiguous by
   construction — it relied on sizing fan-out to stay inside the token bucket so no too-fast
   rejection mixed into the tally; once split that constraint is no longer load-bearing.
7. `packages/fret/test/profile.behavior.spec.ts` (lines ~250, ~332, ~339): update every read of
   `diag.rejected.rateLimited` to the keyed shape (`diag.rejected.rateLimited.<protocol>`); if any
   site sums across protocols, sum the record's values there instead.
7a. **New sites found this run, not in the original `files:` list — same treatment as step 7:**
   - `packages/fret/test/announce-rate-limit.spec.ts` lines 87, 94, 107, 113 — both tests drive
     `handleAnnounce` directly, so both `before`/delta reads want the keyed field
     `diag.rejected.rateLimited.announce`.
   - `packages/fret/test/payload-bounds-ttl.spec.ts` line 365 — drains `bucketMaybeAct` then calls
     `handleMaybeAct`, so this read wants `diag.rejected.rateLimited.maybeAct`. Check the sibling
     test right after it (~line 370, "returns BusyResponseV1 when neighbors bucket exhausted") for
     a similar assertion further down the same `describe` block that the grep may have missed if
     it names the field differently — read the full `describe('rate limit busy response', ...)`
     block (roughly lines 335-450) and fix every `rejected.rateLimited` read in it, keyed per
     protocol under test (neighbors bucket test → `.neighbors`, etc., following whichever handler
     each sub-test drains).
   - `packages/fret/test/rpc.codec-properties.spec.ts` — the largest surface, ~17 occurrences at
     lines 1357, 1363, 1370, 1376, 1383, 1389, 1398, 1405, 1420, 1426, 1429 (comment), 1442, 1451,
     1460, 1473, 1643, 1657. Read the file from ~1340 to ~1660 in one pass rather than
     line-by-line: most are `before`/delta pairs around a single rejection path (leave, neighbors,
     maybeAct, announce, ping — key to whichever protocol that sub-test exercises), **except**
     the block around line 1429-1451** which explicitly sums **five** rejection paths into one
     delta ("five paths, five increments") — that one must sum the five *keyed* sub-fields of
     `rateLimited` (not `concurrencyLimited`, which is a sibling field outside `rateLimited` and
     not one of the five) to reproduce the same total, and its comment at 1429 needs rewording
     since "one more contributor than the five buckets" describes the pre-split shape.
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
