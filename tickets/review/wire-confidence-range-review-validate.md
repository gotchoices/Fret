description: Finish the review of the fix that stops a peer sending a bogus confidence or size number on the wire. The code changes are all applied; the documentation update, the test run, and the write-up are not.
files: packages/fret/src/service/size-observer.ts, packages/fret/test/size-observer.spec.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/src/rpc/validate.ts, docs/fret.md
difficulty: easy
---

## Why this ticket exists

Second continuation of the review of `wire-confidence-range-unchecked`. The first continuation
(`wire-confidence-range-review-finish`) carried a completed code reading forward and was asked to
apply two corrections, check the docs, run the tests, and write the `complete/` ticket. It applied
**both code changes** and then crossed the run's token budget before the docs check, the test run,
or the write-up. This ticket carries all of that forward so nothing is re-derived.

**Nothing here is speculative — the edits are in the working tree already.** What remains is
validation and documentation, not design.

## What is already applied (in the working tree, uncommitted)

- `src/service/size-observer.ts` — `report` now refuses a `confidence` outside `[0, 1]`, beside
  the existing non-finite refusal, with a comment stating why (`confidence` is a *weight* in
  `blend`, so an out-of-range value re-scales every other observation's contribution; a negative
  one can cancel `totalWeight` to zero or invert the blend). Deliberately **not** applied: a
  refusal for a negative `estimate` — `size-observer.spec.ts` has a test asserting today's
  behavior as a stated decision, and only `confidence` is this ticket's class.
- `test/size-observer.spec.ts` — two tests beside the existing non-finite one: out-of-range
  confidences are not stored while the inclusive boundaries 0 and 1 are, and a crafted
  high-confidence report cannot outvote an honest one in the blend.
- `test/rpc.codec-properties.spec.ts` — a `fast-check` property over arbitrary finite doubles
  generalizing the range rule for both `confidence` and `size_estimate` on the snapshot parser
  (in-range preserved exactly, out-of-range drops that field alone, neither ever rejects the
  message). This was the implement stage's honestly-flagged open question, resolved as "add it":
  the hand-written boundary tests pin two sampled points, the property pins the rule.

## Findings already established (carry these into the `complete/` write-up verbatim)

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
  93add3d..HEAD --stat` shows `src/rpc/validate.ts` as the *only* production file touched by the
  implement stage.
- It overstates the impact of the ping-reply half. Nothing in the service reads `size_estimate` /
  `confidence` off a ping reply: `sendPing`'s three call sites use only liveness and latency, and
  `reportNetworkSize` is reached only from the snapshot path. The ping-parser tightening is
  defense in depth for a path that does not exist yet, not a live fix.

**The one real gap, and why it was fixed here rather than filed.** `SizeObserver.report` is
documented as "the boundary now" and refused non-finite input, but accepted any finite
`confidence`. `FretService.reportNetworkSize` is public API and passes straight through, so the
exact corruption this ticket set out to prevent stayed reachable from a local caller. The parser
fix closes today's two wire paths one at a time; the refusal at `report` closes the class at the
point that already claims to be the boundary — the *invariant* rung of the architecture ladder,
not a point fix.

**Checked and clear.** `parseNearAnchor` range-checks nothing beyond finiteness, but
`fret-service.ts` carries a `NOTE:` saying no consumer reads `estimated_cluster_size` /
`confidence` off a NearAnchor, and a grep confirms it. No finding.

## TODO

- Check whether `docs/fret.md` needs updating. Two sections are candidates and both were
  identified but never read: the *Wire-shape parsers* table (which describes each parser's
  rejects/normalizes and currently says nothing about a range check on `makeSnapshotParser` or
  `parsePingResponse`), and *Network size estimation* (whose `SizeObserver` bullet says `report`
  "refuses a non-finite estimate or confidence outright" — now also an out-of-range confidence).
  Treat both as out of date until read.
- Run `npx tsc --noEmit` and the full `yarn test` from `packages/fret/`, in the foreground with no
  redirection, and confirm green. There is no lint step in this repo (`yarn check` = typecheck +
  build + test); **do not run `yarn format`** (see AGENTS.md).
- Write `tickets/complete/wire-confidence-range-unchecked.md` with a `## Review findings` section
  carrying everything above plus the test/docs outcome, and delete this ticket.
