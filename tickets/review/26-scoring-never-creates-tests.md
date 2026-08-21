description: Finish the code-review pass on the new tests that lock in "recording a success or failure about a peer never re-adds that peer to the routing table" — the main thing left is running the whole test suite once.
prereq:
files: packages/fret/test/scoring-never-creates.spec.ts, packages/fret/test/churn.leave.spec.ts, packages/fret/test/dead-state.spec.ts, packages/fret/src/service/fret-service.ts
difficulty: medium
----

<!-- resume-note -->
Two prior review runs hit `BUDGET_WARNING` before running any validation. This ticket carries the
remainder. Neither run edited the working tree — `git status` is clean apart from
`tickets/.in-progress`. **Validation has still never been run against this work; that is the first
thing to do, not the last.**

## What the rule under review is

`FretService`'s scoring helpers — `applyTouch`, `applySuccess`, `applyFailure`,
`applyContactFailure` (and `applyContactStrike` / `noteProofOfLife` / `noteAnsweredOnProtocol`
behind them) — record bookkeeping *about* a peer. None may **create** a routing-table entry: each
opens with `const entry = this.store.getById(id); if (!entry) return;` and takes no coordinate
argument. Creation belongs to `noteDiscovered` and the explicit insert sites (`peer:connect`,
bootstrap seeding, `importTable`). The source change landed in an earlier run; the implement work
under review is **tests only**.

## What the implement stage produced

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

## Already settled — do not redo

**The `peer:disconnect` open observation is resolved: it is NOT a correctness defect.**
`isNearNeighbor` (`fret-service.ts:1912`) ignores its coordinate parameter entirely — the signature
is `(id: string, _coord: Uint8Array)` — and answers from the store's own ring window
(`ringNeighborsBothSides(...).includes(id)`). A peer the table never held is not in that walk, so
`wasNear` is `false` and `announceOnDeparture` never fires for a peer that was never in the routing
table. The earlier worry that a disconnect could announce around a stranger's coordinate is wrong.

The **residual** is hygiene, not correctness, and is the one open finding: `const coord = await
this.coordOf(id)` at `fret-service.ts:1055` is now vestigial on that path. Its only consumer is
`announceOnDeparture` inside the `wasNear` branch, and `wasNear === true` implies the entry is in
the store — where `coordOf` returns `entry.coord` without hashing. So the `hashPeerId` fallback
inside `coordOf` is only ever paid on a disconnect whose result is provably discarded. `applyFailure`
was that coordinate's last real consumer on this path, and this ticket's source change removed it.
(The unused `_coord` parameter itself predates this ticket — introduced by commit `798c6bc`.)

Suggested minimal inline fix (a *minor* finding — fix it in this pass, do not file a ticket):

```ts
const wasNear = this.isNearNeighbor(id);
this.noteDisconnected(id);
await this.applyFailure(id);
if (wasNear && !this.stopped) {
	this.detach(this.announceOnDeparture(id, await this.coordOf(id)), 'announceOnDeparture');
}
```

plus dropping the dead `_coord` parameter from `isNearNeighbor` and its one call site. Neither
`noteDisconnected` nor `applyFailure` mutates `entry.coord`, so moving the read after them is not a
behaviour change. Note `handleLeave` (`fret-service.ts:1828`) is a *different* call site of
`announceOnDeparture` and legitimately needs its own hashed coordinate — leave it alone.

## Work remaining

- **Run validation first, in the foreground with no redirection**: `cd packages/fret && yarn test`,
  and `cd packages/fret && npx tsc --noEmit`. `test/dead-state.spec.ts`'s edited call sites have
  been type-checked but never executed. Report anything unrelated through the
  `.pre-existing-known.md` / `.pre-existing-error.md` protocol — never skip or loosen a test.
- **One unfinished check, cheap**: confirm `DigitreeStore.update` is a no-op on an id the store does
  not hold (`src/store/digitree-store.ts`). `noteDisconnected` calls `store.setState(id, ...)` →
  `this.update(id, { state })` *before* `applyFailure`'s guard runs, so if `update` creates or
  throws on a missing id, the never-create rule has a hole in the very listener the new spec drives.
  The spec's first test asserts `store.size()` is unchanged after a disconnect for an unheld peer,
  so a *creating* `update` would already fail that test — but confirm by reading, since the test has
  never been executed.
- **Finish the adversarial pass** over the three test files: happy path / edge / error / regression
  / interaction coverage, source hygiene, and whether `docs/fret.md` still matches (the
  *Relevance scoring and table management* section already describes the never-create rule; confirm
  no other section still implies create-on-miss).
- **Apply the minor fix above**, then re-run the suite.
- **Produce the `complete/` ticket** with a `## Review findings` section — what was checked, what
  was found, what was done, empty categories stated explicitly with a reason. Carry the resolved
  open observation and the vestigial-`coordOf` finding into it.

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
