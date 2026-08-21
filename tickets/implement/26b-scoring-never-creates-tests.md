description: The routing-table code no longer re-adds a peer when recording a success or failure about it, but the tests don't yet lock that new rule in — this ticket writes those tests.
prereq: 26a-scoring-stale-comments
files: packages/fret/src/service/fret-service.ts, packages/fret/test/churn.leave.spec.ts, packages/fret/test/dead-state.spec.ts, packages/fret/test/helpers/maintenance-rig.ts
difficulty: medium
----

Fourth attempt at this half of the parent ticket (`26-scoring-never-creates-tests`); the prior
three all ran out of budget mid-*reading*, with zero edits landed each time. This ticket is
written to be actionable without re-reading `fret-service.ts` or re-deriving what's already
confirmed below. **Do not re-open `fret-service.ts` to re-verify the source change** — read it
only if you need to touch `applyFailure` temporarily per the "prove it bites" step below.

### Confirmed, do not re-verify

- `packages/fret/src/service/fret-service.ts`: `applyTouch` (private), `applySuccess`,
  `applyFailure` all open `const entry = this.store.getById(id); if (!entry) return;` before any
  `await`. The create-on-miss arm (`?? this.store.upsert(id, coord)`) is gone; all three dropped
  their `coord` parameter and read `entry.coord` instead. `applyContactFailure` dropped `coord`
  too. Doc comments above each already state "scoring never creates".
- `DigitreeStore.update` / `remove` already return early on a missing id — no store change
  needed.
- `npx tsc --noEmit` passes against the changed source. `test/churn.leave.spec.ts`,
  `test/rpc.snapshot-merge-cap.spec.ts`, `test/failure-recovery.spec.ts`, `test/dead-state.spec.ts`
  (97 tests) all pass against it.
- `packages/fret/test/helpers/maintenance-rig.ts` (`buildMaintenanceRig`) has been read in full.
  It returns `{ node, svc, store, rig, ping, neighbors, concurrency, setTickBudget, seedPeers,
  teardown }`. `rig` (a `PeerRig`) gives per-peer control of outbound RPCs: `rig.behavior` map
  (`'answers' | 'hangs'`), `rig.holdMs` (delays a stub reply by N ms before resolving — the hook
  for holding a probe open long enough to mutate the store mid-flight), `rig.opened` (protocols
  seen per id, in order), `rig.inFlight`/`rig.highWater`. `seedPeers(count, membership, patch?)`
  seeds real Ed25519-keyed peers at true ring coordinates, dialable.
- `packages/fret/test/dead-state.spec.ts` already drives a real `peer:disconnect` event (grep
  confirmed: it's one of only two files in `test/` that reference `peer:disconnect`, the other
  being `churn.leave.spec.ts` itself in comments only). **Read that file's idiom for dispatching
  `peer:disconnect` before writing the new disconnect test below — do not re-derive it.**
- `fret-service.ts:1050` registers the `peer:disconnect` node listener (`addNodeListener`); it
  calls `applyFailure` per prior analysis (not re-verified this run — if anything below doesn't
  match, that's the one line worth a fresh look, not the whole file).

### What's left

**1. `test/churn.leave.spec.ts`, lines ~368-400.** There's an existing test
`'removes the departing peer from the id map and from the ring window'` with a stale comment
above it (lines ~368-372) that reads:

```
	// `handleLeave` calls `store.remove(notice.from)`, and until now nothing asserted it. The mesh
	// test that used to try could not: a graceful stop is followed by the `peer:disconnect` whose
	// `applyFailure` re-creates the entry (`backlog/debt-scoring-resurrects-removed-peers`). This
	// rig's receiver service is never started, so no disconnect listener exists to resurrect it and
	// the removal is observable on its own.
```

That ticket (`backlog/debt-scoring-resurrects-removed-peers`) is resolved by the landed source
change, and the "could not test the disconnect case" framing is now false. Replace the comment
with:

```
	// `handleLeave` calls `store.remove(notice.from)`. Scoring helpers no longer resurrect a
	// removed peer (`applyTouch`/`applySuccess`/`applyFailure` return early on a miss — see
	// `docs/fret.md`, *Relevance scoring and table management*), so removal is durable through the
	// `peer:disconnect` that follows a graceful departure too, not just observable in isolation.
	// This rig's receiver service is never started, so this test covers the leave notice alone;
	// the sibling test below drives a real `peer:disconnect` on top of it.
```

Leave the existing test body unchanged — it's still a valid, narrower case.

**Add a new sibling test** (same file, after it) that covers the two-step sequence a real
graceful departure produces: leave notice, *then* the disconnect. Use the idiom from
`test/dead-state.spec.ts` for driving a real `peer:disconnect` (that file already solves "how do
I dispatch this event against a service under test" — read it first). Shape:

- Seed `departingId` as a live member at its true coordinate (same pattern as the existing test,
  lines ~380-381 of `churn.leave.spec.ts`).
- Send the leave notice (reuse this file's existing `rig.leave()` helper).
- Drive a real `peer:disconnect` for `departingId` against the receiver, per the
  `dead-state.spec.ts` idiom.
- Assert `store.getById(departingId) === undefined` and the S/P window
  (`rig.svc.getNeighbors(...)`, same helper the existing test uses) excludes it, after *both*
  steps.
- **Prove it bites, don't assume it**: temporarily restore the `?? this.store.upsert(entry?.coord
  ?? coord, ...)` create-on-miss arm in `applyFailure` (`fret-service.ts`), run just this one new
  test, confirm it now fails, then revert the temporary change before moving on. Do this with a
  single Edit + single targeted mocha run + Edit revert — don't run the full suite for this
  check.
- Do **not** repurpose the existing unstarted-service rig for the other tests in this
  file's `Leave amplification cap` describe block (if that's the enclosing block — confirm the
  name by reading a few lines above line 373) — those tests depend on the service being
  unstarted so diagnostics deltas are attributable to `handleLeave` alone. A starting-a-real-node
  test is a separate small rig/test, not a modification of the shared one.

**2. Three new tests.** Place them in a new file `test/scoring-never-creates.spec.ts` (cleaner
than fighting existing describe-block setup in `churn.leave.spec.ts`):

- *Scoring an unknown id creates nothing.* For each of the three helpers (`applyTouch` via an
  announce/snapshot merge, `applySuccess` via a ping outcome, `applyFailure` via a
  `peer:disconnect` — same idiom as test 1 above), drive it against an id **not** in the store.
  Assert `store.size()` unchanged, `store.getById(id)` still `undefined`, no throw. Drive through
  real call sites, not by casting to `any` to call the private methods directly — a test that
  reaches in pins the method's shape, not its behavior.
- *Scoring an existing entry is unaffected.* Same three paths, against a peer already present.
  Assert the same relevance/counter outcomes as before the source change (regression guard on the
  arm the change did not touch).
- *Removal during a probe.* Using `buildMaintenanceRig` (Core or Edge profile — either is fine):
  seed a peer, let a pooled maintenance pass select it as a probe target, then `store.remove(id)`
  before its outcome resolves — use `rig.holdMs` on the stub reply to create the window. Assert
  the peer stays absent and nothing throws.

### Edge cases the tests should keep in view (from the design doc, don't need separate tests
unless a gap surfaces)

- A peer evicted mid-tick (between probe selection and scoring) — scoring must no-op, not throw
  or resurrect.
- Concurrent scoring across a removal (two pooled tasks scoring the same peer, a `store.remove`
  landing between them) — second must no-op, no throw.
- Rediscovery still works via `peer:connect`, `peer:identify`, an inbound RPC, or a neighbor
  snapshot naming the peer — none of those paths goes through the scoring helpers, so this isn't
  a regression risk from this change, just worth keeping in mind if a test seems to imply
  otherwise.

### TODO

- Rewrite the `churn.leave.spec.ts` comment (verbatim text above) and add the disconnect sibling
  test; prove-then-revert the `applyFailure` bite check.
- Add `test/scoring-never-creates.spec.ts` with the three tests above.
- Run `cd packages/fret && npx tsc --noEmit`.
- Run the full `cd packages/fret && yarn test` (foreground, no output redirection) — the source
  half has only been validated against four targeted specs so far; this is the first full-suite
  run against it.
- If any pre-existing (unrelated) test failure surfaces, follow the `.pre-existing-known.md` /
  `.pre-existing-error.md` protocol in the ticket workflow rules rather than touching it.
