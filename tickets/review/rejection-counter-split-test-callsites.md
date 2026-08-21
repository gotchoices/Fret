description: Finished the test/doc call-site sweep for the rejection-counter split — every place that used to read `diag.rejected.rateLimited` as a flat number now reads the right per-protocol field, and the design doc matches.
files: packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/payload-bounds-ttl.spec.ts, packages/fret/test/helpers/rate-limited.ts, docs/fret.md
---

## Root cause (context for the reviewer)

Commit `71be306` changed `FretService.diag.rejected.rateLimited` from a flat number to a keyed
object `{neighbors, ping, maybeAct, leave, announce}`, plus a new sibling `concurrencyLimited`.
The `src/` change landed correctly; this ticket (refiled 8 times as `fix/`, always stuck at the
research stage before an eventual `BUDGET_WARNING`) was the remaining test/doc sweep.

## What changed this pass

- **`test/helpers/rate-limited.ts`** (new, landed in a prior pass): `sumRateLimited(rateLimited)`
  sums the five keyed sub-fields, excluding `concurrencyLimited`.
- **`test/rpc.codec-properties.spec.ts`**: 8 sites fixed. Six single-bucket tests now key their
  `before`/assertion to the one field the test actually drains (`.maybeAct`, `.neighbors`,
  `.ping`, `.leave`, `.announce` — twice, once for the in-process leave test and once for the
  wire-level leave test). The "five paths, five increments" test now uses `sumRateLimited`. The
  shallow-spread hazard site (`'takes the token before validation...'`) now captures
  `beforeMaybeActRateLimited` as a scalar before the drain, since `{ ...rejected }` only shallow-copies
  and `before.rateLimited` was aliasing the live counter object.
- **`test/rpc.handler-fuzz.spec.ts:1184`**: same shallow-spread hazard, same fix — a scalar
  `beforeMaybeActRateLimited` captured before the burst, compared against `.maybeAct` (this test
  drives only the maybeAct protocol, so the single field is the correct comparison, not the sum).
- **`test/rpc.handler-fuzz.wire.spec.ts:183`**: confirmed out of scope — grepped, no read of
  `rejected.rateLimited` anywhere in the file.
- **`test/payload-bounds-ttl.spec.ts:365`**: dropped the `(diag as any).rejected.rateLimited`
  cast; the sub-test only drains `bucketMaybeAct`, so it now reads
  `diag.rejected.rateLimited.maybeAct` with full typing (no `as any` needed for this field; the
  rest of the file's `as any` casts on `svc`/`handleMaybeAct` are a private-method-access pattern
  unrelated to this ticket and untouched).
- **`docs/fret.md`**: three sites updated — the leave section now says
  `diag.rejected.rateLimited.leave`; the inflight-cap bullet now correctly says a bucket rejection
  and an inflight rejection increment two different fields (`rateLimited.maybeAct` vs the sibling
  `concurrencyLimited`), not the same counter; the *Current state* rate-limiting bullet now
  describes the per-protocol keyed shape.

## Verify

`cd packages/fret && npx tsc --noEmit` — clean, zero errors.

`cd packages/fret && yarn test` — 1217 passing, 3 failing. The 3 failures are pre-existing and
unrelated to this ticket's diff (filed in `tickets/.pre-existing-error.md` for the triage pass):

- `RPC handler fault isolation > registerRpcHandler release accounting > aborts once when the
  maybeAct body is not JSON` (`test/rpc.handler-fuzz.spec.ts:216`)
- `...aborts once when the maybeAct body decodes to a non-object` (`:227`)
- `RPC handler fault isolation over the wire > ... > releases the inbound stream for every
  malformed shape in the matrix` (`test/rpc.handler-fuzz.wire.spec.ts:196`)

All three assert `abort()` vs `close()` release accounting on a malformed maybeAct body — a
`registerRpcHandler` subsystem this ticket's diff never touches (the diff's only edit in
`rpc.handler-fuzz.spec.ts` is at line ~1176-1188, the unrelated rate-limited-counter fix). `git
diff` confirms no overlap with the failing tests' code paths.

## Review findings

(none yet — first pass through review)
