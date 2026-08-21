description: Confirmed the first group of test files reads the new per-protocol rejection counters correctly, after the diagnostics counter split.
files: packages/fret/test/inflight-concurrency.spec.ts, packages/fret/test/profile.behavior.spec.ts, packages/fret/test/announce-rate-limit.spec.ts, packages/fret/test/payload-bounds-ttl.spec.ts
---

**Split 1 of 3** of the rejection-diagnostics counter work. The source change (already landed
before this split) turned `diag.rejected.rateLimited` from a flat number into
`{neighbors, ping, maybeAct, leave, announce}`, and added the sibling
`diag.rejected.concurrencyLimited` for the maybeAct inflight-cap rejection, which was previously
conflated with the maybeAct token-bucket rejection.

This ticket's scope was the first group of four test files. Both the implement and review passes
found them **already carrying the keyed reads** — the implement commit (`2a71574`) touches no
code at all, only the ticket file. So both passes were verification, not edits.

## Review findings

### What was checked
- Read the implement-stage diff (`git show 2a71574`) first: it is a ticket move only, zero code
  or test lines. So the review target is the *claim* — that the four files are already correct —
  not a set of edits.
- Read the live counter shape at `src/service/fret-service.ts:415-424`:
  `rateLimited: { neighbors, ping, maybeAct, leave, announce }` with `concurrencyLimited` as a
  sibling field of `rejected`. Confirmed the write sites match the field names
  (`fret-service.ts:1293, 1301, 1384, 1424, 1841, 2002`).
- Grepped every `rateLimited` / `concurrencyLimited` read across all of `src/` and `test/`, not
  only the four listed files, so a stale flat-number read anywhere would have surfaced.
- Read each of the four assertion sites in full context rather than trusting the grep line.
- Gate: `npx tsc --noEmit` clean; the four specs run together — **68 passing, 0 failing, 13s**.

### What was found
- **No defects in the four target files.** Each reads the keyed shape and each is attributable to
  the counter it claims: `inflight-concurrency.spec.ts:168,201` reads
  `rejected.concurrencyLimited` (the cap), not `rateLimited.maybeAct` (the bucket) — which is the
  whole point of the split, since these two rejections were previously indistinguishable except
  by their `retry_after_ms` sentinel. `profile.behavior.spec.ts:251,333,340` reads
  `rateLimited.maybeAct` and `rateLimited.neighbors`; `announce-rate-limit.spec.ts:87,94,107,113`
  reads `rateLimited.announce` at all four sites; `payload-bounds-ttl.spec.ts:365` reads
  `rateLimited.maybeAct`.
- **Weaker assertion style at two sites, deliberately left alone.**
  `profile.behavior.spec.ts:251` and `payload-bounds-ttl.spec.ts:365` assert on the *absolute*
  counter (`greaterThan(0)`) where the other sites assert a before/after delta. Considered and
  not changed: each of those tests builds a fresh service, nothing else in the test sends a
  maybeAct message, so the counter provably starts at 0 and `> 0` already pins "a maybeAct bucket
  rejection happened". Tightening to a delta would change no outcome. Not filed as a ticket —
  there is no defect to fix, only a style difference.
- **Aliasing hazard in `getDiagnostics`, pre-existing and already documented in the tests.**
  `FretService.getDiagnostics` (`src/service/fret-service.ts:508`) returns `this.diag` directly —
  the `Readonly<>` return type is compile-time only, so every caller holds a live, mutating
  object. Before the split this bit nobody at the `rateLimited` field, because a number is copied
  by value on read; now that it is an object, a caller who spreads the diagnostics shallowly
  keeps a *live* `rateLimited` reference and its "before" snapshot moves under it. This is
  genuinely load-bearing for anyone writing a before/after diagnostics assertion.
  **Parked, not filed:** the two test sites that actually take a shallow spread already carry an
  explaining comment at the exact point of use
  (`test/rpc.codec-properties.spec.ts:1544`, `test/rpc.handler-fuzz.spec.ts:1183`), which is
  where a future reader meets the hazard. Both are outside this ticket's four files.
- **Both sibling implement tickets look stale.** `test/rpc.codec-properties.spec.ts` already
  reads the keyed shape at every site (17 sites, the scope of
  `31.5-rejection-diagnostics-codec-properties`), and `docs/fret.md` already describes the split
  counters in the operating-profiles and security sections (the scope of
  `31.7-rejection-diagnostics-docs-gate`). Reported, **not acted on** — those tickets belong to
  their own stage and are not this review's to edit or delete. Their own runs should re-verify
  rather than assume, and `31.7` still owns the full-suite gate, which this ticket did not run.

### Categories with nothing in them
- **Minor findings fixed inline: none.** Nothing in the four files was wrong; there was no edit
  to make. This is not "looks good" — the specific claim checked was that each assertion reads
  the keyed field matching the rejection path it drives, and all nine reads do.
- **Major findings / new tickets: none.** The one real hazard found (`getDiagnostics` aliasing)
  is pre-existing, outside the diff, and already annotated at both sites that touch it, so it
  fails the "climb to the highest rung" test in both directions — there is no invariant to add
  and no instance left undocumented.
- **Tripwires recorded this pass: none new.** The aliasing note above was already parked in code
  by earlier work; this findings entry is the index pointing at it, not a new parking.

### Gate
- `npx tsc --noEmit` (from `packages/fret/`): clean.
- `inflight-concurrency` + `profile.behavior` + `announce-rate-limit` + `payload-bounds-ttl`:
  68 passing, 0 failing.
- Full suite (`yarn test`) deliberately not run — it belongs to `31.7`, per the original split.
- No pre-existing failures encountered, so `tickets/.pre-existing-error.md` was not written.
