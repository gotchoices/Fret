description: Two places that stored a peer-sent neighbour list did the same per-id merge in slightly different-looking code; extracted into one shared private method.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/announce-rate-limit.spec.ts, packages/fret/test/rpc.snapshot-merge-cap.spec.ts

## What changed

`FretService` gained a private method, `mergeDiscoveredId(pid, into, logLabel)`
(`packages/fret/src/service/fret-service.ts:2013`):

```ts
private async mergeDiscoveredId(pid: string, into: string[], logLabel: string): Promise<void> {
	try {
		const coord = await hashPeerId(peerIdFromString(pid));
		if (await this.noteDiscovered(pid, coord)) into.push(pid);
	} catch (err) {
		log.error('%s: failed for %s - %e', logLabel, pid, err);
	}
}
```

Both call sites that used to carry a copy of this ~20-line loop now call it:

- `mergeAnnounceSnapshot` — successor/predecessor loop and the sample loop, both passing the
  `discovered` accumulator, labels `'mergeAnnounceSnapshot'` / `'mergeAnnounceSnapshot sample'`
  (`fret-service.ts:2052-2054`, `:2066-2068`).
- `fetchAndMergeSnapshot` — same two loops, passing `announced`, labels `'fetchAndMergeSnapshot'`
  / `'fetchAndMergeSnapshot sample'` (`fret-service.ts:2666-2667`, `:2670-2671`).

The re-hash-not-trust rationale (coord is always re-derived from `s.id`, never taken from the
wire `s.coord` field) is stated once on the extracted method's docstring, with a short pointer
comment at each sample-loop call site instead of restating it. `mergeSnapshotCaps`, the wire-shape
parsers, and `calibrateSizeFromSnapshot` were untouched — this ticket only touched the per-id
merge step, not truncation or size-estimate calibration.

## Why (for a reader with no ticket context)

The two loops accumulated into differently-named arrays (`discovered` vs `announced`) despite
being the identical operation, which made them read as unrelated code to anyone grepping and meant
a future change to how a received id gets stored (extra guard, different scoring call) could land
on one copy and be forgotten on the other. No behavior change was intended or made — this is a
pure extraction.

## Verification performed

- `cd packages/fret && npx tsc --noEmit` — clean, no output, exit 0.
- `cd packages/fret && yarn test` (full suite) — **1219 passing, 0 failing.** Includes the three
  specs the ticket named as most relevant:
  - `test/rpc.handler-fuzz.spec.ts`
  - `test/announce-rate-limit.spec.ts`
  - `test/rpc.snapshot-merge-cap.spec.ts` — counts `store.upsert` calls on both the announce and
    fetch merge paths; this is the most direct check that the extraction didn't change write
    counts or behavior, and it passed unchanged.
- Eye-check of the extracted method against the edge cases the plan/implement research called
  out, all confirmed by direct read of `fret-service.ts:2013-2020` and both call sites:
  - Per-entry `try`/`catch` preserved inside `mergeDiscoveredId` itself — one bad id (unparseable
    peer id, hash failure) is caught and logged there, so it drops only itself and never throws
    out into the caller's loop.
  - Each call site still passes its own accumulator (`discovered` vs `announced`) and its own log
    label, so failures stay distinguishable per call site in logs as before.
  - Sample entries (`{id, coord, relevance}`) are still projected to `s.id` by the *caller* before
    calling the shared method — the shared method only ever takes a plain id string, matching the
    "coord is re-hashed, never trusted" invariant.
  - Both loops still write only through `noteDiscovered` (never a direct `upsert`/`applyTouch`),
    preserving the "hearsay gets the one-off baseline score, not frequency credit" rule from
    `docs/fret.md`.

## Known gaps / what the reviewer should treat as unverified

- I did not add new tests — this ticket is a pure refactor with an explicitly unchanged
  observable-behavior contract, and the existing suite (particularly
  `rpc.snapshot-merge-cap.spec.ts`'s `store.upsert` call counts) is what pins that contract. If the
  reviewer wants a test that pins the *extraction* itself (e.g. asserting both call sites route
  through one method) rather than just its observable effect, that's a gap, not an oversight.
  Given the strong existing coverage on both merge paths, this project's steady-state prescribes
  the current test floor.
  Given "run existing suites, don't add new ones" was explicit in the ticket's own Tests section,
  new coverage for the extraction seam itself was treated as out of scope for this ticket.
- No manual/integration exercise beyond the automated suite — this is a same-process TypeScript
  refactor with no wire-format, config, or public-API change, so the automated suite (unit +
  two-node RPC + simulation) is the applicable validation surface; there's no separate "run it in
  a browser" or similar manual step for this kind of change.
- This ticket's implementation spanned three prior agent runs interrupted by budget limits (see
  git log for this slug); the final state was reached, committed, and independently confirmed
  clean by this run (tsc + full test suite), but the reviewer may want to skim `git log --oneline`
  for the four `ticket(implement): snapshot-merge-loop-duplication` commits to see the shape the
  work took if that context is useful.

## Suggested review focus

- Confirm `mergeDiscoveredId`'s placement/visibility (private, same class) and that nothing outside
  `mergeAnnounceSnapshot` / `fetchAndMergeSnapshot` needed this helper (grep confirms only those
  two call sites at `fret-service.ts:2053`, `:2067`, `:2667`, `:2671`).
- Confirm no third near-duplicate of this loop shape exists elsewhere in the file that this ticket
  should have caught but didn't (out of scope for this ticket's stated files, but worth a glance
  given the "already started drifting" framing in the original description).
