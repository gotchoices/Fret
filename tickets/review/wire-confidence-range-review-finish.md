description: Finish the adversarial review of the fix that stops a peer sending a bogus confidence or size number on the wire. The code reading was done; running the tests and applying two small corrections was not.
files: packages/fret/src/rpc/validate.ts, packages/fret/src/service/size-observer.ts, packages/fret/test/size-observer.spec.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: easy
---

## Why this ticket exists

A prior review run read the whole implement-stage diff and reached conclusions (below), then hit
the run's token budget before it could run lint/tests or apply anything. Nothing was changed in
the working tree by that run — the tree is exactly as the implement stage left it. This ticket
carries the finished reading forward so the next run does not repeat it.

## What the implement stage actually changed (verified against the diff, `93add3d..HEAD`)

- `src/rpc/validate.ts` only: `finiteNumberOr` → `finiteNumberInRangeOr(value, min, max, fallback)`,
  applied to `size_estimate` (`[0, Infinity]`) and `confidence` (`[0, 1]`) in both
  `makeSnapshotParser` and `parsePingResponse`.
- `test/rpc.codec-properties.spec.ts`: two boundary tests, plus a new `arbNonNegativeJsonNumber`
  arbitrary used for `size_estimate` in the two legal-message generators.

## Findings from the completed reading

**Confirmed correct.** The range check is sound. `isFiniteNumber` runs first, so `Infinity` and
`NaN` are already excluded and the `Infinity` upper bound is only a "no ceiling" spelling.
`-0` passes the `[0, …]` range and is then dropped downstream by the `> 0` gate, and the JSON
codec turns `-0` into `0` on the wire anyway. Fields drop independently; no message is rejected
for one bad field, which matches the house style. The generator fix is correct and necessary:
the round-trip property would otherwise generate a negative `size_estimate` the tightened parser
correctly refuses.

**Two corrections to make in this run:**

- **The handoff ticket claims a `src/service/fret-service.ts` change that does not exist in the
  diff.** `calibrateSizeFromSnapshot`'s `snap.size_estimate > 0 && snap.confidence > 0` gate is
  pre-existing (it predates this ticket). No production file other than `validate.ts` was touched.
  The `complete/` write-up must say so rather than repeating the handoff's claim.
- **The stated impact of the ping-reply half is overstated.** Nothing in the service reads
  `size_estimate` / `confidence` off a ping reply — `sendPing`'s three call sites use only
  liveness and latency, and `reportNetworkSize` is reached only from the snapshot path. So the
  ping-parser tightening is defense in depth for a path that does not exist yet, not a live fix.
  Worth stating plainly in the completion write-up.

**One real gap, and where it belongs.** `SizeObserver.report` is documented as "the boundary now",
and it refuses non-finite input — but it accepts any finite `confidence`, including `5` or `-1`.
`FretService.reportNetworkSize` is public API and passes straight through, so the exact corruption
this ticket set out to prevent is still reachable from a local caller (an application layer, or any
future wire path feeding the estimator). The parser fix closes today's two wire paths one at a
time; refusing an out-of-range `confidence` at `SizeObserver.report` closes the class at the point
that already claims to be the boundary. That is the fix to apply here — a range refusal beside the
existing non-finite refusal, plus a test in `size-observer.spec.ts`.

Deliberately **not** in scope: refusing a negative `estimate`. `size-observer.spec.ts` has a test
(`'accepts a negative estimate — the > 0 gate lives at the caller, not here'`) asserting today's
behavior as a stated decision. Leave it; only `confidence` is this ticket's class.

**Checked and clear.** `parseNearAnchor` range-checks nothing beyond finiteness, but
`fret-service.ts` carries a `NOTE:` saying no consumer reads `estimated_cluster_size` /
`confidence` off a NearAnchor, and a grep confirms it. No finding.

## TODO

- Apply the `SizeObserver.report` confidence range refusal, with a unit test beside the existing
  non-finite one.
- Consider whether `finiteNumberInRangeOr` deserves a `fast-check` property over the boundary
  (the implement handoff flagged its absence honestly and left it as the reviewer's call). Cheap
  to add given the existing arbitraries; skip if it duplicates the hand-written boundary tests.
- Check whether `docs/fret.md` (§ Wire-shape parsers table, and § Network size estimation) needs a
  line about the new range rule — the parser table describes each parser's rejects/normalizes and
  currently does not mention the range check.
- Run `npx tsc --noEmit` and the full `yarn test` from `packages/fret/` and confirm green. There
  is no lint step in this repo (`yarn check` = typecheck + build + test); do not run `yarn format`.
- Write `tickets/complete/wire-confidence-range-unchecked.md` with a `## Review findings` section
  carrying the findings above plus whatever this run adds, and delete this ticket.
