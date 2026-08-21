description: Verify the first group of test files already reads the new per-protocol rejection counters correctly, after the diagnostics counter split.
files: packages/fret/test/inflight-concurrency.spec.ts, packages/fret/test/profile.behavior.spec.ts, packages/fret/test/announce-rate-limit.spec.ts, packages/fret/test/payload-bounds-ttl.spec.ts
---

**Split 1 of 3** (see `31.5-rpc-codec-properties-rejection-sites` and `31.7` for siblings). Source
split `diag.rejected.rateLimited` from a flat number into `{ neighbors, ping, maybeAct, leave,
announce }`, plus a new sibling `diag.rejected.concurrencyLimited` for the maybeAct inflight-cap
rejection (previously conflated with the maybeAct token-bucket rejection). Full detail on the
source change is in `src/service/fret-service.ts` and `src/rpc/maybe-act.ts` — unchanged this run.

## What this run found

On picking up this ticket, all four target files **already used the correct keyed shape** —
`diag.rejected.rateLimited.<protocol>` and `diag.rejected.concurrencyLimited` — with no trace of
the old flat-number reads the ticket description expected to find (e.g. no `rateLimitedBefore`
identifier, no "unambiguous by construction" comment in `inflight-concurrency.spec.ts`). `git
status` / `git diff --stat` showed a clean tree matching HEAD, so this was not leftover
uncommitted work from an earlier interrupted attempt — the edits were already committed. The
ticket's "Already landed" section was stale (it said only `src/` had landed).

Verified this run, no edits made:
- `cd packages/fret && npx tsc --noEmit` — clean.
- Ran all four target specs together: `node --import ./register.mjs node_modules/mocha/bin/mocha.js
  "test/inflight-concurrency.spec.ts" "test/profile.behavior.spec.ts"
  "test/announce-rate-limit.spec.ts" "test/payload-bounds-ttl.spec.ts" --timeout 30000` — **68
  passing**, 0 failing.

Specifically confirmed:
- `inflight-concurrency.spec.ts` asserts on `diag.rejected.concurrencyLimited` (not
  `rateLimited.maybeAct`) at the before/delta reads.
- `profile.behavior.spec.ts` reads `diag.rejected.rateLimited.maybeAct` and
  `diag.rejected.rateLimited.neighbors` (keyed).
- `announce-rate-limit.spec.ts` reads `diag.rejected.rateLimited.announce` (keyed) at all four
  sites.
- `payload-bounds-ttl.spec.ts`'s `rate limit busy response` block reads
  `diag.rejected.rateLimited.maybeAct` (keyed) and the neighbors-bucket case doesn't touch the
  counter at all (no delta assertion there, so nothing to re-key).

## For review

Reviewer: this ticket did no source or test edits — it is a verification pass confirming the four
listed files are already correct against the current `diag.rejected` shape, with a passing
build/typecheck/test run as evidence. Worth a quick sanity check that nothing here was
misdiagnosed (e.g. re-read `inflight-concurrency.spec.ts` lines ~166–202 against
`src/service/fret-service.ts`'s current `diag.rejected` shape) but no further action is expected
on these four files specifically.

Untouched, as instructed: `31.5-rpc-codec-properties-rejection-sites` (17 sites in
`test/rpc.codec-properties.spec.ts`) and `31.7` (docs + full gate) remain outstanding — this
ticket does not close out the rejection-diagnostics conflation work as a whole, only its first
split.

## Gate run this session
- `npx tsc --noEmit` (from `packages/fret/`): clean.
- Four target specs: 68/68 passing, ~13s.
- Full suite (`yarn test`) was **not** run here — out of scope per the original split (belongs to
  `31.7`).
