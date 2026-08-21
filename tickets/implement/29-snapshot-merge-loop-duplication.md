description: Two places in the service do the identical job of taking a neighbour list a peer sent us and storing it, in slightly different-looking code that has already started drifting — merge that into one shared routine.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/announce-rate-limit.spec.ts, packages/fret/test/rpc.snapshot-merge-cap.spec.ts
difficulty: easy

<!-- resume-note -->
Second run: made the edit, then hit BUDGET_WARNING before running `tsc`/tests. Code change is
done and believed correct (mechanical extraction, no logic change) but **unverified** — next
agent's first job is verification, not more editing.

Done in `packages/fret/src/service/fret-service.ts`:
- Added private `mergeDiscoveredId(pid, into, logLabel)` right before `mergeAnnounceSnapshot`
  (~line 2005), matching the ticket's suggested shape exactly.
- `mergeAnnounceSnapshot`'s two loops (successor/predecessor, sample) now call it, passing
  `discovered` and labels `'mergeAnnounceSnapshot'` / `'mergeAnnounceSnapshot sample'`. The
  re-hash-not-trust rationale comment is kept once, on the extracted method's docstring, with a
  short comment above the sample loop still explaining why the sample specifically needs it
  (content preserved, not deleted — matches "have comments point at it rather than restate it").
- `fetchAndMergeSnapshot`'s two loops now call the same method, passing `announced` and labels
  `'fetchAndMergeSnapshot'` / `'fetchAndMergeSnapshot sample'`, with a one-line pointer comment
  ("Re-hashed, not trusted — see the sample loop in `mergeAnnounceSnapshot`") kept above its
  sample loop.
- Did not touch `mergeSnapshotCaps`, the parsers, `calibrateSizeFromSnapshot`, or anything else
  around the loops.

Not done yet — do these next, in order:
1. `cd packages/fret && npx tsc --noEmit` — expect clean; only a transient "declared but never
   read" diagnostic was seen mid-edit (before the second call site was wired in), which should be
   gone now that both call sites use the method, but confirm.
2. `cd packages/fret && yarn test` (or targeted: `rpc.handler-fuzz.spec.ts`,
   `announce-rate-limit.spec.ts`, `rpc.snapshot-merge-cap.spec.ts` — the last counts
   `store.upsert` calls on both paths, the most direct check the extraction didn't change write
   counts).
3. If both pass: write the `tickets/review/` handoff per the Implement stage rules (distilled
   summary, emphasis on test/validation use cases, honest about what wasn't independently
   verified beyond the three specs above), then delete this file from `tickets/implement/`.
4. If either fails: diagnose against this specific diff (it's a small mechanical change — the
   likely failure mode is a typo or a dropped `await`, not a design issue) and fix before handing
   off.

Original prior-run research (still valid, no drift found beyond what's documented below):

Confirmed by direct read (not just ticket claim):
- `mergeAnnounceSnapshot` loops are at `fret-service.ts:2035-2042` (successors/predecessors) and
  `2045-2061` (sample), accumulator `discovered` (declared line 2013).
- `fetchAndMergeSnapshot` loops are at `fret-service.ts:2660-2667` (successors/predecessors) and
  `2668-2674` (sample), accumulator `announced` (declared line 2627).
- Both shapes match the ticket's description exactly — no drift beyond what's already documented.
  Nothing else needs re-discovery; go straight to the edit below.

Next agent: implement per the "What to build" section as-is — add a private
`mergeDiscoveredId(pid, into, logLabel)` method (or equivalent name) on `FretService`, call it from
both loop bodies (successor/predecessor loop passes `pid` directly; sample loop passes `s.id`), keep
each site's own accumulator var name and per-site log label distinguishable, keep the sample-loop's
re-hash-not-trust comment in exactly one place (the extracted method or immediately above it) with
both call sites' remaining comments pointing at it rather than restating it. Do not touch
`mergeSnapshotCaps`/parsers. Then run:
- `cd packages/fret && npx tsc --noEmit`
- `cd packages/fret && yarn test` (or targeted: `rpc.handler-fuzz.spec.ts`,
  `announce-rate-limit.spec.ts`, `rpc.snapshot-merge-cap.spec.ts`)

## Correction to the plan-stage research

The plan ticket this was promoted from claimed the fetch-path loop logs a dropped id through
`console.warn`. That is no longer true — grepped at promotion time, zero `console.warn` hits in
`fret-service.ts`. Both loops already log through the package logger (`log.error`). Some other
change fixed that already. The remaining, still-true case for extracting is just: two copies of
the same ~20-line loop, and the accumulator is named differently in each (`discovered` in
`mergeAnnounceSnapshot`, `announced` in `fetchAndMergeSnapshot`) — cosmetic, but it makes the two
read as unrelated code to anyone grepping, and a future change to how a received id is stored
(different scoring call, an extra guard) can be applied to one copy and forgotten on the other.

## The two sites (read both before touching either)

`packages/fret/src/service/fret-service.ts`:

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
  same `hashPeerId(peerIdFromString(...))` → `noteDiscovered` → push-if-new, same per-entry
  `try`/`catch`, just accumulating into `announced` instead of `discovered`.

Both loops feed the **same** two inputs each call site already has: an array of plain peer-id
strings (`successors`/`predecessors` concatenated) and `snap.sample` (`Array<{id, coord,
relevance}>` — `coord` is deliberately re-hashed from `id`, never trusted from the wire; see the
comment at the sample loop for why). Both loops write into `this.store` via `noteDiscovered`
(never `applyTouch`/`upsert` directly — a gossiped id gets the one-off hearsay baseline, not
frequency credit; see `docs/fret.md` under *Relevance scoring and table management*).

## What to build

Extract one private method on `FretService` that does the "take an id, hash it, note it as
discovered, remember if it's new" step, and have both loops call it. Suggested shape (adjust
naming to match house style, not load-bearing):

```ts
/**
 * Hash + noteDiscovered one remote-supplied id, appending it to `into` if it was new to the
 * store. Shared by mergeAnnounceSnapshot and fetchAndMergeSnapshot — both take a peer's
 * neighbour list and store it identically; this is that "store it" step in one place so a future
 * change to it (a different scoring call, an extra guard) cannot land on one path and not the
 * other.
 */
private async mergeDiscoveredId(pid: string, into: string[], logLabel: string): Promise<void> {
	try {
		const coord = await hashPeerId(peerIdFromString(pid));
		if (await this.noteDiscovered(pid, coord)) into.push(pid);
	} catch (err) {
		log.error('%s: failed for %s - %e', logLabel, pid, err);
	}
}
```

Both call sites become e.g.:

```ts
for (const pid of [...(snap.successors ?? []), ...(snap.predecessors ?? [])]) {
	await this.mergeDiscoveredId(pid, discovered, 'mergeAnnounceSnapshot');
}
for (const s of snap.sample ?? []) {
	await this.mergeDiscoveredId(s.id, discovered, 'mergeAnnounceSnapshot sample');
}
```

(and the fetch path the same, with its own accumulator variable name and log label). Keep each
site's accumulator variable named as it is today (`discovered` / `announced`) if you prefer — the
duplication being removed is the *loop body*, not the variable name; renaming both to match is a
nice-to-have, not the point.

Do **not** move or duplicate the sample id-vs-coord re-hash rationale comment — keep it once, at
the extracted method or immediately above it, and have both call sites' comments (if any remain)
point at it rather than restate it.

Do **not** touch `mergeSnapshotCaps()`, the parsers (`makeSnapshotParser`), or anything upstream of
these loops — the size-limit enforcement already lives in the parser, not the loop (see the `NOTE:`
at `mergeSnapshotCaps` in `fret-service.ts` and the corresponding section in `docs/fret.md`); this
ticket is purely the per-entry store step downstream of that.

## Edge cases & interactions

- **One bad id still drops only itself.** The extracted method's `try`/`catch` must keep failing
  per-entry, not let one bad id throw out of the shared method and abort the whole calling loop —
  this is the exact behaviour both existing loops have today and the tests below pin it.
- **`noteDiscovered` races are unaffected.** Both call sites can run concurrently against the same
  store (announce inbound vs. a stabilization-tick fetch); `noteDiscovered` already handles the
  double-write race (writes only for an id it just created — see the comment above
  `fetchAndMergeSnapshot`). The extraction must not add a second write path around it.
- **Sample entries and successor/predecessor entries take the same store treatment** despite
  arriving in different wire shapes (`string` vs `{id, coord, relevance}`) — the extracted method
  takes just the id string, so the caller does the `s.id` projection, not the shared method.
  Do not fold the coord-decode-and-vet step (already done by the parser before either loop runs)
  into this method.
- **`discovered`/`announced` still feeds its caller correctly**: `mergeAnnounceSnapshot` uses it to
  call `announceToNewPeers`; `fetchAndMergeSnapshot` returns it to its caller for the same
  purpose. Confirm both still do after extraction — this is what
  `test/announce-rate-limit.spec.ts` and `test/rpc.snapshot-merge-cap.spec.ts` exercise.
- **Log label per call site.** The four distinct log messages today (`mergeAnnounceSnapshot:
  failed for %s`, `mergeAnnounceSnapshot sample upsert failed for %s`, `failed to merge neighbor
  %s`, `fetchAndMergeSnapshot sample upsert failed for %s`) do not need to survive verbatim, but
  each call site's failures should still be distinguishable in logs (which loop, which path) —
  don't collapse all four into one indistinguishable message.

## Expected behaviour after the change

- One unusable entry still drops only itself, on both paths (unchanged).
- Both paths still report which ids were new, so the caller can announce them (unchanged).
- Failed ids are logged through the package logger on both paths (already true; not part of this
  change, just don't regress it).
- The store-it step exists in exactly one place in the source; both merge sites call it.

## Tests

- Run existing suites, don't add new ones for behavior — this is a refactor with unchanged
  observable behavior:
  - `packages/fret/test/rpc.handler-fuzz.spec.ts`
  - `packages/fret/test/announce-rate-limit.spec.ts`
  - `packages/fret/test/rpc.snapshot-merge-cap.spec.ts` (counts `store.upsert` calls on both
    announce and fetch paths — the most direct check that the extraction didn't change how many
    times either loop writes)
- `cd packages/fret && npx tsc --noEmit`
- `cd packages/fret && yarn test`

## TODO

Extract shared per-id merge step from `mergeAnnounceSnapshot` and `fetchAndMergeSnapshot` into one
private method; update both call sites to use it; run the tests above.

## End
Do NOT commit — runner handles commits after you complete.
