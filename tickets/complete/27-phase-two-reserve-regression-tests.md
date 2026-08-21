description: Added tests proving that one stalled near neighbor can no longer eat a whole background maintenance cycle, and tightened the timing bound so the tests actually fail when the guard is removed.
files: packages/fret/test/stabilize-concurrency.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
---

## What shipped

Three regression cases in `packages/fret/test/stabilize-concurrency.spec.ts`, under a
`// ----- phase-2 reserve -----` heading, plus one review-pass fix to their timing bound and two
documentation corrections. **No production code changed** — both mechanisms these tests pin were
already live in `fret-service.ts` from the earlier `tick-budget-starves-phase-two` work.

The cases:

- **Core and Edge** (sharing an `expectPhaseTwoKeepsItsTurn()` helper): a near peer that answers its
  cheap ping and then stalls the neighbor-snapshot fetch still leaves the classification arm and the
  dead-re-probe arm their turn — on that tick *and* on the next one. The second tick is the half
  that matters: such a peer accrues no contact failures, so it is never marked dead, so it returns
  to the near list and stalls again every tick. Both run at the **unmutated** shipped constants,
  because what is pinned is the arithmetic between those constants.
- **Ping-not-answered**: a near peer whose ping never answers is not snapshot-fetched at all. This
  is the `!answered` gate alone, distinct from the headline case above the block where the fetch is
  skipped because the *tick budget* already cut the task.

## Review findings

### Production code — checked, nothing found

The code these tests claim to pin was audited directly rather than through the implementer's
handoff: `stabilizeOnce`, `nearProbeTargets`, `probeAndFetch`, `probeNeighborLatency`,
`phaseTwoTargets`, and `fetchAndMergeSnapshot` in `packages/fret/src/service/fret-service.ts`. All
three mechanisms are present and correct as documented — phase 1 runs under a
`STABILIZE_PHASE_ONE_BUDGET_MS` child deadline with a mandatory `cancel()` in a `finally`; phase 2
tests the tick signal and never phase 1's; `enforceCapacity` and the announce sit above phase 2's
early return; `probeAndFetch`'s `wasCancelled` check sits ahead of the `!answered` gate so the two
cannot disagree; the `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` override is on the `fetchNeighbors` call.
**This ticket has no production-code arm.** Stated explicitly because "tests only" is a claim a
reviewer has to verify rather than accept.

Two further points checked and found correct rather than assumed:

- The two label re-poses between ticks are load-bearing, not sloppiness. Tick 1's phase-2 pings
  succeed, so the `unknown` peer is promoted to `member` and the `dead` peer's contact-failure run
  is cleared; both would then be drawn into the *near* list on tick 2, where they are pinged **and**
  fetched — a different question. Re-posing makes tick 2 ask the same one. Neither peer is left in
  backoff (backoff is recorded on failure only), so both are genuinely selectable on tick 2.
- Profile teardown ordering in the Edge case is correct: `harness` is reassigned by `build`, so the
  in-body `teardown()` stops the Core rig and restores the tick-budget static, and `afterEach` then
  tears down the Edge rig. No state leaks between the two.

### Minor — fixed in this pass

**The wall-clock assertion did not discriminate.** `expectPhaseTwoKeepsItsTurn()` bounded the tick
at `at.most(3000)`, which is *exactly* `STABILIZE_PHASE_ONE_BUDGET_MS`. Remove the snapshot-timeout
override and the fetch falls back to the 5000 ms route-sized default, so phase 1 is cut by its own
sub-budget at 3000 ms and the tick lands at ~3000-3013 ms — the assertion failed by ~13 ms. That is
a timing assertion whose entire discriminating power was ~13 ms on shared CI hardware, and it was
the *only* thing pinning the snapshot-timeout half (the behavioral assertions in the same helper
still pass under that mutation, since phase 2 does get its turn — that is what the sub-budget buys).

Tightened to `at.most(2000)`, with a comment stating why that number and not the sub-budget's own
value. The unmutated tick costs ~1.05 s, so this is ~2x margin over the real cost and ~1000 ms of
clearance against the mutation, and it now asserts what its own message claims.

Verified both directions: the spec passes unmutated (16 passing), and with
`timeoutMs: FretService.MAINTENANCE_SNAPSHOT_TIMEOUT_MS` removed from `fetchAndMergeSnapshot`'s
`fetchNeighbors` call both cases fail on that assertion (14 passing, 2 failing). The mutation was
restored in the same chained shell invocation; the working tree carries no production change.

### Major — one ticket filed

**The `busy` reply arm of the maintenance ping is not covered by any test, and the root cause is
the shared harness, not any one spec.** A near peer answering `busy` is treated as its own case in
four ways at once — it confirms membership, clears any contact-failure run, records backoff, and
records neither a strike nor a relevance decay — and because it *answered*, `probeAndFetch` goes on
to fetch its snapshot. None of that is asserted anywhere. Verified by reading the suite rather than
inferred: `busy` does not occur in `test/failure-recovery.spec.ts` at all, and its only occurrence
in `test/dead-state.spec.ts` is a prose comment.

Climbing the architecture ladder before filing: the reason no maintenance test can express this is
that `test/helpers/maintenance-rig.ts` has a two-valued behavior type (`'answers' | 'hangs'`) and a
reply builder that hard-codes `{ok: true}`. That single site blocks a whole class — the `busy` arm,
the `ok: false` arm, and the undecodable-reply arm all share the shape *the peer answered, but not
well*. So the ticket filed is for widening the harness (rung 2: the change that makes the class
testable), citing the busy arm as the evidence, rather than a point ticket for the one arm:
`tickets/backlog/debt-maintenance-rig-non-ok-replies`.

Site-claim grep run before filing. It surfaced two neighbours, both cross-referenced rather than
merged, since each names a different site:

- `debt-backoff-map-test-surface` — about the *arithmetic* of backoff being hard to unit-test; this
  is about the *arm* being unreachable from an integration test.
- `debt-fetch-snapshot-failure-arms-untested` — the same kind of gap one RPC later, on the fetch
  rather than the ping. Blocked by the same harness limitation, so a note was appended there saying
  to do the harness change once and satisfy both.

### Docs — two stale claims corrected

Both files the change touches were read, and so was the design document section that should have
covered it. `docs/fret.md` described both *mechanisms* correctly (the *Two phases* bullet already
named the phase-1 sub-budget, the 5000 - 3000 = 2000 ms reserve arithmetic, and the "ping did not
answer → no fetch" rule), but two claims about what is *tested* were wrong:

- The *Disjoint by construction* bullet listed what `test/stabilize-concurrency.spec.ts` pins and
  did not name the new cases. Extended, including the two facts a future reader needs in order not
  to "simplify" them away: that they deliberately run at unmutated constants, and that their
  wall-clock bound is set against the snapshot timeout rather than the phase-1 sub-budget, with the
  ~13 ms reason.
- The escalation bullet ended "Pinned by `test/failure-recovery.spec.ts`" while covering both the
  near-pass escalation *and* the `busy` exception. That file pins the unreachable/timeout arms only.
  Narrowed to say so, and the `busy` arm is now marked uncovered with a pointer to the new ticket.

### Considered and not filed

- **The ping-never-answers case asserts no fetch, but not the contact strike the timeout leaves.**
  Not a gap: `test/failure-recovery.spec.ts` already pins strike accounting for unreachable near
  peers, including `strikes each of two unreachable near peers exactly once in one tick`. Asserting
  it again here would duplicate that file rather than add coverage.
- **Phase 1 truncating on the tick budget, and phase 2 finding no targets**, are both already
  exercised by the headline regression case and the target-selection cases in the same file.
- **Source hygiene.** `stabilize-concurrency.spec.ts` is 428 lines (`wc -l`), up 80 from 348.
  Comment density in the new block is high, but it matches the surrounding file, which is written
  as a commentary on why each property is pinned — the file's header block is itself a design
  summary. Splitting it would separate the phase-2 cases from the headline case they are explicitly
  the same family as. Left as is.

### Tripwires

None recorded. Nothing in the diff is of the "fine now, only matters if X later" shape: the two
findings were a test that did not discriminate (fixed here) and an arm with no coverage at all
(a real gap, filed). No accepted-tradeoff `NOTE:` was found at any site touched.

## Gate

Run from `packages/fret/`, foreground, no redirection:

- `npx tsc --noEmit` — clean.
- `yarn test` — **1217 passing (3m)**, 0 failing. Matches the count the implement stage reported, so
  the review-pass edit added no test and broke none.

No lint step exists in this repo; `yarn check` (typecheck + build + test) is the gate, and
`yarn format` / `yarn format:check` were not run, per AGENTS.md.

## Process note

Two prior review runs on this ticket each stopped on a `BUDGET_WARNING` before changing anything;
this run completed the production audit the first deferred, applied the one finding, and closed out.
A third `BUDGET_WARNING` landed after the spec first went green — the remaining steps were carried
out as chained invocations rather than deferred to a fourth run, since the ticket was one fix and
one gate from done.
