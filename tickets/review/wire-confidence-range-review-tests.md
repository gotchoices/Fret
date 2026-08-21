description: Last step of the review of the fix that stops a peer sending a bogus confidence or size number on the wire. Everything is written; the test run and the closing write-up are all that is left.
files: packages/fret/src/service/size-observer.ts, packages/fret/test/size-observer.spec.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/src/rpc/validate.ts, docs/fret.md
difficulty: easy
---

## Why this ticket exists

Third continuation of the review of `wire-confidence-range-unchecked`. The previous continuation
(`wire-confidence-range-review-validate`) had three TODOs: update the docs, run the tests, write
the `complete/` ticket. **The docs update is done** (this run). The run crossed its token budget
before the test run, so that and the write-up carry forward here.

**Nothing here is speculative.** All code and documentation edits are applied. What remains is
running the suite and writing the completion ticket.

## What is applied and already committed

- `src/rpc/validate.ts` (implement stage, commit `224c001` and neighbours) — `finiteNumberOr` →
  `finiteNumberInRangeOr(value, min, max, fallback)`, applied to `size_estimate` (`[0, Infinity]`)
  and `confidence` (`[0, 1]`) in both `makeSnapshotParser` and `parsePingResponse`. Re-read this
  run at `validate.ts:52-58`, `:255-263`, `:360-368` and confirmed sound.
- `src/service/size-observer.ts` (commit `2f7074a`) — `report` refuses a `confidence` outside
  `[0, 1]` beside the existing non-finite refusal, with a comment stating why.
- `test/size-observer.spec.ts` (commit `2f7074a`) — two tests: out-of-range confidences are not
  stored while the inclusive boundaries 0 and 1 are; a crafted high-confidence report cannot
  outvote an honest one in the blend.
- `test/rpc.codec-properties.spec.ts` (commit `2f7074a`) — a `fast-check` property over arbitrary
  finite doubles generalizing the range rule for both fields on the snapshot parser.

## What this run did

**Updated `docs/fret.md`** — all three stale places, now read rather than assumed:

- *Wire-shape parsers* table, `makeSnapshotParser(caps)` row: the two advisory numerics are now
  documented as dropped when **out of range** as well as when the wrong type, naming the bounds.
- Same table, `parsePingResponse` row: same addition, pointing at the same bounds.
- *Network size estimation*, the `SizeObserver` bullet: `report`'s refusal now also covers an
  out-of-range `confidence`, with the reason stated (it is a blend *weight*, so an out-of-range
  value re-scales every other observation) and the deliberate non-refusal of a negative
  `estimate` recorded alongside, naming `calibrateSizeFromSnapshot` as where that gate lives.

No other `docs/` file mentions these parsers or `SizeObserver`.

## Findings already established (carry into the `complete/` write-up verbatim)

**Confirmed correct.** The parser range check is sound. `isFiniteNumber` runs first, so `Infinity`
and `NaN` are already excluded and the `Infinity` upper bound on `size_estimate` is only a "no
ceiling" spelling. `-0` passes the `[0, …]` range and is dropped downstream by the `> 0` gate; the
JSON codec turns `-0` into `0` on the wire anyway. Fields drop independently — no message is
rejected for one bad field — which matches the house style for advisory fields. The test
generator change is correct and necessary: the round-trip property would otherwise generate a
negative `size_estimate` that the tightened parser correctly refuses.

**Two claims in the implement handoff are wrong and must not be repeated.**
- It claims a `src/service/fret-service.ts` change. There is none. `calibrateSizeFromSnapshot`'s
  `snap.size_estimate > 0 && snap.confidence > 0` gate predates this ticket. `git diff
  93add3d..HEAD --stat` shows `src/rpc/validate.ts` as the *only* production file the implement
  stage touched.
- It overstates the impact of the ping-reply half. Nothing in the service reads `size_estimate` /
  `confidence` off a ping reply: `sendPing`'s three call sites use only liveness and latency, and
  `reportNetworkSize` is reached only from the snapshot path. The ping-parser tightening is
  defense in depth for a path that does not exist yet, not a live fix.

**The one real gap, and why it was fixed rather than filed.** `SizeObserver.report` was documented
as "the boundary now" and refused non-finite input, but accepted any finite `confidence`.
`FretService.reportNetworkSize` is public API and passes straight through, so the exact corruption
this ticket set out to prevent stayed reachable from a local caller. The parser fix closes today's
two wire paths one at a time; the refusal at `report` closes the class at the point that already
claims to be the boundary — the *invariant* rung of the architecture ladder, not a point fix.

**Checked and clear.** `parseNearAnchor` range-checks nothing beyond finiteness, but
`fret-service.ts` carries a `NOTE:` saying no consumer reads `estimated_cluster_size` /
`confidence` off a NearAnchor, and a grep confirms it. No finding.

**One thing looked at this run and left alone, deliberately.** `SizeObserver.blend(local)` applies
no range check to the `LocalSizeEstimate` it is handed, even though `local.confidence` is a blend
weight exactly like a reported one. It is not reachable today: every one of the four call sites
feeds it `estimateSizeAndConfidence`, which returns a clamped confidence, and `blend` is not on the
public `FretService` surface (`getNetworkSizeEstimate` is the only caller and it builds `local`
itself). Not filed as a ticket and not fixed — see the TODO below for how to record it.

## TODO

- Record the `blend(local)` observation as a **tripwire**, not a ticket: it is conditional ("fine
  now; only matters if `blend` ever becomes reachable with a caller-supplied `local`"). A one-line
  `NOTE:` at `blend` in `src/service/size-observer.ts` naming the condition — that every current
  caller passes a clamped `estimateSizeAndConfidence` result — is the right home. Then one line in
  the `complete/` ticket's `## Review findings` saying it was noticed and where it was parked.
- Run `npx tsc --noEmit` and the full `yarn test` from `packages/fret/`, **in the foreground with
  no redirection**, and confirm green. There is no lint step in this repo (`yarn check` =
  typecheck + build + test); **do not run `yarn format`** (see AGENTS.md). If a failure looks
  pre-existing, follow the `.pre-existing-error.md` procedure rather than chasing it.
- Write `tickets/complete/wire-confidence-range-unchecked.md` with a `## Review findings` section
  carrying everything above plus the test outcome and the docs outcome, and delete this ticket.
