description: Finish the code-review pass on the new tests that lock in "recording a success or failure about a peer never re-adds that peer to the routing table" — the main thing left is running the whole test suite once.
prereq:
files: packages/fret/test/scoring-never-creates.spec.ts, packages/fret/test/churn.leave.spec.ts, packages/fret/test/dead-state.spec.ts, packages/fret/src/service/fret-service.ts
difficulty: medium
----

<!-- resume-note -->
A prior review run hit `BUDGET_WARNING` after reading the implement diff and the source helpers,
before running any validation. This ticket carries the remainder. Nothing was edited in the working
tree by that run — `git status` was clean apart from `tickets/.in-progress`.

## What the rule under review is

`FretService`'s scoring helpers — `applyTouch`, `applySuccess`, `applyFailure`,
`applyContactFailure` (and `applyContactStrike` / `noteProofOfLife` / `noteAnsweredOnProtocol`
behind them) — record bookkeeping *about* a peer. None may **create** a routing-table entry: each
opens with `const entry = this.store.getById(id); if (!entry) return;` and takes no coordinate
argument. Creation belongs to `noteDiscovered` and the explicit insert sites (`peer:connect`,
bootstrap seeding, `importTable`). The source change landed in an earlier run; the implement work
under review is **tests only**.

## What the implement stage produced (already read, no findings raised against it yet)

Diff range `fe5c0c1..d8ac5d7`, `packages/fret/test/` only:

- `test/scoring-never-creates.spec.ts` (new, 162 lines) — five tests in two blocks: three driving a
  real `createMemNode` + **started** `FretService` through dispatched `peer:connect` /
  `peer:disconnect`, two driving `buildMaintenanceRig('core')`'s `stabilizeOnce()` with a held stub
  ping reply.
- `test/churn.leave.spec.ts` — one comment block rewritten (text only, no assertions touched).
- `test/dead-state.spec.ts` — call sites updated to the helpers' new no-coordinate signatures.

Read of `fret-service.ts:550-800` and the two node listeners at `~1031-1063` confirmed the guards
are present and consistent, and that `applyContactStrike` / `noteProofOfLife` carry the same
`if (!e) return` shape.

## Work remaining in this ticket

- **Run the full suite in the foreground with no redirection**: `cd packages/fret && yarn test`.
  It has never been run against this work. Also `cd packages/fret && npx tsc --noEmit`.
  `test/dead-state.spec.ts`'s edited call sites have been type-checked but never executed.
  Report anything unrelated through the `.pre-existing-known.md` / `.pre-existing-error.md`
  protocol — never skip or loosen a test.
- **Finish the adversarial pass** over the three test files: happy path / edge / error / regression
  / interaction coverage, source hygiene, and whether `docs/fret.md` still matches (the
  *Relevance scoring and table management* section already describes the never-create rule; confirm
  no other section still implies create-on-miss).
- **Produce the `complete/` ticket** with a `## Review findings` section — what was checked, what
  was found, what was done, empty categories stated explicitly with a reason.

## Open observation to resolve (not yet a finding)

`peer:disconnect` (`fret-service.ts:1053-1062`) computes `const coord = await this.coordOf(id)`
before `applyFailure`, and `coordOf` falls back to `hashPeerId` when the table holds no entry. So a
disconnect for a peer we never held still pays a SHA-256, then runs `isNearNeighbor(id, coord)` and
may fire `announceOnDeparture` for a peer that was never in the routing table. Decide whether that
is intended (the announce is *around a coordinate*, not about the entry) — if intended, it is at
most a tripwire `NOTE:`; if not, it is a finding. Do not file it without settling which.

## Known gaps carried forward from the implement handoff

- **The `churn.leave.spec.ts` sibling test was not written**: a real leave notice and a real
  `peer:disconnect` for the same peer, in one sequence, against **one started receiver service**.
  Test 2 of the new spec covers the disconnect half but reaches removal via `store.remove` rather
  than via `handleLeave`. Hazard for whoever writes it: a *started* service re-seeds from libp2p's
  peerStore every stabilization tick, and a still-connected departing node is in that peerStore, so
  a tick landing between the leave and the assertion legitimately re-admits the peer. Keep the
  sequence inside one tick interval, or make the departing node undialable first. That re-seeding
  is production behaviour, not a defect.
- **`applyTouch`'s never-create arm is unreachable through any real call site** and is deliberately
  untested on that arm — both callers (`fret-service.ts:1043` and `~1983`) `upsert` synchronously
  immediately before scoring. A header comment in the spec says so; do not file a coverage finding
  against it without first showing a caller that can present an absent id.
- **Timing-shaped assertions.** Tests 1 and 2 sleep 100 ms then assert an *absence*; test 4 relies
  on `sleep(30)` landing inside a 120 ms held reply. If one ever flakes, widening the window is the
  fix; loosening the assertion is not.

## Mutation evidence already gathered (do not redo unless you want to see it bite)

Each never-create test was shown to fail when its own guard is removed:

| Mutation (reverted afterwards) | Result |
|---|---|
| `applyFailure`: `getById(id) ?? this.store.upsert(id, await this.coordOf(id))` | tests 1 and 2 fail; 3, 4, 5 pass |
| `applySuccess`: same mutation | test 4 fails; 1, 2, 3, 5 pass |
