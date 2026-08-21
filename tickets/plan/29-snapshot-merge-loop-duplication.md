description: Two places in the service do the identical job of taking a neighbour list a peer sent us and storing it, and the two copies have already started drifting apart from each other.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/announce-rate-limit.spec.ts
difficulty: easy
tradeoffs: The two copies are only ~20 lines each and work correctly today, so a maintainer may reasonably judge the extraction not worth touching a 2960-line file for until one of them actually needs to change — and the two strongest arguments this ticket was originally filed on have since been met by other work (see "What has changed since this was filed").

A peer's neighbour snapshot reaches us two ways: it is pushed to us (an announce), or we ask for
it (a neighbour fetch). Both then do exactly the same thing with the contents — cut each list down
to the size limit this node accepts, then for each id work out its ring position and put it in the
routing table, remembering which ids were new so they can be told about.

That "same thing" is written out twice.

## The two sites

`packages/fret/src/service/fret-service.ts`:

- `mergeAnnounceSnapshot` — the successor/predecessor loop and the sample loop, just after
  `const caps = this.mergeSnapshotCaps()` (around line 1797).
- `fetchAndMergeSnapshot` — the same two loops, just after its own
  `const caps = this.mergeSnapshotCaps()` (around line 2297).

Line for line the two are the same: the same `hashPeerId(peerIdFromString(pid))`, the same
`getById` → push-if-new → `upsert` → `applyTouch`, the same per-entry `try`/`catch` so one bad id
drops itself rather than the message.

## What has changed since this was filed

Two later tickets landed on this ground, and between them they retired the two arguments this
ticket leaned on hardest. Read this section before estimating the work — the remaining case is
real but noticeably smaller than the body below implies.

- **The size limits are no longer applied in the loops at all.** `rpc-snapshot-cap-announce-path-test`
  moved the cut into a single message parser, which both paths build from the one
  `mergeSnapshotCaps()` method and hand to the layer above the loop. There is no `.slice(...)` in
  either loop any more, and neither can grow a second one. So the invariant this ticket argues is
  worth making structural — "the size limits are applied in exactly one place" — is **already
  structural**, by a different route.
- **The fetch path is no longer untested.** `rpc-snapshot-cap-fetch-path-test` added a fetch-path
  limit test that drives the real parser and counts the same routing-table writes, and a test that
  drives both paths together. Both were confirmed to fail when the limits are removed, so the
  "what it buys the tests" section below no longer describes an open gap.

**What genuinely remains** is the plain duplication and the cosmetic drift: two copies of the same
~20-line store-it loop, one logging a bad id through the package logger and the other through
`console.warn` (still true — `console.warn` in library code prints unconditionally on every
platform this package targets), and the accumulator named differently in each. That is worth
tidying; it is no longer worth doing to secure a correctness invariant, because the invariant is
secured elsewhere.

## Why it is worth retiring rather than living with

The copies have **already drifted**, which is the evidence this is not a hypothetical:

- The announce copy logs a failed id through the package logger (`log.error`); the fetch copy uses
  `console.warn`. Only one of those is the house style, and `console.warn` in library code prints
  unconditionally on every platform the package targets.
- The accumulator has a different name in each (`discovered` vs `announced`), so the two read as
  unrelated code to anyone grepping.

Extracting one private method — take a snapshot, return the list of ids not seen before — collapses
that drift to one logging decision, and means a future change to how a received neighbour is stored
(a different scoring call, an extra guard) cannot be applied to one path and forgotten on the other.
That last point is the whole remaining case: it is a maintainability argument, not a correctness one.

## Expected behaviour after the change

- One unusable entry still drops only itself, on both paths.
- Both paths still report which ids were new, so the caller can announce them.
- Failed ids are logged one way, through the package logger.
