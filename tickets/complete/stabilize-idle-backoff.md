description: FRET's background upkeep ran every 1.5 seconds forever, even when nothing in the network had changed for minutes, keeping idle phones busy. The interval now doubles while things are stable, up to a host-settable ceiling (60 s by default), and snaps back to 1.5 s the moment anything changes. Implemented and reviewed; the review found and fixed one interaction defect that silently disabled the earlier near-exchange savings for hosts that turn backoff off and during active mode.
architecture: docs/fret.md#stabilization-and-churn-handling
files: packages/fret/src/service/idle-backoff.ts, packages/fret/src/service/fret-service.ts (startStabilizationLoop, wakeLoop, noteChange, runStabilizationPass, probeAndFetch, handleLeave, the change seams), packages/fret/src/index.ts (FretConfig.maxPassiveIntervalMs), packages/fret/src/service/near-exchange.ts, packages/fret/test/idle-backoff.spec.ts, packages/fret/test/near-exchange.spec.ts, packages/fret/test/address-less-departure.spec.ts, packages/fret/test/service-lifecycle.spec.ts, docs/fret.md, AGENTS.md
difficulty: hard
----
Reported as gotchoices/Fret#2 (suggestion 1). Builds on `stabilize-skip-redundant-near-exchange` (each idle pass cheap); this makes idle passes rare. Implemented in `ticket(implement): stabilize-idle-backoff`; reviewed here.

## What shipped

- **`IdleBackoff`** (`src/service/idle-backoff.ts`): a clock-free policy — base 1.5 s, cap `max(maxPassiveIntervalMs, base)`, delay doubles after every quiet pass, snaps to the base on a change (monotonic counter snapshotted at `beginPass`, compared at `endPass`), holds at the base while a pass left work pending. A cap at or below the base is the off switch. Review added `backedOff` (delay above the base) as the per-pass "was this pass delayed" predicate.
- **Service wiring**: `PASSIVE_INTERVAL_MS` / `ACTIVE_INTERVAL_MS` statics, `FretConfig.maxPassiveIntervalMs` (default 60 000, validated like `dialTimeoutMs`), a per-run arming closure the loop and `wakeLoop` both arm through, `runStabilizationPass` bracketing the pass, `diag.loop` (`delayMs`, `quietPasses`), fourteen change seams routed through one `noteChange(reason)` that also logs the reason.
- **Two policy rules beyond the plan**, both forced by measured integration regressions: a backed-off pass never consults the near-exchange probe skip (the skip cap, counted in passes, otherwise stretched a fresh ring's first snapshot exchange to 22.5 s), and a skipped near probe marks the pass pending (the ladder starts only from a pass that actually verified its neighbours).
- **Docs**: the *passive interval backs off* bullet group under *Stabilization and churn handling*, restated departure / near-exchange / foreign-arm numbers, *Configuration*, A6; `AGENTS.md` layout.

## Review findings

**Read first**: the implement diff (`git show` of `ticket(implement): stabilize-idle-backoff`), then the handoff. Then `tsc --noEmit`, the full suite (1331 passing before review edits, 1333 after; log at `tickets/.logs/stabilize-idle-backoff.review.test.log`), and the targeted specs after each edit.

**Checked**: the loop's arming/wake path (timer nulled before the pass opens, `wakeLoop` never extends a timer, a stale closure refuses on generation); every change seam's guard against the "deliberately not a change" list in the docs (dead-arm strikes, settled proof of life, negotiate strikes at the threshold, repeated mentions, identical address answers); the two policy rules against the ladder; `stop()` / `start()` reset ordering; the off-switch and active-mode configurations; the test rigs' use of private state; all touched docs and the near-exchange comment.

**Found and fixed inline (minor, one real defect among them):**

- **The no-stacking rule keyed on `quietPasses === 0`, which is the wrong predicate under the off switch and in active mode.** With `maxPassiveIntervalMs` at or below the base the delay never leaves the base but the quiet count still climbs, so after one quiet pass the near-exchange probe skip was never consulted again — every 1.5 s pass pinged every neighbour, undoing the previous ticket's fix for exactly the host that opted out of this one. Active mode had the same shape: its 300 ms passes drove the ladder (which the loop ignores), so the skip died there too and `diag.loop.delayMs` read 60 000 while the loop ran at 300 ms. Fix: `probeAndFetch` keys on `IdleBackoff.backedOff` (delay above the base), and `runStabilizationPass` drives the ladder only for passive passes (`setMode` is a change in both directions, so passive re-enters at the base). Reproduced before the fix and pinned by two new cases in `test/near-exchange.spec.ts` that drive the loop's pass body (not the bare tick, which bypasses the ladder — which is why the existing reproduction case could not see this) under each configuration; both reddened against the unfixed code.
- **A pass that outlived its run could arm, and report into, the next run.** The tick's `finally` armed through `this.armLoop`, which after a `stop()` → `start()` during the pass is the *new* run's closure and accepts, so a timer from a finished run could overlap the new run's own first pass; and the stale pass's `endPass` would overwrite the reset `start()` had just done. Fix: the tick arms through its own run's closure (same generation guard), and `runStabilizationPass` returns without `endPass` or `diag.loop` writes when the generation moved. Not pinned: the window is `stop()` without `await` followed by `start()`, and the existing lifecycle specs pin the mid-tick stop already.
- **A leave notice from a peer the table does not hold counted as a change.** It creates nothing (the docs say so), and any replacement it names counts for itself through `noteDiscovered`. Moved the seam inside the held-entry arm; docs updated.
- **Off-by-one in prose**: "the seventh quiet pass reaches the cap" — it is the sixth (1.5 + 3 + 6 + 12 + 24 + 48 = 94.5 s). Fixed in `idle-backoff.ts` and `docs/fret.md`.
- `AGENTS.md`'s two size claims for `fret-service.ts` said ~4100; measured 4650 (`wc -l packages/fret/src/service/fret-service.ts`). Updated.

**Considered and left as is:**

- **Where the two policy rules live.** The handoff asked whether they belong in `NearExchange.canSkipProbe` with the quiet count passed in. No: `NearExchange` knows passes, `IdleBackoff` knows delays, and the coupling between two policy objects is the service's — `probeAndFetch` already owns rule 1 (connectedness) for the same reason. Keeping both modules loop-unaware is what made the fix above a one-line predicate swap.
- **No `try/finally` around `endPass`.** A throw inside the pass leaves the ladder where it was and the loop re-arms from the live delay; that is the conservative outcome, and nothing in `stabilizeOnce`'s reachable paths throws past its own catch.
- **`noteChange` logs every change, even when already at the base.** The line's job is to show what keeps a phone awake, and a seam that fires while already at the base is still that evidence. Debug-gated.
- **`ingestAddressHints` can note a change twice for one record** (the dialability flip in `setAddressKnown`, then the explicit "newer record"). Two debug lines, one reset; not worth a flag.
- **The dead-peer plateau at ~24 s rather than 60 s** for a ring holding a permanently off-ring entry: the implement pass left a `NOTE:` with the exact change at the pending site in `stabilizeOnce`; the docs carry the arithmetic. Tripwire, not a ticket.
- **Size of `fret-service.ts` (4650 lines).** Standing debt the project acknowledges in `AGENTS.md`; the two previous reviews recorded it rather than filing, and nothing here changes the extraction economics. Recorded, not filed.

**Tests.** The implementer's six `IdleBackoff` cases each pin one rule and none restates the implementation; the near-exchange backoff case pins the service-level climb and a single-side reset with a non-vacuity check on pings; the departure case pins the wake path against a started loop, mutation-checked. None cut. Added: the two near-exchange cases above (off switch, active mode), one shared helper, no sleeps.

**Tripwires recorded**: none new beyond the `NOTE:` at the phase-2 pending site, which stands.

**Major / tickets filed: none.** The defect found was fixed inline; no class-level invariant was left open.

## Verification

`cd packages/fret && npx tsc --noEmit && yarn test` — 1333 passing, 0 failing.
