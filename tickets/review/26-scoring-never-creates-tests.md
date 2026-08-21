description: Finish the code-review pass on the new tests that lock in "recording a success or failure about a peer never re-adds that peer to the routing table" — validation and the one code fix are done and committed, so what remains is one coverage question, a docs check, a full-suite re-run, and writing up the result.
prereq:
files: packages/fret/test/scoring-never-creates.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, packages/fret/test/churn.leave.spec.ts, packages/fret/test/dead-state.spec.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: medium
----

<!-- resume-note -->
Fourth run. Runs 1–2 hit `BUDGET_WARNING` before running anything. Run 3 ran the validation and
applied the one open fix. **Run 4 (this one) read the spec and the rig, resolved two of the three
open read-through items, and hit `BUDGET_WARNING` before the docs check and the suite re-run.**

**Correction to the previous resume note: the working tree is clean.** That note said run 3's
source edit was uncommitted. It is not — the runner committed it as `852381e`
(`packages/fret/src/service/fret-service.ts`, 12 lines). `git status` shows only the untracked
`tickets/.in-progress`. Nothing is pending in the tree; do not go looking for it.

## What the rule under review is

`FretService`'s scoring helpers — `applyTouch`, `applySuccess`, `applyFailure`,
`applyContactFailure` (and `applyContactStrike` / `noteProofOfLife` / `noteAnsweredOnProtocol`
behind them) — record bookkeeping *about* a peer. None may **create** a routing-table entry: each
opens with `const entry = this.store.getById(id); if (!entry) return;` and takes no coordinate
argument. Creation belongs to `noteDiscovered` and the explicit insert sites (`peer:connect`,
bootstrap seeding, `importTable`). The source change landed in an earlier run; the implement work
under review is **tests only** (diff range `fe5c0c1..d8ac5d7`, `packages/fret/test/` only).

## Validation — DONE in run 3, all green

Run from `packages/fret`:

- `npx tsc --noEmit` — clean.
- `yarn test` — **1211 passing, 0 failing** (~3 min). Log at
  `tickets/.logs/26-scoring-never-creates-tests.test.log`.
- The five new tests all executed and passed. Nothing pre-existing surfaced;
  `tickets/.pre-existing-error.md` was **not** written and does not need to be.
- After run 3's source edit: `npx tsc --noEmit` clean, and the three touched specs plus
  `churn.leave.spec.ts` green (**69 passing**), including the two departure-announce tests that
  exercise the edited path rather than merely compiling it.

**The full suite has not been re-run since that edit.** Still the first item under *Work remaining*.

## The fix that landed (commit `852381e`)

`packages/fret/src/service/fret-service.ts` — the one open minor finding, fixed inline:

- The `peer:disconnect` listener no longer reads `await this.coordOf(id)` unconditionally; the read
  moved inside the `if (wasNear && !this.stopped)` branch, its only consumer, with a three-line
  comment recording why that is not a behaviour change.
- `isNearNeighbor`'s dead `_coord` parameter is gone, along with the argument at its one call site.
  The parameter predates this ticket (`798c6bc`) and was already ignored.

## Already settled — do not redo

- **The `peer:disconnect` open observation is NOT a correctness defect.** `isNearNeighbor` answers
  from the store's ring window, so a peer the table never held is not in that walk, `wasNear` is
  `false`, and `announceOnDeparture` never fires for a stranger. The only residual was the
  vestigial `coordOf`, fixed above.
- **`DigitreeStore.update` is a no-op on an id the store does not hold** (`digitree-store.ts:307`
  opens `const cur = this.getById(id); if (!cur) return;`). So `noteDisconnected`'s
  `store.setState(id, ...)` before `applyFailure`'s guard cannot create or throw.
- **Mutation evidence** was gathered in an earlier run: removing `applyFailure`'s guard fails tests
  1 and 2; removing `applySuccess`'s fails test 4.
- **Line 148's `rig.store.size()` is 0 — deliberate rig property, verified this run.**
  `buildMaintenanceRig` (`test/helpers/maintenance-rig.ts`) never starts the service; the header
  comment at lines 22–24 states that outright ("The service is never started"), and self is seeded
  into the store by `start()`. So the assertion is not accidentally depending on anything. **No
  finding; nothing to write up beyond one line in the complete ticket.**
- **`until()`'s silent timeout (spec line 38) — dispositioned this run as no finding.** Every call
  site is followed by an assertion on the same predicate, so a timeout still fails the test. The
  one asymmetric site is line 115 (test 3), where the `until` is followed by a *dispatch* rather
  than an assertion: a failed `peer:connect` there still fails the test, but two seconds later and
  at line 122 with a message about `applyFailure` rather than about the missing precondition. That
  is diagnosis quality on a path that cannot silently pass — **not worth a code change and not
  worth a ticket**; record it as one line in the complete ticket's findings and move on.

## Work remaining

- **Answer the last coverage question:** `applyContactStrike` (`fret-service.ts:717`) and
  `noteProofOfLife` (`:750`) each carry the same `if (!e) return` guard and neither is exercised by
  the new spec. **The call-site grep is already done — do not re-run it.** Results:
  - `applyContactStrike` has exactly **one** caller: `applyContactFailure` (`:698`), which calls
    `applyFailure(id)` (guarded, returns early on a miss) and then calls `applyContactStrike(id)`
    *unconditionally*. So its own guard is the one that carries the never-create rule on that path.
  - `noteProofOfLife` has **four** callers: `applySuccess` (`:660`, inside that method's own
    guard), `noteAnsweredOnProtocol` (`:786`), `noteInboundRpc` (`:962`), and the `peer:connect`
    listener (`:1042`, immediately before `applyTouch` at `:1043`).
  - What is left to decide: whether `noteAnsweredOnProtocol` (`:784`) and `noteInboundRpc` (`:962`)
    can be reached with an id the store does not hold, and whether `peer:connect` upserts before
    `:1042`. Read `fret-service.ts:780–800`, `:955–970`, and `:1030–1060` — three short ranges, no
    exploration needed. If none can present an absent id, both belong in the same header NOTE that
    already excuses `applyTouch`'s arm (spec lines 24–30) — a one-line spec-comment edit. If one
    can, that is a real coverage finding: add a test rather than a note.
- **Check `docs/fret.md`.** The *Relevance scoring and table management* section already states the
  never-create rule correctly. Not yet checked: whether any other section still implies
  create-on-miss. The doc does not describe the `peer:disconnect` `coordOf` call at that
  granularity, so run 3's edit almost certainly needs no doc change — confirm, don't assume.
- **Re-run the full suite** (`cd packages/fret && yarn test`, foreground, no redirection). Expect
  1211 passing. Do this last, after any spec-comment edit above.
- **Produce the `complete/` ticket** with a `## Review findings` section: what was checked, what was
  found, what was done, empty categories stated explicitly with a reason. It must carry forward:
  the resolved `peer:disconnect` observation, the fixed vestigial-`coordOf` finding (commit
  `852381e`), the confirmed `DigitreeStore.update` no-op, the two items dispositioned this run
  (`until()`'s timeout, the rig's zero size), the validation numbers, and the tripwires below.

## Tripwires to record in the complete ticket (do NOT file as tickets)

- **Timing-shaped assertions in the new spec.** Tests 1 and 2 sleep 100 ms then assert an
  *absence*; test 4 relies on `sleep(30)` landing inside a 120 ms held stub reply
  (`rig.rig.holdMs = 120`). Fine now. If one ever flakes, widening the window is the fix; loosening
  the assertion is not.
- **`applyTouch`'s never-create arm is unreachable through any real call site** and is deliberately
  untested on that arm — both callers `upsert` synchronously immediately before scoring. The spec
  header comment (lines 24–30) says so; do not file a coverage finding against it without first
  showing a caller that can present an absent id.

## Known gap carried forward from the implement handoff

The `churn.leave.spec.ts` sibling test was not written: a real leave notice and a real
`peer:disconnect` for the same peer, in one sequence, against **one started receiver service**.
Test 2 of the new spec covers the disconnect half but reaches removal via `store.remove` rather
than via `handleLeave`. The gap is already recorded in prose in `churn.leave.spec.ts` at the
`removes the departing peer from the id map and from the ring window` test. Hazard for whoever
writes it: a *started* service re-seeds from libp2p's peerStore every stabilization tick, and a
still-connected departing node is in that peerStore, so a tick landing between the leave and the
assertion legitimately re-admits the peer. Keep the sequence inside one tick interval, or make the
departing node undialable first. That re-seeding is production behaviour, not a defect.
Disposition this in the complete ticket — a coverage gap in an already-covered rule, so a tripwire
or a `debt-` backlog ticket, not a blocker.
