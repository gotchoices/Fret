description: Finished and reviewed the test/doc call-site sweep for the rejection-counter split — every place that used to read the rate-limit rejection counter as a flat number now reads the right per-protocol field, and the design doc matches.
files: packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/payload-bounds-ttl.spec.ts, packages/fret/test/helpers/rate-limited.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
---

## What this was

Commit `71be306` changed `FretService.diag.rejected.rateLimited` from a flat number to a keyed
object `{neighbors, ping, maybeAct, leave, announce}`, plus a new sibling `concurrencyLimited`
(the maybeAct in-flight cap, which used to share the same counter). The `src/` change landed
correctly at the time; this ticket was the remaining test/doc call-site sweep. It was refiled
eight times as `fix/` before landing in `3dbc106`.

## What landed

- **`test/helpers/rate-limited.ts`** (new): `sumRateLimited(rateLimited)` sums the five keyed
  sub-fields, deliberately excluding `concurrencyLimited`.
- **`test/rpc.codec-properties.spec.ts`**: 8 sites. Six single-bucket tests key their `before`
  and their assertion to the one field the test actually drains; the "five paths, five
  increments" test uses `sumRateLimited`; the shallow-spread site captures a scalar
  `beforeMaybeActRateLimited` before the drain, since `{ ...rejected }` only shallow-copies and
  `before.rateLimited` was aliasing the live counter object.
- **`test/rpc.handler-fuzz.spec.ts:1184`**: same shallow-spread hazard, same scalar-capture fix,
  compared against `.maybeAct` (that burst drives only the maybeAct protocol).
- **`test/payload-bounds-ttl.spec.ts:365`**: dropped an `(diag as any)` cast; the field is now
  read with full typing.
- **`docs/fret.md`**: three sites — the leave signal, the inflight-cap bullet (which had claimed
  a bucket rejection and an inflight rejection increment the *same* counter), and the
  rate-limiting bullet under *Current state*.

## Review findings

### What was checked

- The implement diff (`3dbc106`) read in full, ahead of the handoff summary.
- The `src/` counter shape and every write site: `fret-service.ts:419` (declaration), `:424`
  (`concurrencyLimited`), and the six increment sites at `:1293`, `:1301`, `:1384`, `:1424`,
  `:1841`, `:2002`. Each writes the field matching its own protocol; no site writes the object
  as a whole.
- A grep sweep of all of `test/` and `docs/fret.md` for any surviving read of the counter as a
  flat number, and for every mention of it in prose.
- Whether the split's central claim — that a bucket rejection and an in-flight-cap rejection are
  now separately attributable — is actually pinned by a test.

### Found and fixed in this pass (minor)

- **`src/service/fret-service.ts:474`** — the `NOTE:` on the inbound-announce bucket's
  first-cut capacity told a future operator to watch `diag.rejected.rateLimited`, which is no
  longer a number. Retargeted to `diag.rejected.rateLimited.announce`, the field that bucket
  actually writes. Comment only; this is exactly the kind of stale operator guidance that sends
  someone to a field that does not exist.
- **`test/rpc.codec-properties.spec.ts:1430`** — the comment above the "five paths, five
  increments" test still asserted that `rejected.rateLimited` "has one more contributor than the
  five buckets" and that "the counter is shared" with the in-flight cap. That was the *pre-split*
  contract and is now false: the cap increments `concurrencyLimited`. It also pointed the reader
  at `profile.behavior.spec.ts` for the cap, which does not pin it. Rewritten to state the
  post-split fact — the five sub-fields summed by that test have exactly the five bucket paths as
  contributors — and pointed at `inflight-concurrency.spec.ts`, which does pin it. The stale
  version was actively misleading about the one invariant the surrounding test exists to assert.

### Test coverage (checked, no gap found)

The split's point — that the two rejection kinds are now separately attributable — is pinned:
`test/inflight-concurrency.spec.ts:168` and `:200-201` capture `concurrencyLimited` before the
burst and assert the cap rejection lands there rather than on `rateLimited.maybeAct`. The five
bucket paths each have a single-field test plus the summed five-path test in
`rpc.codec-properties.spec.ts`, and `profile.behavior.spec.ts:326` covers repeat increments on
one bucket. Per-field, summed, and cross-field-isolation are all covered; nothing to add.

### Major findings

None. This was a mechanical read-site sweep with no new logic, no new types and no `src/`
behavior change, so there is no architecture to climb — the ladder in *Before you file a ticket*
has no rung that applies to a set of call sites already made type-safe by the field split itself.
The one thing that could have been a real finding — a surviving flat read hiding behind an
`as any` cast, which the type system would not catch — was searched for by grep across all of
`test/` and found only at `payload-bounds-ttl.spec.ts:365`, which this diff fixed by *removing*
the cast rather than retargeting under it.

### Tripwires

None recorded. Nothing here is conditional-on-a-future-state: the diff either reads the right
field or it does not, and every site does.

### Accepted tradeoffs encountered

None — no `NOTE:` at any touched site records a declined finding on this counter.

## Verify

`cd packages/fret && npx tsc --noEmit` — clean, run in the implement pass.

`cd packages/fret && yarn test` — 1217 passing, 3 failing in the implement pass; the 3 are
pre-existing and unrelated (see below).

**Honest gap:** this review pass hit the runner's token budget before it re-ran the type-check
and suite itself. Its only edits are two comment bodies — one `//` block in a TS source file and
one in a spec file — with no expression, identifier or type touched, so the implement pass's
green results still hold. A reader wanting a fresh green run should re-run the two commands
above; nothing in this pass can have changed their outcome.

## Pre-existing failures (not this ticket)

Three failures, all asserting `abort()` vs `close()` release accounting on a malformed maybeAct
body — a `registerRpcHandler` subsystem this diff never touches:

- `RPC handler fault isolation > registerRpcHandler release accounting > aborts once when the
  maybeAct body is not JSON` (`test/rpc.handler-fuzz.spec.ts:216`)
- `...aborts once when the maybeAct body decodes to a non-object` (`:227`)
- `RPC handler fault isolation over the wire > ... > releases the inbound stream for every
  malformed shape in the matrix` (`test/rpc.handler-fuzz.wire.spec.ts:196`)

Filed in `tickets/.pre-existing-error.md` by the implement pass for the triage agent.
