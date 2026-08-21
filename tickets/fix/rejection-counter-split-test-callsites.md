description: Finish the test/doc call-site sweep left behind by the rejection-counter split; `npx tsc --noEmit` still fails at HEAD with TS2362/TS2363 errors in three spec files, plus docs/fret.md still describes the old flat counter.
prereq: none
files: packages/fret/test/payload-bounds-ttl.spec.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/rpc.handler-fuzz.wire.spec.ts, packages/fret/test/helpers/, docs/fret.md
difficulty: easy
---

## Progress so far (this pass)

`packages/fret/test/profile.behavior.spec.ts` is done and verified via `npx tsc --noEmit`
(both its sites fixed, no more errors reported for this file):

- `:251` (`Concurrent act limits > handleMaybeAct returns BusyResponseV1 when bucketMaybeAct exhausted`) →
  now reads `diag.rejected.rateLimited.maybeAct`.
- `:333`/`:340` (`Diagnostics rejection tracking > rateLimited counter increments on each rate-limited rejection`) →
  the `before`/`after` pair now reads `.rejected.rateLimited.neighbors` (the test only drains
  `bucketNeighbors` and only calls `handleNeighborsRequest`, so it drives one protocol, not a sum).

This pass hit its token budget before reaching the remaining files. Everything below is
unstarted — re-run `cd packages/fret && npx tsc --noEmit` first to get the current authoritative
error list (it will no longer include profile.behavior.spec.ts).

## Root cause (confirmed, not a hypothesis — same as before)

Commit `71be306` ("ticket(implement): rejection-diagnostics-conflated") changed
`FretService.diag.rejected` in `packages/fret/src/service/fret-service.ts` (~line 415) from
`rateLimited: 0` to `rateLimited: { neighbors: 0, ping: 0, maybeAct: 0, leave: 0, announce: 0 }`,
plus a new sibling `concurrencyLimited: 0` (the maybeAct inflight-cap rejection, split out of
`rateLimited`). **The `src/` half is complete and correct — do not re-edit it.** The read sites in
`test/` and `docs/fret.md` were never fully updated.

Ticket `tickets/implement/31-rejection-diagnostics-conflated.md` is the origin of this work and
has been budget-killed multiple times without landing the full test sweep; this ticket (refiled
into `fix/` twice now) is the same sweep, not an independent defect.

## Already landed (do NOT redo)

- `packages/fret/test/announce-rate-limit.spec.ts` — lines 87, 94, 107, 113 read
  `rejected.rateLimited.announce`.
- `packages/fret/test/inflight-concurrency.spec.ts` — reads `rejected.concurrencyLimited`
  (local renamed `concurrencyLimitedBefore`); file-header note rewritten.
- `packages/fret/test/profile.behavior.spec.ts` — both sites, this pass (see above).

## Remaining sites (unstarted)

1. `packages/fret/test/payload-bounds-ttl.spec.ts:365` — `(diag as any).rejected.rateLimited`;
   drains `bucketMaybeAct` then calls `handleMaybeAct` → `.rateLimited.maybeAct`. The `as any`
   means tsc flags nothing here, so this one fails silently at runtime — read the whole
   `describe('rate limit busy response', ...)` block (~335-450) and key every read in it to the
   bucket its sub-test drains (neighbors bucket test → `.neighbors`, etc.). Drop the `as any`
   while there if the type allows.
2. `packages/fret/test/rpc.codec-properties.spec.ts` — largest surface. Read ~1340-1660 in one
   pass. Sites: 1357, 1363, 1370, 1376, 1383, 1389, 1398, 1405, 1420, 1426, 1429 (comment), 1442,
   1451, 1460, 1473, 1543 (`{ ...rejected }` spread feeding the failing 1553), 1643, 1657.
   Most are per-protocol `before`/delta pairs. Two exceptions:
   - the block at ~1429-1451 sums **five** rejection paths ("five paths, five increments") — it
     must sum the five *keyed* sub-fields of `rateLimited`, and **not** `concurrencyLimited`,
     which is a sibling outside `rateLimited` and not one of the five. Its comment at 1429
     ("one more contributor than the five buckets") describes the pre-split shape and is now
     false — reword it.
   - `:1543`/`:1553` — shallow `{ ...rejected }` spread; `before.rateLimited` is the *same object
     reference* as the live counter, so a delta against it reads 0 even once keyed. Snapshot the
     five sub-fields by value (or sum at capture time), do not merely append `.foo`.
3. `packages/fret/test/rpc.handler-fuzz.spec.ts:1177-1187` — sum-across-protocols site (a burst of
   12 mixed malformed + rate-limited messages; it cares only about the total). Same shallow-spread
   hazard as 2. Fix `:1184` with a sum over the five keyed sub-fields.
   `test/rpc.handler-fuzz.wire.spec.ts:183` has the same spread — check whether it reads
   `rateLimited` downstream; if not, leave it.
4. `docs/fret.md` — three sites naming the old flat counter:
   - *Leave* section: "The only local signal is `diag.rejected.rateLimited`" → `rateLimited.leave`.
   - *Operating profiles*, inflight-cap bullet: "a bucket rejection and an inflight rejection both
     increment `diag.rejected.rateLimited` and differ only in `retry_after_ms`" — **now false**.
     Rewrite: they increment different fields (`rateLimited.maybeAct` vs `concurrencyLimited`),
     which is the whole point of the split.
   - *Security and abuse considerations* → *Current state*, rate-limiting bullet: describe the
     per-protocol keyed shape.
   Do not touch the other `rejected.*` fields (`payloadTooLarge`, `timestampBounds`, `ttlExpired`,
   `identityMismatch`, `malformed`) — already unambiguous, out of scope.

## Design constraints

- **tsc green is not done.** Chai's `expect` is untyped, so a read of the object compared against
  a number throws no compile error and either fails at runtime or passes vacuously. Site 1's
  `as any` cast is exactly this class. Work the file list, not the tsc error list alone.
- **The five-path and 12-message sums want one helper, not two copies of a five-field addition.**
  Put `sumRateLimited(rejected)` in `packages/fret/test/helpers/` and import it at both sites 2
  and 3 (house rule: stay DRY). It must sum only the five `rateLimited` sub-fields.
- Keying a read to the wrong protocol is a green-but-vacuous test, not a failure — check which
  bucket each sub-test actually drains rather than pattern-matching the field name.
- No cross-cutting obligations: this is a diagnostics counter with no wire format, no persisted
  representation, no golden fixture and no determinism edition. `SerializedTable` does not carry
  `diag`, so there is no migration.

## Verify

`cd packages/fret && npx tsc --noEmit && yarn test` — the whole suite, not the targeted specs
alone, since the silent site (payload-bounds-ttl.spec.ts's `as any`) produces no compile signal.

## TODO

- Fix `payload-bounds-ttl.spec.ts:365` and its surrounding rate-limit-busy-response block
- Add `sumRateLimited` helper under `test/helpers/`
- Fix `rpc.codec-properties.spec.ts` sites (list above), including the five-path sum and the
  shallow-spread snapshot bug at 1543/1553
- Fix `rpc.handler-fuzz.spec.ts:1184` using the helper; check `rpc.handler-fuzz.wire.spec.ts:183`
- Update the three `docs/fret.md` sites
- Run `npx tsc --noEmit && yarn test` and confirm green
