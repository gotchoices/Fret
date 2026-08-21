description: Fix stops a peer from sending a bogus "confidence" number outside 0-100% (or a negative/garbage "size_estimate") on the wire and having it corrupt this node's network-size estimate. Code change is done and the full test suite is green — needs an adversarial review pass before archiving.
files: packages/fret/src/rpc/validate.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.codec-properties.spec.ts
difficulty: easy
---

## What changed

- `packages/fret/src/rpc/validate.ts`: added `finiteNumberInRangeOr`, used in `makeSnapshotParser`
  (`size_estimate` range `[0, Infinity]`, `confidence` range `[0, 1]`) and in `parsePingResponse`
  (same two fields, same ranges). An out-of-range or non-finite value is dropped **individually**
  — the field falls back to absent — the rest of the message (successors, predecessors, sample,
  etc.) still parses and merges normally. This matches the existing wire-shape-parser house style
  (see `docs/fret.md` § Wire-shape parsers): truncate/drop-and-log, never reject the whole message
  for one bad field.
- `packages/fret/src/service/fret-service.ts`: `calibrateSizeFromSnapshot` now gates on
  `snap.size_estimate > 0 && snap.confidence > 0` before calling `reportNetworkSize` — so even a
  boundary-legal `0` (which the parser accepts, since `size_estimate`'s floor is inclusive) is
  still kept out of the size estimator, which treats 0 as "no information" rather than "a peer at
  size zero".
- `packages/fret/test/rpc.codec-properties.spec.ts`: two new hand-written boundary tests (see
  below), plus a generator fix so the file's own round-trip properties stay correct against the
  new range check (see "Generator fix" below).

## Why

A malicious or buggy peer could put `confidence: 5.0` or `size_estimate: -100` in a
`NeighborSnapshotV1` or a ping reply. Before this fix, `calibrateSizeFromSnapshot` fed that
straight into `SizeObserver.report`, which only rejects non-finite input — a `confidence` of 5.0
would then dominate every future blended estimate (`getNetworkSizeEstimate` weights by
recency × confidence, uncapped), letting one peer make the whole node believe an absurd network
size with total certainty.

## Test coverage added

- `'drops out-of-range confidence/size_estimate independently, keeps in-range boundaries'`
  (snapshot parser) — asserts negative `size_estimate`, `confidence` > 1 or < 0 are dropped
  field-by-field while `size_estimate: 0` and `confidence: 0`/`1` (the legal boundaries) survive,
  and the rest of the snapshot still parses.
- `'parsePingResponse drops out-of-range confidence/size_estimate, keeps in-range boundaries'`
  — same shape, for the ping-response parser.

Both were passing before this run and re-confirmed passing this run.

## Generator fix (this run)

`arbLegalSnapshot` / `arbLegalPingResponse` (the fast-check arbitraries backing the
`'never reject what our own encoder produced'` round-trip properties) generated `size_estimate`
via unconstrained `arbJsonNumber`, which can produce negatives. Once the parser correctly floors
`size_estimate` at 0, a generated negative value made the round-trip property fail — the
generator was wrong, not the production code (this node's own estimator never emits a negative
`size_estimate`). Fixed by adding `arbNonNegativeJsonNumber` (same shape as `arbJsonNumber`,
floored at 0, `-0`-filtered) and switching both arbitraries' `size_estimate` field to it. Verified
this run: `'never reject what our own encoder produced'` now passes for both `NeighborSnapshot`
and `PingResponse, projected to what sendPing returns`.

## Verification this run

- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/rpc.codec-properties.spec.ts" --timeout 30000` — 110 passing, 0 failing.
- `cd packages/fret && yarn test` (full suite) — 1193 passing, 0 failing.

## Known gaps — flagged honestly, not fixed here

- **No dedicated `fast-check` property for range accept/reject on the boundary logic itself.**
  The two hand-written boundary tests above were judged sufficient for this easy ticket — they
  cover both fields, both directions (in-range survives, out-of-range drops), and the inclusive-0
  boundary specifically. A property test generating arbitrary in/out-of-range floats around the
  `[0,1]` and `[0,Infinity]` boundaries would give broader coverage of `finiteNumberInRangeOr`
  itself; deliberately not built here. Reviewer's call whether this warrants a small follow-up.
- **`packages/fret/test/size-observer.spec.ts` gap**: no test asserts a `size_estimate: 0`
  snapshot is dropped rather than double-counted at the `SizeObserver` layer, i.e. no test
  exercises `calibrateSizeFromSnapshot`'s `> 0` gate directly. `calibrateSizeFromSnapshot` is a
  private `FretService` method with no unit seam — testing it needs a service-level integration
  test (spin up a service, feed it a snapshot, inspect `getNetworkSizeEstimate()` before/after).
  Judged out of scope for this ticket by a prior run; not attempted here either. If judged worth
  it, this is a small `debt-` ticket (add one integration test in `size-observer.spec.ts` or a new
  `fret-service.calibrate.spec.ts`), not a code change.

## Use cases for validation

- Peer sends snapshot/ping-reply with `confidence` outside `[0,1]` (e.g. `5`, `-1`, `NaN`,
  `Infinity`) → that field drops to absent, rest of message still merges. See boundary tests above.
- Peer sends `size_estimate` negative or non-finite → drops to absent; `size_estimate: 0` is legal
  and passed through by the parser but then filtered by `calibrateSizeFromSnapshot`'s `> 0` gate
  before it ever reaches `reportNetworkSize`.
- This node's own encoder's legal output (any value actually producible by this codebase) must
  never be rejected by the tightened parser — pinned by the (now-fixed) round-trip properties.
