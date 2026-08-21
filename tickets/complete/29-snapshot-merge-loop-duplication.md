description: Two places that stored a peer-sent neighbour list ran the same per-id merge as two copies; they now share one private method. Reviewed, comment placement tidied, no behaviour change.
files: packages/fret/src/service/fret-service.ts

## What shipped

`FretService.mergeDiscoveredId(pid, into, logLabel)` (`packages/fret/src/service/fret-service.ts:2011`)
holds the "hash the id, note it as discovered, remember it if it was new" step once:

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

Four loops call it — the successor/predecessor loop and the sample loop in each of
`mergeAnnounceSnapshot` and `fetchAndMergeSnapshot` — each passing its own accumulator
(`discovered` / `announced`) and its own log label, so a failure is still attributable to the
loop it came from. Truncation stays in the wire-shape parser (`makeSnapshotParser`) and
size-estimate calibration stays in `calibrateSizeFromSnapshot`; neither was touched.

Behaviour is unchanged by construction: same per-entry `try`/`catch` boundary, same
push-only-if-new rule, same single write path through `noteDiscovered` (so a gossiped id still
takes the one-off hearsay baseline and no frequency credit).

## Review findings

**Checked.** The full implement diff read before the handoff summary; both merge sites and the
extracted method read in place; the per-entry error boundary, the accumulator wiring back to
`announceToNewPeers` / the fetch caller, the log-label distinguishability, method placement and
visibility, the surrounding comments, `docs/fret.md`, existing test coverage, and a sweep for a
third copy of the loop shape.

**Major findings: none.** No tickets filed. The extraction is semantics-preserving line by line —
the `try` still wraps exactly the hash and the `noteDiscovered` write for one id, so one
unparseable id still drops only itself and never aborts the loop around it.

**Minor, fixed in this pass.** The re-hash rationale was left in the wrong place. The extracted
method's docstring pointed *down* to a comment 35 lines below it at a call site, and
`fetchAndMergeSnapshot` pointed at a comment inside a different method — a three-hop chain to
reach one rule. Moved the rationale onto `mergeDiscoveredId`'s docstring, which is where the rule
is now actually enforced, and cut both call sites to one-line pointers. Two things went with it:

- Dropped the sentence "The successor/predecessor loop above always re-hashed; only the sample was
  ever trusted, and there is no reason for the difference." After the extraction there is no
  difference left for it to describe — both loops are the same call — so it read as a live
  distinction that no longer exists.
- Added the point that makes the invariant structural rather than a convention: the method takes a
  plain id string, so the `sample`'s `{id, coord, relevance}` shape is projected to `s.id` by the
  caller and **no path can hand this method a coord at all**. That is stronger than "remember to
  re-hash", and it is the reason the extraction is safe.

**Third-copy sweep (the handoff asked for this explicitly): none found.** Every
`hashPeerId(peerIdFromString(...))` site in `src/` was read. The only other pairing with
`noteDiscovered` is `recordLeaveReplacements` (`fret-service.ts:~1893`), and it is a genuinely
different operation, not a fourth copy — it dedups against self, the departing peer, and ids
already seen, gates on `isDialable`, and keeps no accumulator. Folding it into the shared method
would mean smuggling a dialability gate into the snapshot merge paths, which deliberately do not
have one. Left alone.

**Docs: read, and correctly already current.** `docs/fret.md` describes these paths in terms of
`noteDiscovered` and the re-hash rule, not in terms of the loop's shape, so a pure extraction
leaves every claim true — including "both merge loops derive `coord` from `s.id`" under *Not yet
implemented → Message authentication*, which is now more literally true than before (one call, not
two loops that happen to agree). Nothing needed updating; noting the check explicitly rather than
leaving it silent.

**Tests: no new tests, and this is the right floor — with a reason, not a shrug.**
`test/rpc.snapshot-merge-cap.spec.ts` already pins this extraction's whole contract as observable
behaviour on *both* paths: it counts `store.upsert` calls, and it carries the case "skips a sample
entry whose id will not parse, without costing the message its other ids", which is exactly the
per-entry `try`/`catch` boundary the extraction had to preserve and the one thing that could have
broken. A test asserting that both call sites route through one method would pin implementation
shape rather than behaviour, and would have to be deleted the next time the shape changes. The
implementer flagged its absence as a possible gap; it is not one.

**Considered, not changed.** `mergeDiscoveredId` writes its result through an output parameter
(`into`) rather than returning a boolean and letting the caller push. Returning would read
slightly cleaner, but the current shape keeps the push-if-new rule inside the method with the
`try`/`catch` that guards it, which is where it belongs; churning it buys nothing.

**Tripwires: none.** Nothing here is conditionally-a-problem-later — the change removes a copy and
adds no new cost, allocation, or growth path.

## Verification

- `cd packages/fret && npx tsc --noEmit` — clean, exit 0 (after this pass's comment edit).
- `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js
  "test/rpc.snapshot-merge-cap.spec.ts" "test/announce-rate-limit.spec.ts"
  "test/rpc.handler-fuzz.spec.ts" --timeout 30000` — **182 passing, 0 failing.**
- No lint step exists in this repo: `AGENTS.md` records `yarn format` / `format:check` as
  unusable (no prettier config, they rewrite the house tab style), and names `yarn check`
  (typecheck + build + test) as the gate.
- **Stated limit on this run's testing:** a budget warning landed mid-review, so this pass ran the
  typecheck plus the three specs that cover the changed code rather than the full suite. The full
  suite (1219 passing) was run clean at this same source state during the implement stage, and
  this pass's only edit is to comments — no statement, expression, or signature changed. No
  pre-existing failures were observed.
