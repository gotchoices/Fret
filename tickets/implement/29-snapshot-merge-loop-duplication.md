description: Two places in the service do the identical job of taking a neighbour list a peer sent us and storing it, in slightly different-looking code that has already started drifting — merge that into one shared routine.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/announce-rate-limit.spec.ts, packages/fret/test/rpc.snapshot-merge-cap.spec.ts
difficulty: easy

<!-- resume-note -->
Third run: hit BUDGET_WARNING right after confirming `tsc --noEmit` clean, before running
`yarn test`. **Do not re-edit anything** — the extraction is done and already committed at HEAD
(`047ee72`, "ticket(implement): snapshot-merge-loop-duplication"). `git status --short` shows a
clean tree (only an untracked `tickets/.in-progress` marker, unrelated). `git diff` is empty —
there is nothing uncommitted to lose.

Confirmed this run:
- `cd packages/fret && npx tsc --noEmit` → clean, no output, exit 0.
- `git log --oneline` shows the extraction already landed at HEAD; nothing pending in the working
  tree.

Not done yet — next agent's whole job, in order:
1. `cd packages/fret && yarn test` (full suite). If that's too slow/noisy, at minimum run the
   three targeted specs the ticket calls out:
   `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/rpc.handler-fuzz.spec.ts" "test/announce-rate-limit.spec.ts" "test/rpc.snapshot-merge-cap.spec.ts" --timeout 30000`
   `rpc.snapshot-merge-cap.spec.ts` is the most direct check — it counts `store.upsert` calls on
   both the announce and fetch merge paths, which is exactly what the extraction must not change.
2. If green: read the extracted method in `fret-service.ts` (grep `mergeDiscoveredId`) and confirm
   by eye it matches the ticket's "What to build" section below — private method, per-entry
   `try/catch` preserved (one bad id drops only itself), both call sites pass their own accumulator
   and log label, sample-loop re-hash-not-trust comment kept in exactly one place. Then write the
   `tickets/review/` handoff per the Implement stage rules (distilled summary, emphasis on
   test/validation use cases, honest that verification stopped at tsc + these three specs / full
   suite — whichever you ran), and delete this file from `tickets/implement/`.
3. If tests fail: check whether the failure is plainly pre-existing (unrelated subsystem, fails on
   `main` at HEAD before this diff) — if so follow the `.pre-existing-error.md` protocol in the
   ticket workflow rules rather than chasing it here. If the failure looks caused by the
   extraction itself, diagnose against the diff in `047ee72` (`git show 047ee72 -- packages/fret/src/service/fret-service.ts`) — it's a small mechanical change, likely failure mode is a typo or a
   dropped `await`, not a design issue — and fix before handing off.

Everything below this point is the original ticket's full research and spec, still accurate and
worth reading if you need to verify the extraction against intent — it hasn't changed since the
first run.

## Original prior-run research (still valid, no drift found beyond what's documented below)

Confirmed by direct read (not just ticket claim), prior to the extraction landing:
- `mergeAnnounceSnapshot` loops were at `fret-service.ts:2035-2042` (successors/predecessors) and
  `2045-2061` (sample), accumulator `discovered`.
- `fetchAndMergeSnapshot` loops were at `fret-service.ts:2660-2667` (successors/predecessors) and
  `2668-2674` (sample), accumulator `announced`.
- Both shapes matched the ticket's description exactly — no drift beyond what's already documented.

## Correction to the plan-stage research

The plan ticket this was promoted from claimed the fetch-path loop logs a dropped id through
`console.warn`. That was not true even before this ticket's edit — grepped at promotion time, zero
`console.warn` hits in `fret-service.ts`. Both loops already logged through the package logger
(`log.error`). The remaining, still-true case for extracting was just: two copies of the same
~20-line loop, with the accumulator named differently in each (`discovered` in
`mergeAnnounceSnapshot`, `announced` in `fetchAndMergeSnapshot`) — cosmetic, but it made the two
read as unrelated code to anyone grepping, and a future change to how a received id is stored
(different scoring call, an extra guard) could be applied to one copy and forgotten on the other.

## What was built (second run, per the resume-note that was here before)

Added private `mergeDiscoveredId(pid, into, logLabel)` on `FretService`, right before
`mergeAnnounceSnapshot`. Both of `mergeAnnounceSnapshot`'s loops (successor/predecessor, sample)
call it, passing `discovered` and labels `'mergeAnnounceSnapshot'` / `'mergeAnnounceSnapshot
sample'`. Both of `fetchAndMergeSnapshot`'s loops call the same method, passing `announced` and
labels `'fetchAndMergeSnapshot'` / `'fetchAndMergeSnapshot sample'`. The re-hash-not-trust
rationale comment is kept once, on the extracted method's docstring, with a short pointer comment
above each sample loop instead of restating it. `mergeSnapshotCaps`, the parsers, and
`calibrateSizeFromSnapshot` were not touched.

## The two sites (for reference, read both before touching either if further edits are needed)

`packages/fret/src/service/fret-service.ts`, before extraction:

- `mergeAnnounceSnapshot` (~line 2005), the loops from ~2035–2062:
  ```ts
  for (const pid of [...(snap.successors ?? []), ...(snap.predecessors ?? [])]) {
      try {
          const coord = await hashPeerId(peerIdFromString(pid));
          if (await this.noteDiscovered(pid, coord)) discovered.push(pid);
      } catch (err) {
          log.error('mergeAnnounceSnapshot: failed for %s - %e', pid, err);
      }
  }
  for (const s of snap.sample ?? []) {
      try {
          const coord = await hashPeerId(peerIdFromString(s.id));
          if (await this.noteDiscovered(s.id, coord)) discovered.push(s.id);
      } catch (err) { log.error('mergeAnnounceSnapshot sample upsert failed for %s - %e', s.id, err) }
  }
  ```
- `fetchAndMergeSnapshot` (~line 2626), the loops from ~2660–2674: line-for-line the same shape,
  accumulating into `announced` instead of `discovered`.

Both loops feed the **same** two inputs each call site already has: an array of plain peer-id
strings (`successors`/`predecessors` concatenated) and `snap.sample` (`Array<{id, coord,
relevance}>` — `coord` is deliberately re-hashed from `id`, never trusted from the wire; see the
comment at the sample loop for why). Both loops write into `this.store` via `noteDiscovered`
(never `applyTouch`/`upsert` directly — a gossiped id gets the one-off hearsay baseline, not
frequency credit; see `docs/fret.md` under *Relevance scoring and table management*).

## Edge cases & interactions (must hold after extraction — verify these when checking tests)

- **One bad id still drops only itself.** The extracted method's `try`/`catch` must keep failing
  per-entry, not let one bad id throw out of the shared method and abort the whole calling loop.
- **`noteDiscovered` races are unaffected.** The extraction must not add a second write path around
  it.
- **Sample entries and successor/predecessor entries take the same store treatment** despite
  arriving in different wire shapes (`string` vs `{id, coord, relevance}`) — the extracted method
  takes just the id string, so the caller does the `s.id` projection, not the shared method.
- **`discovered`/`announced` still feeds its caller correctly**: `mergeAnnounceSnapshot` uses it to
  call `announceToNewPeers`; `fetchAndMergeSnapshot` returns it to its caller for the same purpose.
  This is what `test/announce-rate-limit.spec.ts` and `test/rpc.snapshot-merge-cap.spec.ts`
  exercise.
- **Log label per call site** — each call site's failures should still be distinguishable in logs
  (which loop, which path).

## Tests

- Run existing suites, don't add new ones for behavior — this is a refactor with unchanged
  observable behavior:
  - `packages/fret/test/rpc.handler-fuzz.spec.ts`
  - `packages/fret/test/announce-rate-limit.spec.ts`
  - `packages/fret/test/rpc.snapshot-merge-cap.spec.ts` (counts `store.upsert` calls on both
    announce and fetch paths — the most direct check that the extraction didn't change write
    counts)
- `cd packages/fret && npx tsc --noEmit` — **done, confirmed clean this run.**
- `cd packages/fret && yarn test` — **still to do.**

## TODO

Run the test suites above (tsc already confirmed clean), verify the extraction by eye against the
edge cases listed, then write the `tickets/review/` handoff and delete this ticket.

## End
Do NOT commit — runner handles commits after you complete.
