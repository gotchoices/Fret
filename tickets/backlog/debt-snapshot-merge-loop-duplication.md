description: Two places in the service do the identical job of taking a neighbour list a peer sent us and storing it, and the two copies have already started drifting apart from each other.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/announce-rate-limit.spec.ts
difficulty: easy
tradeoffs: The two copies are only ~20 lines each and work correctly today, so a maintainer may reasonably judge the extraction not worth touching a 2960-line file for until one of them actually needs to change.

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

Line for line the two are the same: the same `.slice(0, caps.successors)` / `.slice(0, caps.predecessors)`
/ `.slice(0, caps.sample)`, the same `hashPeerId(peerIdFromString(pid))`, the same
`getById` → push-if-new → `upsert` → `applyTouch`, the same per-entry `try`/`catch` so one bad id
drops itself rather than the message.

## Why it is worth retiring rather than living with

The copies have **already drifted**, which is the evidence this is not a hypothetical:

- The announce copy logs a failed id through the package logger (`log.error`); the fetch copy uses
  `console.warn`. Only one of those is the house style, and `console.warn` in library code prints
  unconditionally on every platform the package targets.
- The accumulator has a different name in each (`discovered` vs `announced`), so the two read as
  unrelated code to anyone grepping.

The invariant worth making structural is **"the caps are applied in exactly one place."** Today
`mergeSnapshotCaps()` being a single method is what keeps the two paths in lockstep, and the
argument that this is sufficient is written down in a test comment
(`test/announce-rate-limit.spec.ts`, "asserting the shared helper's values guarantees the two paths
stay in lockstep") — but a shared *constant* does not guarantee a shared *loop*. Either copy can
grow a second slice, skip a cap, or stop calling `applyTouch`, and nothing fails.

Extracting one private method — take a snapshot plus the caps, return the list of ids not seen
before — makes that impossible instead of merely conventional, and it collapses the drift above to
one logging decision.

## What it buys the tests

The merge-cap tests added by `rpc-snapshot-cap-merge-tests` count the exact number of store writes
an over-long announce costs the receiver, and they deliberately cover the announce path only. The
handoff records the fetch path as an untested gap. With one shared loop that gap closes without a
second copy of the test: the counted path *is* the fetch path.

## Expected behaviour after the change

- An over-long snapshot costs the receiver the same bounded number of writes whichever way it
  arrived, and that is true by construction rather than by two loops agreeing.
- One unusable entry still drops only itself, on both paths.
- Both paths still report which ids were new, so the caller can announce them.
- Failed ids are logged one way, through the package logger.
