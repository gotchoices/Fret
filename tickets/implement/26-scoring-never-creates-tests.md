description: The routing-table code no longer re-adds a peer when recording a success or failure about it; the tests and design doc that describe the old behavior still need updating, and new tests are needed to lock the new rule in.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/churn.leave.spec.ts, packages/fret/test/rpc.snapshot-merge-cap.spec.ts, docs/fret.md
difficulty: easy
----

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
