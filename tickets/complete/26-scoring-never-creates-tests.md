description: Reviewed and completed the tests that lock in "recording a success or failure about a peer never re-adds that peer to the routing table" — the rule holds, one piece of leftover dead code was cleaned up, and the test comments now explain which parts of the rule are deliberately untested and why.
files: packages/fret/test/scoring-never-creates.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, packages/fret/test/churn.leave.spec.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
----

## What the rule is

`FretService`'s scoring helpers — `applyTouch`, `applySuccess`, `applyFailure`,
`applyContactFailure`, and `applyContactStrike` / `noteProofOfLife` / `noteAnsweredOnProtocol`
behind them — record bookkeeping *about* a peer. None may **create** a routing-table entry: each
opens with `const entry = this.store.getById(id); if (!entry) return;` and takes no coordinate
argument. Creation belongs to `noteDiscovered` and the explicit insert sites (`peer:connect`,
bootstrap seeding, `importTable`).

The concrete sequence the rule exists for: `handleLeave` drops a departing peer, its connection
closes a moment later, and the `peer:disconnect` listener's `applyFailure` used to bring it
straight back as an unclassified stranger that the classification pass then spent probes on.

The source change landed in an earlier ticket. The implement work reviewed here was **tests
only** — five tests in `packages/fret/test/scoring-never-creates.spec.ts`, diff range
`fe5c0c1..d8ac5d7`.

## Review findings

### Validation — passing

Run from `packages/fret`:

- `npx tsc --noEmit` — clean.
- `yarn test` — **1211 passing, 0 failing** (~3 min), re-run after every edit below.
- The five new tests all execute and pass.
- **Nothing pre-existing surfaced.** `tickets/.pre-existing-error.md` was not written and is not
  needed.

### Correctness — one finding, resolved as not-a-defect

**The `peer:disconnect` listener reads a coordinate for a peer that may not be in the table.**
Investigated as a possible correctness defect and it is not one. `isNearNeighbor` answers from the
store's ring window, so a peer the table never held is not in that walk, `wasNear` is `false`, and
`announceOnDeparture` never fires for a stranger. Separately confirmed that `DigitreeStore.update`
is a no-op on an id the store does not hold (`digitree-store.ts:307` opens
`const cur = this.getById(id); if (!cur) return;`), so `noteDisconnected`'s `store.setState(id, …)`
running *before* `applyFailure`'s guard can neither create an entry nor throw.

What remained was dead code, fixed below.

### Source hygiene — one finding, fixed inline (commit `852381e`)

`packages/fret/src/service/fret-service.ts`:

- The `peer:disconnect` listener no longer reads `await this.coordOf(id)` unconditionally. The read
  moved inside the `if (wasNear && !this.stopped)` branch — its only consumer — with a three-line
  comment recording why that is not a behaviour change (`wasNear` implies the peer is in the store,
  so `coordOf` returns the stored coord and never pays `hashPeerId`).
- `isNearNeighbor`'s dead `_coord` parameter is gone, along with the argument at its one call site.
  The parameter predated this ticket (`798c6bc`) and was already ignored.

Verified after the edit: `npx tsc --noEmit` clean, and the three touched specs plus
`churn.leave.spec.ts` green (69 passing) — including the two departure-announce tests, which
exercise the edited path rather than merely compiling it.

### Test quality — mutation-checked, two observations dispositioned

**The tests actually bite.** Removing `applyFailure`'s guard fails tests 1 and 2; removing
`applySuccess`'s fails test 4. The rule is pinned, not merely described.

Two things noticed and deliberately left alone:

- **`until()` returns silently on timeout** (spec line 38). Not a defect: every call site is
  followed by an assertion on the same predicate, so a timeout still fails the test. The one
  asymmetric site is line 115 (test 3), where the `until` is followed by a *dispatch* rather than an
  assertion — a failed `peer:connect` there still fails the test, but two seconds later and with a
  message about `applyFailure` rather than about the missing precondition. Diagnosis quality on a
  path that cannot silently pass. Not worth a code change; not worth a ticket.
- **Line 148 asserts `rig.store.size()` is 0.** Verified this is a deliberate rig property, not an
  accident: `buildMaintenanceRig` (`test/helpers/maintenance-rig.ts`) never starts the service — its
  header comment at lines 22–24 says so outright — and self is seeded into the store by `start()`.
  The assertion depends on nothing incidental.

### Coverage — one gap closed by comment, one carried forward

**`applyContactStrike` and `noteProofOfLife` are unexercised by the new spec, and correctly so.**
Traced every call site rather than assuming:

- `applyContactStrike` has exactly **one** caller, `applyContactFailure`, which reaches it *past*
  `applyFailure`'s guard — so its own guard is what carries the rule on that path — but only ever
  for an id `applyContactFailure` was handed, and those all come from store-derived probe targets.
- `noteProofOfLife` has **four** callers, none of which can present an absent id: `applySuccess`
  calls it from inside its own guard; `noteInboundRpc` upserts one line before
  (`fret-service.ts:959`); the `peer:connect` listener upserts at `:1037` before calling it at
  `:1042`; and `noteAnsweredOnProtocol` is only reached from an RPC outcome whose target came out of
  the store.

Both guards are therefore the same defence-in-depth against a mid-flight removal that `applyTouch`'s
arm is — not a real coverage hole. **Recorded as a spec-header comment** extending the existing NOTE
in `test/scoring-never-creates.spec.ts`, so the next reviewer meets the reasoning at the file rather
than re-deriving it. No test added, no ticket filed.

### Documentation — checked, no change needed

Read every section of `docs/fret.md` that names a scoring helper, `noteDiscovered`, or
`peer:disconnect` (lines 33–38, 72, 74, 77, 80, 90, 92, 265, 271, 290). The *Relevance scoring and
table management* section already states the never-create rule correctly at lines 35–38, and **no
other section implies create-on-miss**. Run 3's source edit needs no doc change: the doc describes
the `peer:disconnect` path's *behaviour* (lines 80, 92), which is unchanged, and never described the
`coordOf` call at that granularity.

### Tripwires (recorded, not filed as tickets)

- **Timing-shaped assertions in the new spec.** Tests 1 and 2 sleep 100 ms then assert an
  *absence*; test 4 relies on `sleep(30)` landing inside a 120 ms held stub reply
  (`rig.rig.holdMs = 120`). Fine now. If one ever flakes, widening the window is the fix — loosening
  the assertion is not. Parked in the spec's own structure; the tests read as timing-dependent at
  the call site.
- **`applyTouch`'s never-create arm is unreachable through any real call site.** Both callers
  (`peer:connect`, `mergeAnnounceSnapshot`) upsert synchronously immediately before scoring, so the
  entry provably exists by the time the guard runs. Deliberately untested on that arm; the spec
  header comment (lines 24–30) states it. Do not file a coverage finding against it without first
  showing a caller that can present an absent id. The same one-line rule now covers
  `applyContactStrike` and `noteProofOfLife` — see *Coverage* above.

### Known coverage gap carried forward

The `churn.leave.spec.ts` sibling test was never written: a real leave notice and a real
`peer:disconnect` for the same peer, in one sequence, against **one started receiver service**.
Test 2 of the new spec covers the disconnect half but reaches removal via `store.remove` rather than
via `handleLeave`.

Dispositioned as a **tripwire, not a ticket**: it is a second route into an already-covered rule,
and the guard it would exercise is the same one tests 1 and 2 already pin by mutation. The gap is
recorded in prose at the `removes the departing peer from the id map and from the ring window` test
in `churn.leave.spec.ts`, which is where whoever writes it will be looking.

Hazard for that writer: a *started* service re-seeds from libp2p's peerStore every stabilization
tick, and a still-connected departing node is in that peerStore, so a tick landing between the leave
and the assertion legitimately re-admits the peer. Keep the sequence inside one tick interval, or
make the departing node undialable first. That re-seeding is production behaviour, not a defect.

### Empty categories, stated

- **No major findings.** Nothing warranted a new `fix/`, `plan/`, or `backlog/` ticket. The one
  correctness question raised (the `peer:disconnect` coordinate read) resolved to dead code, which
  was fixed in this pass rather than filed.
- **No accepted-tradeoff `NOTE:` was overridden.** None of the sites touched carries one.
- **No pre-existing test failures.** The suite is fully green at HEAD and after every edit.

## Work done in this ticket

- Validated the implement-stage tests: typecheck, full suite, mutation-checked that the tests bite.
- Fixed the vestigial `coordOf` read and the dead `_coord` parameter in
  `packages/fret/src/service/fret-service.ts` (commit `852381e`).
- Extended the spec header NOTE in `test/scoring-never-creates.spec.ts` to explain why
  `applyContactStrike` and `noteProofOfLife` have no arms of their own.
- Confirmed `docs/fret.md` already reflects the rule; no change needed.
