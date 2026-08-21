description: Finish the test/doc call-site sweep left behind by the rejection-counter split; `npx tsc --noEmit` fails at HEAD with 26 TS2362/TS2363 errors and two runtime assertion failures.
prereq: none
files: packages/fret/test/profile.behavior.spec.ts, packages/fret/test/payload-bounds-ttl.spec.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, docs/fret.md
difficulty: easy
---

## Failing test

`cd packages/fret && npx tsc --noEmit` — 26 errors, all `TS2362`/`TS2363`:

```
The left-hand side of an arithmetic operation must be of type 'any', 'number', 'bigint' or an enum type.
```

at `expect(after - before)`-style subtractions of `getDiagnostics().rejected.rateLimited` reads.
Also two runtime failures in `test/profile.behavior.spec.ts`:

- `Concurrent act limits > handleMaybeAct returns BusyResponseV1 when bucketMaybeAct exhausted`
  (~line 251): `AssertionError: expected [object Object] to be a number or a date`
- `Diagnostics rejection tracking > rateLimited counter increments on each rate-limited rejection`
  (~line 341): `AssertionError: expected NaN to equal 3`

## Root cause (confirmed, not a hypothesis)

Commit `71be306` ("ticket(implement): rejection-diagnostics-conflated") changed
`FretService.diag.rejected` in `packages/fret/src/service/fret-service.ts` (~line 415) from

```ts
rateLimited: 0,
```

to

```ts
rateLimited: { neighbors: 0, ping: 0, maybeAct: 0, leave: 0, announce: 0 },
...
concurrencyLimited: 0,   // new sibling: maybeAct inflight-cap rejection, split out of rateLimited
```

The six `this.diag.rejected.rateLimited++` write sites were converted to the keyed form and the
inflight-cap rejection moved to `concurrencyLimited`. **The `src/` half is complete and correct —
do not re-edit it.** The *read* sites in `test/` and `docs/fret.md` were never updated, so every
`rejected.rateLimited` read now yields an object: arithmetic on it is a tsc error where the
compiler can see it, and a silent `NaN` / `[object Object]` in Chai assertions where it cannot.

Ticket `tickets/implement/31-rejection-diagnostics-conflated.md` is the origin of this work and
has been budget-killed five times without landing the test sweep. This ticket is the same sweep
refiled into `fix/` so the pipeline takes it next; it is **not** an independent defect. Whoever
lands this should reconcile ticket 31 (its remaining steps 6-9 are exactly this ticket's scope).

## Already landed by the triage pass (do NOT redo)

- `packages/fret/test/announce-rate-limit.spec.ts` — lines 87, 94, 107, 113 now read
  `rejected.rateLimited.announce` (both tests drive `handleAnnounce`).
- `packages/fret/test/inflight-concurrency.spec.ts` — the `before`/delta pair (~166, ~198) now
  reads `rejected.concurrencyLimited` (local renamed to `concurrencyLimitedBefore`), and the
  file-header note at ~line 25 was rewritten: the two busy kinds are no longer indistinguishable,
  so fan-out sizing is load-bearing only for the *reply* counts, not for the diagnostic assertion.

## Remaining sites

Exhaustive — verified by `grep -rn "rejected\.rateLimited\|rejected\.concurrencyLimited\|rejected }" test/`
plus the tsc error list. Key each read to the protocol whose handler that sub-test drives. Do
**not** map an inflight-cap assertion onto `rateLimited.maybeAct` — that silently re-merges the
two counters the split exists to separate.

1. `packages/fret/test/profile.behavior.spec.ts`
   - `:251` — `expect(diag.rejected.rateLimited).to.be.greaterThan(0)`; test drains
     `bucketMaybeAct` then calls `handleMaybeAct`, so → `.rateLimited.maybeAct`.
   - `:333` / `:340` — `before`/`after` pair in "Diagnostics rejection tracking"; read the
     surrounding block to see which handler(s) it drives before keying (if it drives several,
     sum — see the helper below).
2. `packages/fret/test/payload-bounds-ttl.spec.ts:365` — `(diag as any).rejected.rateLimited`;
   drains `bucketMaybeAct` then calls `handleMaybeAct` → `.rateLimited.maybeAct`. The `as any`
   means tsc flags nothing here, so this one fails silently — read the whole
   `describe('rate limit busy response', ...)` block (~335-450) and key every read in it to the
   bucket its sub-test drains (neighbors bucket test → `.neighbors`, etc.). Drop the `as any`
   while there if the type allows.
3. `packages/fret/test/rpc.codec-properties.spec.ts` — largest surface. Read ~1340-1660 in one
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
4. `packages/fret/test/rpc.handler-fuzz.spec.ts:1177-1187` — sum-across-protocols site (a burst of
   12 mixed malformed + rate-limited messages; it cares only about the total). Same shallow-spread
   hazard as 3. Fix `:1184` with a sum over the five keyed sub-fields.
   `test/rpc.handler-fuzz.wire.spec.ts:183` has the same spread — check whether it reads
   `rateLimited` downstream; if not, leave it.
5. `docs/fret.md` — three sites naming the old flat counter:
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
  a number throws no compile error and either fails at runtime or passes vacuously. Site 2 and the
  `as any` cast are exactly this class. Work the file list, not the tsc error list.
- **The five-path and 12-message sums want one helper, not two copies of a five-field addition.**
  Put `sumRateLimited(rejected)` in `packages/fret/test/helpers/` and import it at both sites
  (house rule: stay DRY). It must sum only the five `rateLimited` sub-fields.
- Keying a read to the wrong protocol is a green-but-vacuous test, not a failure — check which
  bucket each sub-test actually drains rather than pattern-matching the field name.
- No cross-cutting obligations: this is a diagnostics counter with no wire format, no persisted
  representation, no golden fixture and no determinism edition. `SerializedTable` does not carry
  `diag`, so there is no migration.

## Verify

`cd packages/fret && npx tsc --noEmit && yarn test` — the whole suite, not the targeted specs
alone, since the silent sites produce no compile signal.
