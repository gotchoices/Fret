description: Finish the test/doc call-site sweep left behind by the rejection-counter split; `npx tsc --noEmit` still fails at HEAD with TS2362/TS2363 errors in two spec files, plus payload-bounds-ttl.spec.ts's silent `as any` site and docs/fret.md still need the sweep.
prereq: none
files: packages/fret/test/payload-bounds-ttl.spec.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/rpc.handler-fuzz.wire.spec.ts, packages/fret/test/helpers/, docs/fret.md
difficulty: easy
---

## Progress so far (this pass, 4th refiling)

`packages/fret/test/profile.behavior.spec.ts` is done and verified (already landed by a prior
pass — unchanged this pass).

**This pass (3rd) did research only — no edits landed.** Ran `cd packages/fret && npx tsc --noEmit`
to get the current authoritative error list (paste below) and read
`test/rpc.codec-properties.spec.ts` lines 1320-1670 in full, working out exactly which bucket/
field each failing site needs. That mapping is recorded below so the next pass can go straight to
editing without re-reading the file. Hit the token budget immediately after, before editing or
reading the other three files (payload-bounds-ttl.spec.ts, rpc.handler-fuzz.spec.ts,
rpc.handler-fuzz.wire.spec.ts) or docs/fret.md.

**This pass (4th) re-verified the item-1 mapping against a fresh read of
`rpc.codec-properties.spec.ts` lines 1320-1670 — it matches the prior pass's map exactly, no
drift, ready to edit as written.** Also confirmed `packages/fret/test/helpers/wait-for.ts` exists
and is a good style reference for the new `sumRateLimited` helper (item 2): plain exported
function, one-line JSDoc-style comment block explaining the non-obvious *why*, no class. Hit the
token budget again immediately after this check, before making any edit. **No edits landed this
pass either** — same state as before, just the mapping re-confirmed. Next pass should stop
re-reading rpc.codec-properties.spec.ts (it's stable, re-verified twice now) and go straight to
writing the 8 line-edits + the helper file.

## Current authoritative tsc error list (2026-08-21, this pass)

```
test/rpc.codec-properties.spec.ts(1363,11): error TS2362
test/rpc.codec-properties.spec.ts(1363,55): error TS2363
test/rpc.codec-properties.spec.ts(1376,11): error TS2362
test/rpc.codec-properties.spec.ts(1376,55): error TS2363
test/rpc.codec-properties.spec.ts(1389,11): error TS2362
test/rpc.codec-properties.spec.ts(1389,55): error TS2363
test/rpc.codec-properties.spec.ts(1405,11): error TS2362
test/rpc.codec-properties.spec.ts(1405,55): error TS2363
test/rpc.codec-properties.spec.ts(1426,11): error TS2362
test/rpc.codec-properties.spec.ts(1426,55): error TS2363
test/rpc.codec-properties.spec.ts(1451,11): error TS2362
test/rpc.codec-properties.spec.ts(1451,55): error TS2363
test/rpc.codec-properties.spec.ts(1473,11): error TS2362
test/rpc.codec-properties.spec.ts(1473,55): error TS2363
test/rpc.codec-properties.spec.ts(1553,11): error TS2362
test/rpc.codec-properties.spec.ts(1553,31): error TS2363
test/rpc.codec-properties.spec.ts(1657,11): error TS2362
test/rpc.codec-properties.spec.ts(1657,55): error TS2363
test/rpc.handler-fuzz.spec.ts(1184,24): error TS2362
test/rpc.handler-fuzz.spec.ts(1184,44): error TS2363
```

(These are all "arithmetic on a non-number" — `rejected.rateLimited` is now
`{neighbors,ping,maybeAct,leave,announce}`, not a number, so every `x - before` site that used to
read the flat counter fails to compile.) `payload-bounds-ttl.spec.ts:365` and
`rpc.handler-fuzz.wire.spec.ts:183` are NOT in this list — both are silent (the first because of
an `as any` cast, the second not yet confirmed — see below), so tsc green alone will not prove
them fixed. Work the file list, not just this error list.

## Root cause (confirmed, not a hypothesis — same as every prior pass)

Commit `71be306` ("ticket(implement): rejection-diagnostics-conflated") changed
`FretService.diag.rejected` in `packages/fret/src/service/fret-service.ts` (~line 415) from
`rateLimited: 0` to `rateLimited: { neighbors: 0, ping: 0, maybeAct: 0, leave: 0, announce: 0 }`,
plus a new sibling `concurrencyLimited: 0` (the maybeAct inflight-cap rejection, split out of
`rateLimited`). **The `src/` half is complete and correct — do not re-edit it.**

Ticket `tickets/implement/31-rejection-diagnostics-conflated.md` is the origin; this `fix/` ticket
(refiled 3 times now, always on the same test/doc sweep, never an independent defect) is the
remaining test/doc call-site work.

## Already landed (do NOT redo)

- `packages/fret/test/announce-rate-limit.spec.ts` — lines 87, 94, 107, 113 read
  `rejected.rateLimited.announce`.
- `packages/fret/test/inflight-concurrency.spec.ts` — reads `rejected.concurrencyLimited`
  (local renamed `concurrencyLimitedBefore`); file-header note rewritten.
- `packages/fret/test/profile.behavior.spec.ts` — both sites fixed and verified.

## Remaining sites — exact fix map

### 1. `packages/fret/test/rpc.codec-properties.spec.ts` — fully mapped this pass, ready to edit

All in `describe('inbound token buckets', ...)` (~1331-1576) and
`describe('rate-limited requests over a real connection', ...)` (~1582-1670). Read the whole
block (1320-1670) if more context is needed — it's already been read once this pass, contents are
stable.

- **Test `'answers maybeAct with busy...'`** (~1353-1364): drains `bucketMaybeAct`, calls
  `handleMaybeAct`. Line 1357 (`before = ...rejected.rateLimited`) and line 1363 (the assertion)
  → both key to `.rateLimited.maybeAct`.
- **Test `'answers a neighbors request with busy...'`** (~1366-1377): drains `bucketNeighbors`,
  calls `handleNeighborsRequest`. Lines 1370, 1376 → `.rateLimited.neighbors`.
- **Test `'answers ping with busy...'`** (~1379-1390): drains `bucketPing`, calls
  `handlePingRequest`. Lines 1383, 1389 → `.rateLimited.ping`.
- **Test `'silently ignores a rate-limited leave...'`** (~1392-1406): drains `bucketLeave`, calls
  `handleLeave`. Lines 1398, 1405 → `.rateLimited.leave`.
- **Test `'drops a rate-limited inbound announce...'`** (~1408-1427): drains
  `bucketAnnounceInbound`, calls `handleAnnounce`. Lines 1420, 1426 → `.rateLimited.announce`.
- **Test `'increments rateLimited exactly once per rejection on every bucket path'`**
  (~1434-1452, "five paths, five increments"): drains **all five** buckets, calls all five
  handlers once each. Line 1442 (`before`) and line 1451 (the assertion, currently
  `.to.equal(5)`) must **sum the five keyed `rateLimited` sub-fields** — use the new
  `sumRateLimited` helper (see item 2 below), not `concurrencyLimited` (a sibling field, not one
  of the five — the comment at ~1429-1433 already correctly says this is out of scope here, no
  change needed to that comment).
- **Test `'keeps the buckets independent...'`** (~1454-1474): drains only `bucketMaybeAct`; only
  the maybeAct call is rejected (neighbors/ping/leave/announce all still succeed, undrained).
  Line 1460 (`before`) and line 1473 (the assertion, `'only the maybeAct rejection'`) →
  `.rateLimited.maybeAct`.
- **Test `'takes the token before validation...'`** (~1539-1554) — **the shallow-spread hazard,
  same bug class as 1543/1553 mentioned in prior passes' notes, confirmed by reading the code
  this pass**: line 1543 does `const before = { ...svc.getDiagnostics().rejected }` — this is a
  **shallow** spread, so `before.rateLimited` is the *same object reference* as the live counter
  (only top-level number fields like `malformed` are copied by value; `rateLimited`, being an
  object, is copied by reference). So `before.rateLimited.maybeAct` at line 1553 does not capture
  a snapshot — it silently reads whatever the live value is *at read time*, making the delta
  wrong (reads 0 even once keyed, per the original hypothesis — now confirmed). Fix: capture the
  scalar sub-field by value at snapshot time, e.g.
  `const beforeMaybeActRateLimited = svc.getDiagnostics().rejected.rateLimited.maybeAct` (a
  number, copied by value) alongside the existing `before.malformed`, then at line 1553 compare
  `after.rateLimited.maybeAct - beforeMaybeActRateLimited`. Line 1552 (`after.malformed -
  before.malformed`) is unaffected — `malformed` is a plain number field, the shallow spread
  already copies it correctly — leave it as is.
- **Test `'makes a rate-limited leave indistinguishable...'`** (~1637-1660, wire-level): drains
  `bucketLeave` via `drivable(svc).bucketLeave`, sends a real leave over the wire. Line 1643
  (`before`) and line 1657 (the assertion) → `.rateLimited.leave`.
- Lines 1608-1635 (`request` helper, the 14-message maybeAct burst test) and 1662+ (neighbors
  busy-over-wire test) do **not** touch `rejected.rateLimited` arithmetic — skim only, no fix
  expected, but confirm on re-read.

### 2. Add `sumRateLimited` helper — needed by item 1's five-path test and by handler-fuzz below

Put `sumRateLimited(rejected)` in `packages/fret/test/helpers/` (new file, e.g.
`rate-limited.ts`, following the existing one-file-per-concern convention already in that
directory — see `ring.ts`, `wait-for.ts` for style). Signature: takes the `rejected` diagnostics
object (or just its `rateLimited` sub-object — pick whichever reads cleaner at both call sites)
and returns the sum of the five keyed sub-fields (`neighbors + ping + maybeAct + leave +
announce`), explicitly **not** including the sibling `concurrencyLimited`. Import it at both
`rpc.codec-properties.spec.ts`'s five-path test and `rpc.handler-fuzz.spec.ts:1184` (item 3) —
house rule is stay DRY, one helper not two copies of a five-field addition.

### 3. `packages/fret/test/rpc.handler-fuzz.spec.ts:1177-1187` — not yet re-read this pass

Per the prior pass's notes (not independently re-verified this pass, but the tsc error at
1184,24/1184,44 confirms the site still needs fixing): a burst of 12 mixed malformed +
rate-limited messages across protocols; the test cares only about the total rate-limited count,
so line 1184 needs the same `sumRateLimited` helper treatment as item 1's five-path test — sum
over the five keyed sub-fields, not a flat subtraction. Watch for the same shallow-spread hazard
as item 1's 1543/1553 site if this test also snapshots `{ ...rejected }` before draining buckets.

### 4. `packages/fret/test/rpc.handler-fuzz.wire.spec.ts:183` — not yet re-read this pass

Per prior pass's notes: has the same shallow-spread-style capture as item 1's site. Check whether
it reads `rejected.rateLimited` downstream at all (no tsc error here, so if it does read it, it's
either reading a sub-field already correctly, or not exercising the arithmetic path, or is a
silent-failure site like payload-bounds-ttl.spec.ts:365 below). If it doesn't read `rateLimited`
downstream, leave it alone.

### 5. `packages/fret/test/payload-bounds-ttl.spec.ts:365` — not yet re-read this pass, still fully unstarted

`(diag as any).rejected.rateLimited` — the `as any` means tsc flags nothing here, so this fails
silently at runtime (or passes vacuously), not at compile time. Read the whole
`describe('rate limit busy response', ...)` block (~335-450): it drains `bucketMaybeAct` then
calls `handleMaybeAct` → should read `.rateLimited.maybeAct`. Per the prior pass's notes, read the
**whole block**, not just line 365 — key every read in it to the bucket its sub-test actually
drains (a neighbors-bucket sub-test → `.neighbors`, etc. — do not assume every sub-test in this
block drains the same bucket). Drop the `as any` cast while there if the type allows a clean typed
read instead.

### 6. `docs/fret.md` — three sites, unstarted, unchanged from prior passes' notes

- *Leave* section: "The only local signal is `diag.rejected.rateLimited`" → `rateLimited.leave`.
- *Operating profiles*, inflight-cap bullet: "a bucket rejection and an inflight rejection both
  increment `diag.rejected.rateLimited` and differ only in `retry_after_ms`" — **now false**.
  Rewrite: they increment different fields (`rateLimited.maybeAct` vs `concurrencyLimited`),
  which is the whole point of the split.
- *Security and abuse considerations* → *Current state*, rate-limiting bullet: describe the
  per-protocol keyed shape.
- Do not touch the other `rejected.*` fields (`payloadTooLarge`, `timestampBounds`, `ttlExpired`,
  `identityMismatch`, `malformed`) — already unambiguous, out of scope.

## Design constraints (unchanged from prior passes)

- **tsc green is not done** — see items 4/5 above, which tsc cannot see (`as any`, and item 4
  unconfirmed either way). Work the file list, not the tsc error list alone.
- The five-path and 12-message sums want one helper (item 2), not two copies of a five-field
  addition.
- Keying a read to the wrong protocol is a green-but-vacuous test, not a failure — check which
  bucket each sub-test actually drains rather than pattern-matching the field name (this bit a
  prior pass at least once per the original ticket's phrasing).
- No cross-cutting obligations: diagnostics counter with no wire format, no persisted
  representation, no golden fixture, no determinism edition, no migration.

## Verify

`cd packages/fret && npx tsc --noEmit && yarn test` — the whole suite, not the targeted specs
alone, since item 5's `as any` site produces no compile signal and item 4 is unconfirmed by tsc
either way.

## TODO

- Fix the 8 `rpc.codec-properties.spec.ts` sites per the exact map in item 1 above
- Add `sumRateLimited` helper under `test/helpers/` (item 2), use it in item 1's five-path test
- Fix `rpc.handler-fuzz.spec.ts:1184` using the helper (item 3) — re-read the 1177-1187 block
  first, don't blind-edit off the line number alone
- Read and fix (or confirm out-of-scope) `rpc.handler-fuzz.wire.spec.ts:183` (item 4)
- Read and fix `payload-bounds-ttl.spec.ts`'s whole rate-limit-busy-response block, drop the
  `as any` (item 5)
- Update the three `docs/fret.md` sites (item 6)
- Run `npx tsc --noEmit && yarn test` and confirm green
