description: Tests now lock in the rule that recording a success or failure about a peer never re-adds that peer to the routing table; they pass, and each one was checked to actually fail when the rule is broken.
prereq:
files: packages/fret/test/scoring-never-creates.spec.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/churn.leave.spec.ts
difficulty: medium
----

## What the rule is

`FretService`'s four scoring helpers — `applyTouch`, `applySuccess`, `applyFailure`,
`applyContactFailure` — record bookkeeping *about* a peer (relevance, success/failure counts,
latency). None of them may **create** a routing-table entry. Each opens with
`const entry = this.store.getById(id); if (!entry) return;` and takes no coordinate argument, so
scoring a peer the table does not hold is a silent no-op.

The rule exists for one concrete sequence: `handleLeave` removes a departing peer, its connection
closes a moment later, the `peer:disconnect` listener scores a failure against it — and the old
create-on-miss arm brought the peer straight back as an unclassified stranger that the
classification probe pass then spent budget on. Creation belongs to `noteDiscovered` and the
explicit insert sites (`peer:connect`, bootstrap seeding, `importTable`).

**The source change was already committed before this run** (`fret-service.ts:566`, `637`, `670`,
`696`). This ticket was only ever about the tests.

## What landed this run

Nothing in `src/`. Two things:

- `packages/fret/test/scoring-never-creates.spec.ts` was validated — it was written by a prior run
  and had never been compiled or executed. `npx tsc --noEmit` is clean and all five tests pass
  as written; no edits were needed.
- One stale comment in `packages/fret/test/churn.leave.spec.ts` (above the
  `removes the departing peer from the id map and from the ring window` test) pointed at
  `tickets/implement/` for a sibling case. It now names the spec that actually covers the
  `peer:disconnect` half, and states plainly what is still uncovered. **Comment text only** — no
  code, no assertions changed.

## Validation actually performed

```
cd packages/fret && npx tsc --noEmit                        # clean
cd packages/fret && node --import ./register.mjs \
  node_modules/mocha/bin/mocha.js "test/scoring-never-creates.spec.ts" --timeout 30000
                                                            # 5 passing (566ms)
```

**Mutation-tested, not merely green.** Each never-create test was shown to fail when its own
guard is removed:

| Mutation (reverted afterwards) | Result |
|---|---|
| `applyFailure`: `getById(id) ?? this.store.upsert(id, await this.coordOf(id))` | tests 1 and 2 fail; 3, 4, 5 pass |
| `applySuccess`: same mutation | test 4 fails; 1, 2, 3, 5 pass |

The source ticket predicted "tests 1, 2 and 4 fail" from the `applyFailure` mutation alone. That
was wrong and the table above is the corrected mapping: test 4 is a *ping* outcome, so it rides
`applySuccess`, and only the second mutation moves it. Both mutations were reverted;
`git diff` over `packages/fret/src/` is empty.

## The five tests, and what each pins

`describe('through the peer:disconnect listener')` — a real `createMemNode` with a **started**
`FretService` (the listener is registered inside `start()`), driven by
`node.dispatchEvent(new CustomEvent('peer:disconnect', { detail: pid }))`. In libp2p v3 the event
detail is the `PeerId` directly, not `{ id: PeerId }`.

1. **does not re-admit a peer the table has never held** — the headline case. Dispatch a
   disconnect for a freshly-generated id the store has never seen; assert the entry is still
   absent and `size()` is unchanged. Because a no-op produces nothing observable, this waits out
   the listener (100 ms) rather than waiting *for* it.
2. **does not resurrect a peer that was removed while connected** — the leave sequence in
   miniature: `peer:connect` (which creates the entry and scores it), then `store.remove(id)`,
   then `peer:disconnect`. The peer must stay gone.
3. **still scores a peer the table does hold** — the regression guard on the arm the rule did
   *not* touch: `failureCount > 0` and the entry survives.

`describe('through a pooled maintenance probe')` — `buildMaintenanceRig('core')`, whose service is
constructed but never started, driving `stabilizeOnce()` directly.

4. **does not resurrect a peer removed while its ping is in flight** — `rig.rig.holdMs = 120`
   holds the stub ping reply open; the test removes the entry 30 ms in and awaits the tick. This
   is the mid-tick eviction case: scoring must no-op rather than re-create.
5. **still scores a peer that is present when its ping completes** — `successCount > 0`.

## Known gaps — read this before signing off

- **The full suite has never been run against this work.** `cd packages/fret && yarn test` was the
  last Phase-3 arm and this run hit `BUDGET_WARNING` before reaching it. The source half has only
  ever been exercised by four targeted specs (`churn.leave`, `rpc.snapshot-merge-cap`,
  `failure-recovery`, `dead-state` — 97 tests, run by an earlier ticket), and
  `test/dead-state.spec.ts`'s call-site edit from run 26d has been type-checked but **never
  executed**. Running `yarn test` in the foreground (no output redirection) is the single most
  valuable thing a reviewer can do here.
- **The `churn.leave.spec.ts` sibling test was not written.** The gap it would close: a real leave
  notice and a real `peer:disconnect` for the same peer, in one sequence, against **one started
  receiver service**. Test 2 above covers the disconnect half but reaches removal via
  `store.remove` rather than via `handleLeave`. `makeLeaveRig`'s receiver service is deliberately
  never started (the other tests in that block need diagnostics deltas attributable to
  `handleLeave` alone), so this needs its own small rig. One hazard a writer should know about
  before starting: a **started** service re-seeds from libp2p's peerStore on every stabilization
  tick, and a still-connected departing node is in that peerStore — so a tick landing between the
  leave and the assertion legitimately re-admits the peer and the test fails for the wrong reason.
  Either keep the whole sequence inside the first tick interval or make the departing node
  undialable first. That re-seeding is production behaviour, not a defect: the never-create rule
  is about the scoring helpers, never about re-discovery.
- **`applyTouch`'s never-create arm is unreachable through any real call site** and is deliberately
  untested on that arm. Both its callers (`fret-service.ts:1043`, the `peer:connect` listener, and
  `1983`, `mergeAnnounceSnapshot`) `store.upsert` the id synchronously immediately before scoring
  it, so the entry provably exists when the guard runs. Its guard is defence-in-depth against a
  removal landing inside that window. A header comment in the spec says so; do not file a
  coverage finding against it without first showing a caller that can present an absent id.
- **Timing-shaped assertions.** Tests 1 and 2 sleep 100 ms and then assert an *absence*; test 4
  relies on `sleep(30)` landing inside a 120 ms held reply. All five passed comfortably (566 ms
  total) on this machine, but these are wall-clock windows, not synchronization. If any of them
  ever flakes, widening the window is the fix; loosening the assertion is not.
- No handle leak was observed — the mocha exit watchdog did not trip on the targeted run.

## Review use cases

- Run the full suite; report anything unrelated through the `.pre-existing-known.md` /
  `.pre-existing-error.md` protocol rather than skipping or loosening a test.
- Re-run the two mutations in the table above if you want to see the tests bite for yourself.
  One `Edit`, one targeted mocha run, one `Edit` back — do not run the full suite for that check.
- Check the spec's header comment still matches the code it describes (`fret-service.ts` line
  numbers drift).
