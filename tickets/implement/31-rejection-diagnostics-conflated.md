description: Finish updating tests and docs after the rejection-counter split landed in the service code, then verify the build and test suite pass.
files: packages/fret/test/profile.behavior.spec.ts, packages/fret/test/inflight-concurrency.spec.ts, docs/fret.md, packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/maybe-act.ts
difficulty: easy
tradeoffs: n/a (implement ticket)
---

<!-- resume-note -->
**All 9 source edits landed** (confirmed a third time via `npx tsc --noEmit`, clean against
`src/`). Killed by `BUDGET_WARNING` a **fourth** time, this run even earlier than the third —
before any edit landed. **Zero edits this run either** — only 2 greps for triage (below). Do NOT
re-verify source edits, they are done and correct. Do NOT re-run tsc/grep to re-derive the site
list below — it is now confirmed exhaustive (two independent greps + the prior run's tsc error
list all agree), spend the next run's budget on edits, not more triage.

**Grep confirmation this run** (`grep -rn "rejected\.rateLimited\|rejected\.concurrencyLimited" test/`):
matched exactly the site list already in this note (`announce-rate-limit.spec.ts`,
`inflight-concurrency.spec.ts`, `payload-bounds-ttl.spec.ts`, `profile.behavior.spec.ts`,
`rpc.codec-properties.spec.ts`) — no new files. Also grepped `rpc.handler-fuzz.spec.ts`
specifically for `rateLimited` — confirms the `:1184` site from the previous tsc run **and**
reveals its exact shape, which the previous note had not yet read (new detail, see below).

**New this run: ran `cd packages/fret && npx tsc --noEmit` for the first time this ticket.**
It is clean on `src/`, and fails only on test files reading `diag.rejected.rateLimited` as a
number (arithmetic ops on what is now an object). This gives a **partial** checklist — read the
warning below before using it as a to-do list.

**IMPORTANT — tsc errors are a subset, not the full site list. Do not stop at green tsc.**
Most test assertions use Chai (`expect(x).to.equal(y)`, `.include(...)`), which is untyped and
will NOT throw a tsc error when comparing `diag.rejected.rateLimited` (now an object) against a
number — it just silently fails at runtime (assertion mismatch) or, worse, is comparing the
wrong shape and passing vacuously. So the full step-6-9 line-by-line pass described below is
**still required in full** — do not treat "tsc passes" as "done". The tsc output below is a
*confirmation aid* for the sites that happen to use arithmetic (`before - after`, `after - before`
etc.), not a replacement for reading each file section named in steps 6-8.

**Full `tsc --noEmit` error output this run** (26 errors, all `TS2362`/`TS2363` "arithmetic
operation" pairs — i.e. sites doing `X - diag.rejected.rateLimited.foo` style delta math where
the left/right operand is still the whole object, not a number):
- `test/announce-rate-limit.spec.ts:94`, `:113`
- `test/inflight-concurrency.spec.ts:198`
- `test/profile.behavior.spec.ts:340`
- `test/rpc.codec-properties.spec.ts:1363`, `:1376`, `:1389`, `:1405`, `:1426`, `:1451`, `:1473`,
  `:1553`, `:1657`
- `test/rpc.handler-fuzz.spec.ts:1184` — **shape now confirmed** (read this run, lines
  1177-1187):
  ```
  const before = { ...edge.getDiagnostics().rejected }      // line 1177
  ...send a burst of 12 messages (mixed malformed + rate-limited)...
  const after = edge.getDiagnostics().rejected               // line 1182
  const malformed = after.malformed - before.malformed
  const rateLimited = after.rateLimited - before.rateLimited // line 1184 — TS2362/2363 here
  expect(malformed + rateLimited, 'every message hit exactly one of the two').to.equal(12)
  expect(malformed, '...').to.be.at.least(8)
  expect(rateLimited, '...').to.be.at.least(1)
  ```
  This is a **sum-across-protocols** site, same shape as the `rpc.codec-properties.spec.ts:1429`
  five-path case — it doesn't care which protocol was rate-limited, only the total count. Fix:
  replace line 1184 with a sum over the five keyed sub-fields, e.g.
  `const sumRL = (r) => r.rateLimited.neighbors + r.rateLimited.ping + r.rateLimited.maybeAct + r.rateLimited.leave + r.rateLimited.announce`
  then `const rateLimited = sumRL(after) - sumRL(before)`. (`before` is a shallow spread —
  `before.rateLimited` is the *same object reference* as the live counter, so `sumRL(before)` must
  be read before line numbers matter only insofar as the spread already captured it at the top;
  no ordering bug, just note the shallow-spread means `before.rateLimited` was never actually
  snapshotted by value — harmless here since it's only summed, not mutated.) Consider defining
  `sumRL` once near the top of the block (or hoist to a small test-local helper) since the same
  pattern likely recurs at the `rpc.codec-properties.spec.ts:1429` five-path site — a shared
  helper avoids writing the five-field sum twice. Add it to whatever grep/sweep step 9 runs.

A prior run's grep (`grep -n "rejected.rateLimited\|rejected\.rateLimited\|concurrencyLimited" -r
src test`) had already surfaced `test/announce-rate-limit.spec.ts` and
`test/payload-bounds-ttl.spec.ts` as extra affected files beyond the original `files:` list, and
flagged `test/rpc.codec-properties.spec.ts` as having many sites. That grep evidently missed
`test/rpc.handler-fuzz.spec.ts:1184` (likely because the property access there doesn't match
those exact literal strings — check for a variable/destructured reference instead of a literal
`rejected.rateLimited` substring). **Re-run that grep AND cross-check against the tsc list above
AND read `rpc.handler-fuzz.spec.ts` directly** — three independent methods, because each has
proven to miss something the others catch.

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

**This is the 4th consecutive `BUDGET_WARNING` kill on this ticket, each ending before any test
edit landed.** The site inventory (steps 6-9 below, plus 7a) is now complete and cross-verified by
three independent methods (grep, tsc errors, direct read) — treat it as final. Next run: skip
straight to editing steps 6, 7, 7a, 8 in file order, do not re-grep or re-derive the list, and
only run tsc/tests once at the end (step 9) rather than after each file, to leave more budget for
edits.

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
