----
description: Tests now watch a peer actually go unreachable and come back — one node stops answering, its neighbor down-ranks it, gives up on it, and re-admits it once it returns — instead of checking that sequence one isolated step at a time.
files: packages/fret/test/failure-recovery.spec.ts (12 tests), packages/fret/test/helpers/wait-for.ts, packages/fret/test/membership-identify.spec.ts (comment), packages/fret/src/service/fret-service.ts (comment only, at classifyByProtocols), docs/fret.md (soft-failure bullet)
----

## What shipped

**`packages/fret/test/failure-recovery.spec.ts`** — new spec, 12 tests across two `describe` blocks,
431 lines, all on real libp2p nodes. Nothing in it re-derives a `dead-state.spec.ts` fact; the
boundary is "seam and single call site" (there) vs "whole tick, tick-to-tick, and two real nodes"
(here), which is the split `dead-state.spec.ts`'s own header asks for.

**`src/service/fret-service.ts`** — one `NOTE:` at `classifyByProtocols`. No behavior change.

**`docs/fret.md`** — the soft-failure bullet now describes the staged escalation that actually
ships (near pass decays + strikes and records *no* backoff; backoff belongs to the off-ring probe
passes and to routing) instead of the old "retry with exponential backoff".

Build and tests at hand-off: `npx tsc --noEmit` clean, `yarn build` clean, `yarn test` from
`packages/fret/` — **693 passing, 0 failing**. No pre-existing failures surfaced, so no
`.pre-existing-error.md` was written.

## How the tests are driven

The observing service is constructed and **never started**, so its own stabilization loop cannot
race the assertions; ticks are driven by a local helper that mirrors `startStabilizationLoop`:

```ts
const tick = async () => {
	await (svcA as any).seedFromPeerStore()   // rebuilds the dialability set wholesale
	await (svcA as any).stabilizeOnce()
}
```

The re-seed is load-bearing and is the single biggest trap for anyone editing this file: a peer that
is not in `addressKnown` is in neither the near list nor either re-probe arm, so a tick without the
re-seed silently drives an **empty target list** and every "no strike" assertion passes vacuously.
Every multi-tick test therefore asserts target-list membership before the tick it cares about.

Two no-sleep idioms, borrowed rather than re-invented:
- strike spacing: `store.update(id, { lastContactFailureAt: 0, lastNegotiateFailureAt: 0 })`
- backoff window: `backoffMap.set(id, { ...cur, until: Date.now() - 1 })` (keeps the factor)

## Use cases the tests pin

**Block 1 — one whole tick of soft failure** (2 tests). Remote's node stopped, one tick: relevance
strictly down from a real success baseline, `failureCount` 1, `pingsFail` +1, `contactFailures` 1,
not `dead`, still a neighbor / cohort member / near target — and **`backoffMap.get(B) === undefined`**.
That last one pins the shipped staging against the old doc prose: the near pass never backs off, so
a live member is re-verified every tick.

**Block 2 — escalation and the pass handoff** (5 tests):
- three spaced ticks through `stabilizeOnce` → `contactFailures: 3`, `state: 'dead'`, `membership`
  still `member` (a dial that never landed is not membership evidence);
- handoff: after death `nearProbeTargets()` no longer names the peer and the dead arm of
  `reprobeExcludedTargets()` does — *after* expiring the backoff the killing tick's own phase 2 recorded;
- three **back-to-back** ticks with no rewind leave `contactFailures` at 1, so a live service under
  mass failure cannot kill a neighbor in one burst;
- dead-arm cadence: in-window → not selected; expired → selected; next failed probe doubles the factor 1 → 2;
- two unreachable near peers in one pooled tick end at exactly one strike each.

**Block 3 — the two-node arc** (4 tests). Node down → dead → gone from `getNeighbors`,
`assembleCohort`, and the outgoing `snapshot()`; restart on the same peer id and memory multiaddr →
one tick → `connected` + `contactFailures: 0` + `member` + back in the ring, with `pingsSent`
provably increased so the dead arm (not an incidental `peer:connect`) is what restored it; a
restarted peer that instead **dials us** is re-admitted by the inbound ping alone, with A's
`pingsSent` unchanged (added in review — see findings); and `failureCount` / `successCount` /
`relevance` all carried forward, which is the "deliberately not reset" contract.

**Block 4 — the service-only contrast.** Remote node up, only `svcRemote.stop()`: three spaced ticks
give `negotiateFailures: 3`, `membership: 'foreign'`, `contactFailures: 0`, `state` never `dead`.

To exercise by hand:
```
cd packages/fret
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/failure-recovery.spec.ts" --timeout 30000
```
Whole spec runs in ~4 s.

## The one place the ticket's plan did not survive contact

The plan specified the service-only-stop contrast on the same memory nodes as everything else.
**That cannot reach `foreign` there, for a reason that is real shipped behavior rather than a
harness quirk:** `seedFromPeerStore` re-classifies every peer off its peerStore protocol list on
*every* tick, and a list containing one of our protocols is strong positive evidence that **resets
the negotiate-failure run**. On a memory node that list is populated by the first successful
negotiation and can never go stale-negative, because nothing pushes an update — so the reset fires
each tick and `negotiateFailures` oscillates at 1 forever. Measured directly: 4 spaced ticks, count
stuck at 1, `membership` still `member`.

Block 4 therefore uses `createIdentifyNode()` (TCP + `identify` + `identifyPush`) in its own
fixture. `svcRemote.stop()` unhandles the five protocols, `identifyPush` propagates the shortened
list, the positive reset stops firing, and the run completes — the stated outcome, on a transport
where the evidence chain is real end to end.

The deployment constraint that falls out of this is parked as a tripwire, not a ticket — see findings.

## Known gaps — treat the tests as a floor

- **Both re-probe arms are budget-2 (Core) and this spec only ever has one candidate.** The
  "separate budgets don't starve each other" property is `dead-state.spec.ts`'s; a regression that
  merged the arms' budgets would pass here.
- **The pool double-count test uses two peers against a concurrency cap of 6**, so it proves task
  disjointness, not that the cap is respected — `stabilize-concurrency.spec.ts` owns the cap.
- **`snapshotsFetched` is deliberately unasserted anywhere in this spec** — `fetchAndMergeSnapshot`
  swallows its own failure into an empty snapshot and still counts it (documented accepted
  overcount), so the counter moves on ticks where nothing was fetched.
- **`failureCount` is asserted with `at.least` in the recovery test, exactly in Blocks 1 and 2.**
  The killing tick produces *two* decays (phase 1's near probe, then phase 2's dead-arm probe of the
  freshly-dead peer), so the exact numbers only appear where the tick shape is pinned. If phase 2's
  selection changes, the Block 2 exact counts move and the recovery test does not.
- **Timing-shaped, not time-mocked.** Everything is wall-clock `Date.now()` with rewinds. Now
  carries a `NOTE:` at the one test that depends on it (see findings).
- **The observer never starts,** so no `peer:connect` listener is attached anywhere in Block 3 and
  its inbound handlers exist only in the one test that registers them explicitly. Recovery via
  `peer:connect` on real nodes remains a `dead-state.spec.ts` seam-level fact.
- **`docs/fret.md`'s soft-failure bullet is the only doc line touched.** The neighboring bullets were
  read and are accurate; `test/README.md` is not (see findings).

## Review findings

Checked: the implement diff read before the hand-off summary; the four probe/selection methods it
exercises (`stabilizeOnce`, `nearProbeTargets`, `reprobeExcludedTargets` / `reprobeOffRingTargets`,
`probeNeighborLatency` / `probeMembership`) read against every claim the tests and the doc bullet
make; each test checked for vacuity; overlap against `dead-state.spec.ts` (50 tests) and
`membership-identify.spec.ts`; every doc and comment the change touches, plus the ones it should
have; `npx tsc --noEmit`, `yarn build`, and the full `yarn test`.

**Fixed in this pass (minor):**

- **Duplicate wait helper.** The spec shipped a private `waitForAsync` because
  `test/helpers/wait-for.ts`'s `waitFor` took a *sync* predicate — a second polling loop with its own
  timeout defaults and its own error-message format, five lines from the shared one. Widened
  `waitFor` to accept `() => boolean | Promise<boolean>` (backward compatible with all 5 existing
  spec files) and deleted the copy.
- **Missing arm of the recovery story.** Block 3 covered exactly one of the two ways a returning
  peer gets re-admitted — the dead arm, which is the path for a peer that never dials us — and
  explicitly suppressed the other. Added `re-admits a dead peer that dials us, without a probe of
  our own`: the restarted remote dials the observer and sends a real namespaced ping, the observer's
  inbound handler clears the verdict and the run, and the observer's `pingsSent` is asserted
  *unchanged*. This is the path a restarted peer with bootstraps actually takes.
- **Stale comment in `membership-identify.spec.ts:87`,** which claimed `seedFromPeerStore` only
  re-classifies `unknown` peers so `peer:update` is "the sole path" that can re-admit a foreign peer.
  The `unknown`-only guard now applies to the *negative* arm alone (`applyMembershipSignal`), so the
  per-tick peerStore poll re-admits `foreign → member` too — whichever observes the pushed list
  first wins. The test is still valid (both are the identify path, and `pingsSent === 0` is the real
  assertion); its stated reasoning was not. Corrected in place. Adjacent to this ticket's subject
  rather than caused by it.

**Major → ticketed:** none filed fresh. One finding, appended as an arm to the existing
`plan/21-cleanup-tests` rather than duplicated: `packages/fret/test/README.md` is further out of
date than that ticket's one-line bullet suggests — measured, it says "67 passing" against an actual
693, indexes about 15 of the ~50 spec files with none of the recent ones, and cites source line
numbers in a "Fixes Applied" section that have long moved. The arm asks the implementer to settle
the *shape* first (a hand-maintained index is what went stale; `docs/fret.md`'s inline
"pinned by `test/x.spec.ts`" pattern is what stayed current) rather than refreshing the numbers.

**Tripwires (conditional — recorded at the site, not filed):**

- `src/service/fret-service.ts`, on `classifyByProtocols` (shipped by the implementer, reviewed and
  kept): a deployment running libp2p `identify` **without** `identifyPush` never sees a peer's
  protocol list go stale-negative, so `seedFromPeerStore`'s per-tick re-classification keeps
  resetting that peer's negotiate-failure run and it can never demote to `foreign`. Verified against
  `applyMembershipSignal` — the positive arm does write `negotiateFailures: 0` from any prior label.
  Genuinely conditional on deployment config (a node with no identify at all is unaffected: an empty
  protocol list returns early), liveness detection is unaffected, and FRET ships no recommended
  libp2p config today, so there is no code site to change — only a constraint to state.
- `test/failure-recovery.spec.ts`, at `cannot kill a neighbor in a burst of back-to-back ticks`
  (added this pass): the only wall-clock-shaped assertion in the file. Three failing ticks measure
  ~50 ms against the 500 ms spacing window — a ~10× margin, not a guarantee, with no fake clock. The
  `NOTE:` says what to do if it ever flakes (stamp the elapsed span and assert it as a precondition,
  so a slow machine reports a broken premise rather than a broken guard). It was in the hand-off
  ticket's prose, which is not where a future reader meets it.

**Considered and declined:**

- *Overlap with `dead-state.spec.ts`.* Three pairs look close — `marks an unreachable neighbor dead
  after a run of failed pings` vs `drives a downed near peer to dead in three spaced ticks`, and
  both spec's dead-arm recovery tests. Read side by side, the older ones call
  `probeNeighborLatency` / hand-set `state: 'dead'` directly, while the new ones go through whole
  ticks and a real outage, so a regression in *target selection* (which peers a tick picks) fails
  only in the new spec. Different evidence source, not duplication. No change.
- *`unspace()` rewinding `lastNegotiateFailureAt` in Block 1–3,* where no negotiate failure can
  occur. Defensive, one line, and correct for anyone who adds a test that does. Left as is.
