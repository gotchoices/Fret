description: Finish the code-review pass on the new tests that lock in "recording a success or failure about a peer never re-adds that peer to the routing table" — validation now passes and a small cleanup has landed, so what remains is the last read-through and writing up the result.
prereq:
files: packages/fret/test/scoring-never-creates.spec.ts, packages/fret/test/churn.leave.spec.ts, packages/fret/test/dead-state.spec.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: medium
----

<!-- resume-note -->
Third run. Two earlier runs hit `BUDGET_WARNING` before running anything; **this run ran the
validation and applied the one open fix**, then hit `BUDGET_WARNING` partway through the final
read-through. The working tree now carries an edit of mine — see *What this run changed* — so it is
no longer clean. Do not revert it.

## What the rule under review is

`FretService`'s scoring helpers — `applyTouch`, `applySuccess`, `applyFailure`,
`applyContactFailure` (and `applyContactStrike` / `noteProofOfLife` / `noteAnsweredOnProtocol`
behind them) — record bookkeeping *about* a peer. None may **create** a routing-table entry: each
opens with `const entry = this.store.getById(id); if (!entry) return;` and takes no coordinate
argument. Creation belongs to `noteDiscovered` and the explicit insert sites (`peer:connect`,
bootstrap seeding, `importTable`). The source change landed in an earlier run; the implement work
under review is **tests only** (diff range `fe5c0c1..d8ac5d7`, `packages/fret/test/` only).

## Validation — DONE this run, all green

Run from `packages/fret`:

- `npx tsc --noEmit` — clean.
- `yarn test` — **1211 passing, 0 failing** (~3 min). Log at
  `tickets/.logs/26-scoring-never-creates-tests.test.log`.
- The five new tests all executed and passed (they had never been run before this):
  `Scoring never creates a routing-table entry` → `does not re-admit a peer the table has never
  held`, `does not resurrect a peer that was removed while connected`, `still scores a peer the
  table does hold`, `does not resurrect a peer removed while its ping is in flight`, `still scores
  a peer that is present when its ping completes`.
- Nothing pre-existing surfaced; `tickets/.pre-existing-error.md` was **not** written and does not
  need to be.

## What this run changed (uncommitted, in the working tree)

`packages/fret/src/service/fret-service.ts` — the one open minor finding, fixed inline as the
review stage requires:

- The `peer:disconnect` listener no longer reads `await this.coordOf(id)` unconditionally. The read
  moved inside the `if (wasNear && !this.stopped)` branch, which is its only consumer. A three-line
  comment at the site records why that is not a behaviour change (`wasNear` implies the entry is in
  the store, so `coordOf` returns `entry.coord` and never pays `hashPeerId`; neither
  `noteDisconnected` nor `applyFailure` mutates `entry.coord`).
- `isNearNeighbor`'s dead `_coord` parameter is gone, along with the argument at its one call site.
  The parameter predates this ticket (introduced by `798c6bc`) and was already ignored — the method
  answers from the store's own ring window via `ringNeighborsBothSides`.

Validated after the edit: `npx tsc --noEmit` clean, and the three touched specs plus
`churn.leave.spec.ts` run green (**69 passing**) — which includes `announces at most one debounced
burst per departing peer` and `clamps the departure burst to announceFanout when more neighbors are
eligible`, i.e. the departure-announce path the edit sits on is exercised, not merely compiled.

**The full suite has not been re-run since this edit.** That is the first item below.

## Already settled — do not redo

- **The `peer:disconnect` open observation is NOT a correctness defect.** `isNearNeighbor` answers
  from the store's ring window, so a peer the table never held is not in that walk, `wasNear` is
  `false`, and `announceOnDeparture` never fires for a stranger. The only residual was the
  vestigial `coordOf`, now fixed above.
- **`DigitreeStore.update` is a no-op on an id the store does not hold** — `digitree-store.ts:307`
  opens `const cur = this.getById(id); if (!cur) return;`. So `noteDisconnected`'s
  `store.setState(id, ...)` → `update(id, {state})` before `applyFailure`'s guard cannot create or
  throw. This was the ticket's one unfinished cheap check; it is done, and there is no hole.
- **Mutation evidence** was gathered in an earlier run and need not be redone: removing
  `applyFailure`'s guard fails tests 1 and 2; removing `applySuccess`'s fails test 4.

## Work remaining

- **Re-run the full suite** (`cd packages/fret && yarn test`, foreground, no redirection) to
  confirm the source edit above is clean beyond the four specs already re-run. Expect 1211 passing.
- **Finish the adversarial read-through of `test/scoring-never-creates.spec.ts`.** Partly done;
  what was observed so far, none of it yet dispositioned:
  - `until()` (line 38) **returns silently on timeout** rather than throwing. Every call site is
    followed by an assertion on the same predicate, so a timeout still fails the test — except at
    line 115 (test 3), where the `until` is followed by a *dispatch* rather than an assertion. If
    `peer:connect` failed to create the entry there, the test still fails, but two seconds later
    and at line 122 with a message about `applyFailure` rather than about the missing precondition.
    Cosmetic diagnosis quality, not a coverage hole — decide whether it is worth a line.
  - Line 148 asserts `rig.store.size()` is exactly `0` after removing the one seeded peer, which
    means the maintenance rig does not seed self into the store. Confirm that is a deliberate rig
    property (read `test/helpers/maintenance-rig.ts`) rather than something the assertion is
    accidentally depending on.
  - **Coverage question not yet answered:** `applyContactStrike` (`fret-service.ts:717`) and
    `noteProofOfLife` (`:750`) each carry the same `if (!e) return` guard and neither is exercised
    by this spec. Decide whether either has a caller that can present an absent id — if not, they
    belong in the same header NOTE that already excuses `applyTouch`'s arm; if one does, that is a
    coverage finding.
- **Check `docs/fret.md`.** The *Relevance scoring and table management* section already states the
  never-create rule correctly. Not yet checked: whether any other section still implies
  create-on-miss, and whether the doc's description of the `peer:disconnect` path needs to reflect
  the `coordOf` move (probably not — the doc does not describe that call at that granularity).
- **Produce the `complete/` ticket** with a `## Review findings` section: what was checked, what was
  found, what was done, empty categories stated explicitly with a reason. It must carry forward the
  resolved `peer:disconnect` observation, the fixed vestigial-`coordOf` finding, the confirmed
  `DigitreeStore.update` no-op, the validation numbers above, and the tripwires below.

## Tripwires to record in the complete ticket (do NOT file as tickets)

- **Timing-shaped assertions in the new spec.** Tests 1 and 2 sleep 100 ms then assert an
  *absence*; test 4 relies on `sleep(30)` landing inside a 120 ms held stub reply. Fine now. If one
  ever flakes, widening the window is the fix; loosening the assertion is not.
- **`applyTouch`'s never-create arm is unreachable through any real call site** and is deliberately
  untested on that arm — both callers `upsert` synchronously immediately before scoring. A header
  comment in the spec says so; do not file a coverage finding against it without first showing a
  caller that can present an absent id.

## Known gap carried forward from the implement handoff

The `churn.leave.spec.ts` sibling test was not written: a real leave notice and a real
`peer:disconnect` for the same peer, in one sequence, against **one started receiver service**.
Test 2 of the new spec covers the disconnect half but reaches removal via `store.remove` rather
than via `handleLeave`. Hazard for whoever writes it: a *started* service re-seeds from libp2p's
peerStore every stabilization tick, and a still-connected departing node is in that peerStore, so a
tick landing between the leave and the assertion legitimately re-admits the peer. Keep the sequence
inside one tick interval, or make the departing node undialable first. That re-seeding is
production behaviour, not a defect. Disposition this in the complete ticket — it is a coverage gap
in an already-covered rule, so a tripwire or a `debt-` backlog ticket, not a blocker.
