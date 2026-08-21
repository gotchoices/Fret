description: The routing-table code no longer re-adds a peer when recording a success or failure about it; the tests and design doc that describe the old behavior still need updating, and new tests are needed to lock the new rule in.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/churn.leave.spec.ts, packages/fret/test/rpc.snapshot-merge-cap.spec.ts, docs/fret.md
difficulty: easy
----

<!-- resume-note -->
Third continuation. Second run also hit BUDGET_WARNING having only **read** files — zero edits
landed again. No log file was produced. This run pinned exact line numbers/text for the two
already-identified edit sites so the next run can act without re-reading those files. Nothing
below has changed in substance from the second run's notes — only precision added. Still zero
edits made; everything remains to do.

Exact confirmation from this run (verified at HEAD, `packages/fret/src/service/fret-service.ts`):

- `applyTouch` (private, line 566), `applySuccess` (line 637), `applyFailure` (line 670) all open
  `const entry = this.store.getById(id); if (!entry) return;` before any `await`. Doc comments
  above each already state "Scoring never creates". This matches the ticket's "What already
  landed" section exactly — **no further verification of the source change is needed**, do not
  re-read this range again.
- `test/rpc.snapshot-merge-cap.spec.ts` lines 137–139 (the stale comment inside the doc block
  above `countUpserts`, function body starts line 150) reads verbatim:
  ```
  	 * `applyTouch` opens with `getById(id) ?? upsert(id, coord)` and the loop has always just
  	 * upserted that id, so it does not double-count — a doubled count is the first assumption
  	 * to re-check if these numbers ever drift.
  ```
  This is the exact text to replace. Rewrite to state the new reasoning: `applyTouch` no longer
  creates (returns early on a miss); the reason counted upserts still don't double-count is that
  the announce/fetch paths call `noteDiscovered` (not `applyTouch`) for every remote-named id
  (`from`'s successors/predecessors/sample entries), and `noteDiscovered` itself already
  early-returns on an id already held (`fret-service.ts:608`, `if (this.store.getById(id)) return
  false;`) — so a repeated id in one snapshot, or an id already in the store, upserts at most
  once, and it's `noteDiscovered`'s own guard doing that, not `applyTouch`. (Note: `mergeAnnounceSnapshot`/`fetchAndMergeSnapshot` call `noteDiscovered` for every successor/predecessor/sample
  id — confirmed at `fret-service.ts:2005,2027,2604` — there is no separate explicit upsert of
  `from` itself in the merge loop bodies visible in the ranges read so far; do not assert a
  "from is upserted one line before the loop" claim — that phrasing from the second run's note
  was **not confirmed** this run and should be dropped. The correct, confirmed reasoning is the
  `noteDiscovered` early-return guard above, which is sufficient on its own to explain why counted
  upserts don't double-count.)

Everything else — the three new tests needed, the `churn.leave.spec.ts` rewrite (~line 373, the
`'removes the departing peer...'` test and its stale comment at lines 368–372), the
`docs/fret.md` edits, and the full validation pass — is unchanged from the prior resume-note and
is copied below verbatim (still nothing started on any of it).

Exact discoveries from this run, so the next one can act directly instead of re-reading:

- **`test/churn.leave.spec.ts` lines 368–400** already contain a test named `'removes the
  departing peer from the id map and from the ring window'` that asserts `store.getById(departingId)
  === undefined` and that the S/P window (`spWindow()`) excludes it, **after `rig.leave()`** (i.e.
  after the leave notice alone — `rig.svc` in this describe block, `Leave amplification cap`, is
  deliberately never started, so no `peer:disconnect` listener exists). This is close to what the
  ticket wants but is not the same claim: the ticket asks for the departed peer to stay absent
  **after the leave notice AND the disconnect that follows** — the two-step sequence a real
  graceful departure produces. The comment at lines 368–372 still says "the mesh test that used to
  try could not [...] the removal is observable on its own" and cites the stale
  `backlog/debt-scoring-resurrects-removed-peers` — that reference must go, and the comment must
  stop implying the disconnect case is untestable (it now is, per the landed source change).
  **Still to do here:** add a test — either widen this one or add a sibling — that starts a real
  service (or otherwise drives a real `peer:disconnect` dispatch), sends/simulates the leave and
  then the disconnect, and asserts the peer stays absent through both. Do not repurpose the
  existing unstarted-service rig for this — the other tests in the same `Leave amplification cap`
  describe block (`an accepted leave sends no ping...`, etc.) depend on the service being unstarted
  so diagnostics deltas are attributable to `handleLeave` alone; starting it there would add
  stabilization-tick noise to those counts. A separate small rig/test is the more likely shape.
  Confirm the new assertion actually fails if the `?? this.store.upsert(...)` arm is temporarily
  restored in `applyFailure` (`packages/fret/src/service/fret-service.ts`) — proving it bites, not
  assuming it — then revert that temporary change before finishing.

- **`test/rpc.snapshot-merge-cap.spec.ts` lines 134–139** (the doc comment directly above
  `countUpserts`, not line ~137 in isolation) is the stale reasoning the ticket flags: *"`applyTouch`
  opens with `getById(id) ?? upsert(id, coord)` and the loop has always just upserted that id, so it
  does not double-count [...]"*. That is no longer how `applyTouch` works (it now returns early on a
  miss instead of creating). The counted-upserts-don't-double-count property still holds, but for a
  different reason: the announce path upserts `from` explicitly one line before the merge loop runs
  (in `mergeAnnounceSnapshot`/its caller in `fret-service.ts` — confirm exact call site), so by the
  time `applyTouch` would touch that id it is already in the store and returns via the `getById`
  guard without creating anything. Rewrite the comment to say that, dropping the `?? upsert` framing
  entirely. The counted numbers themselves are expected to be unchanged (ticket already notes this
  spec passed unchanged against the landed source) — only the comment's reasoning is wrong.

- **`test/helpers/maintenance-rig.ts`** was read in full and is the right rig for the "removal
  during a probe" test: `buildMaintenanceRig(profile, cfg?)` returns `{ node, svc, store, rig,
  ping, neighbors, concurrency, setTickBudget, seedPeers, teardown }`. `rig` (a `PeerRig`) gives
  per-peer control of every outbound RPC (`behavior` map: `'answers' | 'hangs'`, `opened` map of
  protocols-per-id, `inFlight`/`highWater`). `seedPeers(count, membership, patch?)` seeds real
  Ed25519-keyed peers at their true ring coordinates, dialable. To force "removed between probe
  selection and scoring", seed a peer, let the pooled pass pick it as a target, then
  `store.remove(id)` before its outcome resolves — e.g. via `rig.holdMs` on the stub stream to
  create a window, or by removing synchronously inside a stubbed `behavior`/reply hook if one can
  be added. Not yet prototyped — next run should read `stabilize-concurrency.spec.ts` or
  `preconnect-concurrency.spec.ts` (not yet opened this run) for the idiom used to hold a pooled
  task open long enough to mutate the store mid-flight, since `PeerRig.holdMs` / `stubStream`'s
  `holdMs` parameter (maintenance-rig.ts:50-72) look like the intended hook (delays the reply by
  `holdMs` before resolving, which is exactly the window needed).

- **The other two new tests** ("scoring an unknown id creates nothing", "scoring an existing entry
  is unaffected") were not yet prototyped either — no code written this run. Ticket body below still
  describes what they need to cover; nothing there has changed.

- **`docs/fret.md`** edits not started. The two target spots are named precisely in the ticket body
  below (*Relevance scoring and table management*, and the `accessCount` note under *Relevance score
  calculation*) — both sections' current text is already known (it was in context this run via the
  project instructions) and just needs the "scoring helpers never create; creation belongs to
  `noteDiscovered` and the explicit insert sites" statement added/folded in.

- **Nothing has been run** — no `tsc`, no `yarn test` — since no edits landed. The full validation
  pass (both commands, from `packages/fret/`) still needs to happen after all edits above, per the
  TODO list at the bottom.

Continuation of `26-scoring-never-creates`, split off when that run hit its token budget. **The
source change already landed** — this ticket is the test and documentation half.

### What already landed (do not redo)

In `packages/fret/src/service/fret-service.ts`:

- `applyTouch`, `applySuccess`, `applyFailure` now open `const entry = this.store.getById(id); if
  (!entry) return;` — the return placed **before** `await this.selfCoord()`. The create-on-miss arm
  (`?? this.store.upsert(id, coord)`) is gone.
- All three dropped their `coord` parameter and read `entry.coord` instead, so "create this peer at
  coordinate X while scoring it" is no longer expressible. `applyContactFailure` dropped its `coord`
  too. Signatures are now `applyTouch(id)`, `applySuccess(id, latencyMs?)`, `applyFailure(id)`,
  `applyContactFailure(id)`.
- Every call site updated; the `await this.coordOf(id)` argument computations that became dead were
  deleted (`noteRpcFailure` x2, `probeNeighborLatency` x2, `probeMembership`, the `routeAct` forward
  arm's `nextCoord`). `coordOf` itself is kept — `peer:connect` still needs it for its `upsert`, and
  `peer:disconnect` for `isNearNeighbor` / `announceOnDeparture`.
- Doc comments on all three state that scoring never creates and point at `noteDiscovered`.

Verified during that run:

- `DigitreeStore.update` (`src/store/digitree-store.ts:307`) returns early on a missing id, and
  `setState` / `setMembership` delegate to it; `remove` (`:322`) returns early too. So the
  guard-free sibling helpers were already safe and **no store change was needed**.
- `npx tsc --noEmit` passes.
- `test/churn.leave.spec.ts`, `test/rpc.snapshot-merge-cap.spec.ts`, `test/failure-recovery.spec.ts`
  and `test/dead-state.spec.ts` — 97 tests — all pass against the changed source. Note this means
  the stale `churn.leave` workaround assertion still passes; it asserts the *weaker* thing, which is
  exactly why it needs rewriting below.

### What is left

**`test/churn.leave.spec.ts` (~line 370)** carries a workaround comment saying the departed peer
"may be re-added", and asserts on service health instead of store contents. Replace it with the real
assertion: after a graceful leave **plus** the disconnect that follows, the departed peer is absent
from `getStore()`. Remove the stale `backlog/debt-scoring-resurrects-removed-peers` reference in that
comment. Confirm the new assertion fails when the `?? this.store.upsert(...)` arm is temporarily put
back, so the test is shown to bite rather than assumed to.

**Three new tests** (place them wherever the suite's scoring behavior already lives, or a new
`test/scoring-never-creates.spec.ts`):

- *Scoring an unknown id creates nothing.* For each of the three helpers against an id not in the
  store: `store.size()` unchanged, `getById(id)` still undefined, no throw. The helpers are private,
  so drive them through their real call sites (a `peer:disconnect` for `applyFailure`, a ping
  outcome for `applySuccess`, an announce merge for `applyTouch`) rather than reaching in — a test
  that casts to `any` to call them pins the shape, not the behavior.
- *Scoring an existing entry is unaffected.* Same relevance / counter outcomes as before for a peer
  that is present. This is a regression guard on the arm the source change did not touch.
- *Removal during a probe.* Remove the entry between selecting a probe target and scoring its
  outcome; assert the peer stays absent and nothing throws. `test/helpers/maintenance-rig.ts` is the
  rig for driving a pooled maintenance pass.

**`test/rpc.snapshot-merge-cap.spec.ts` (~line 137)** has a comment reasoning explicitly about
`applyTouch` opening with `getById(id) ?? upsert(id, coord)`. That reasoning is now wrong. The
announce path upserts `from` explicitly one line earlier, so the counted `store.upsert` calls should
not change — the spec passed unchanged — but re-read the comment and correct it to describe the new
rule.

**`docs/fret.md`**: in *Relevance scoring and table management* (and the `accessCount` note under
*Relevance score calculation*), state that the scoring helpers never create an entry — a peer not in
the routing table is not scored — and that creation belongs to `noteDiscovered` and the explicit
insert sites.

### Edge cases the tests should keep in view

- **Peer evicted mid-tick.** `enforceCapacity` runs after the pooled tick's phase 1, so a peer can be
  selected as a probe target and then evicted before its outcome is scored. Scoring must be a silent
  no-op, not a throw and not a resurrection.
- **Concurrent scoring across a removal.** Two pooled tasks scoring the same peer with a
  `store.remove` landing between them: the second must no-op. Assert no throw.
- **Rediscovery still works.** A departed peer that genuinely comes back must reappear via each of
  `peer:connect`, `peer:identify`, an inbound RPC, and a neighbor snapshot naming it — none of those
  paths goes through the scoring helpers.
- **The `wasNear` computation at `peer:disconnect` is not a regression.** For a peer removed by
  `handleLeave` it is already `false` both before and after the change (the removal happens before
  the disconnect event). Do not "fix" it here.

## TODO

- Rewrite the `test/churn.leave.spec.ts` workaround into the real store-contents assertion; show it
  fails with the create-on-miss arm restored.
- Add the three new tests above.
- Correct the `applyTouch` comment in `test/rpc.snapshot-merge-cap.spec.ts`.
- Update `docs/fret.md` as described.
- Run `npx tsc --noEmit` and the full `yarn test` from `packages/fret` — the source half was only
  validated against four targeted specs, so the full suite has not yet run against it.
