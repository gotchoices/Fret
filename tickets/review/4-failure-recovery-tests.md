description: Tests now watch a peer actually go unreachable and come back — one node stops answering, its neighbor down-ranks it, gives up on it, and re-admits it once it returns — instead of checking that sequence one isolated step at a time.
files: packages/fret/test/failure-recovery.spec.ts (new, 11 tests), packages/fret/src/service/fret-service.ts (comment only, at classifyByProtocols), docs/fret.md (soft-failure bullet)
difficulty: medium
----

## What shipped

**`packages/fret/test/failure-recovery.spec.ts`** — new, 11 tests, two `describe` blocks.
409 lines. All on real libp2p nodes. Nothing here re-derives a `dead-state.spec.ts` fact; the boundary is
"seam and single call site" (there) vs "whole tick, tick-to-tick, and two real nodes" (here), which
is the split `dead-state.spec.ts`'s own header asks for.

**`src/service/fret-service.ts`** — one `NOTE:` added at `classifyByProtocols`. No behavior change.

**`docs/fret.md`** — the soft-failure bullet (was `docs/fret.md:68`) now describes the staged
escalation that actually ships instead of "retry with exponential backoff".

Build and tests: `npx tsc --noEmit` clean; `yarn test` from `packages/fret/` — **692 passing, 0
failing**. No pre-existing failures surfaced, so no `.pre-existing-error.md` was written.

## How the tests are driven

The observing service is constructed and **never started**, so its own stabilization loop cannot
race the assertions; ticks are driven by a local helper that mirrors `startStabilizationLoop`
exactly:

```ts
const tick = async () => {
	await (svcA as any).seedFromPeerStore()   // rebuilds the dialability set wholesale
	await (svcA as any).stabilizeOnce()
}
```

The re-seed is load-bearing, not decoration, and this is the single biggest trap for anyone editing
this file: a peer that is not in `addressKnown` is in neither the near list nor either re-probe arm,
so a tick without the re-seed silently drives an **empty target list** and every "no strike"
assertion passes vacuously. Every multi-tick test therefore asserts target-list membership before
the tick it cares about.

Two no-sleep idioms, borrowed rather than re-invented:
- strike spacing: `store.update(id, { lastContactFailureAt: 0, lastNegotiateFailureAt: 0 })`
- backoff window: `backoffMap.set(id, { ...cur, until: Date.now() - 1 })` (keeps the factor)

## Use cases the tests pin, and what to try by hand

**Block 1 — one whole tick of soft failure** (2 tests). Remote's node stopped, one tick:
relevance strictly down from a real success baseline, `failureCount` 1, `pingsFail` +1,
`contactFailures` 1, not `dead`, still a neighbor / cohort member / near target — and
**`backoffMap.get(B) === undefined`**. That last one is the assertion that pins the shipped staging
against the old doc prose: the near pass never backs off, so a live member is re-verified every tick.

**Block 2 — escalation and the pass handoff** (5 tests):
- three spaced ticks through `stabilizeOnce` → `contactFailures: 3`, `state: 'dead'`,
  `membership` still `member` (a dial that never landed is not membership evidence);
- handoff: after death `nearProbeTargets()` no longer names the peer and the dead arm of
  `reprobeExcludedTargets()` does — *after* expiring the backoff that the killing tick's own phase 2
  recorded;
- three **back-to-back** ticks with no rewind leave `contactFailures` at 1 and the peer alive, so a
  live service under mass failure cannot kill a neighbor in one burst;
- dead-arm cadence: in-window → not selected; expired → selected; next failed probe doubles the
  factor 1 → 2;
- two unreachable near peers in one pooled tick end at exactly one strike each.

**Block 3 — the two-node arc** (3 tests + the contrast block). Node down → dead → gone from
`getNeighbors`, `assembleCohort`, and the outgoing `snapshot()`; `b.start()` + `svcB.start()` on the
same peer id and memory multiaddr → one tick → `connected` + `contactFailures: 0` + `member` + back
in the ring, with `pingsSent` provably increased so the dead arm (not an incidental `peer:connect`)
is what restored it; and `failureCount` / `successCount` / `relevance` all carried forward, which is
the "deliberately not reset" contract.

To exercise by hand:
```
cd packages/fret
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/failure-recovery.spec.ts" --timeout 30000
```
Whole spec runs in ~4 s.

## The one place the ticket's plan did not survive contact

The ticket specified the service-only-stop contrast (remote node up, only `svcB.stop()`) on the same
memory nodes as everything else. **That cannot reach `foreign` there, and the reason is real shipped
behavior rather than a harness quirk:**

`seedFromPeerStore` re-classifies every peer off its peerStore protocol list on *every* tick, and a
list containing one of our protocols is strong positive evidence that **resets the negotiate-failure
run**. On a memory node that list is populated by the first successful negotiation and can never go
stale-negative, because nothing pushes an update — so the reset fires each tick and
`negotiateFailures` oscillates at 1 forever. Measured directly: 4 spaced ticks, `nf` stuck at 1,
`membership` still `member`.

The test therefore uses `createIdentifyNode()` (TCP + `identify` + `identifyPush`) for that one
block, in its own `describe` with its own fixture. `svcRemote.stop()` unhandles the five protocols,
`identifyPush` propagates the shortened list, the positive reset stops firing, and three spaced ticks
give `negotiateFailures: 3`, `membership: 'foreign'`, `contactFailures: 0`, `state` never `dead` —
the stated outcome, now on a transport where the evidence chain is real end to end.

**This is parked as a tripwire, not a ticket** (see `## Review findings` below): a deployment
configuring `identify` **without** `identifyPush` never gets the negative update, so a peer that
stops serving this network keeps having its negotiate run reset and never demotes to `foreign` — it
stays a cohort member and routing candidate that can only fail. Liveness is unaffected (a peer whose
node goes away still reaches `dead`). It is genuinely conditional on deployment config, and FRET
ships no recommended libp2p config today, so there is nothing to fix at a code site — only a
constraint to state where the next reader meets it.

## Known gaps — treat the tests as a floor

- **Both re-probe arms are budget-2 (Core) and the tests only ever have one candidate.** The
  "separate budgets don't starve each other" property is `dead-state.spec.ts`'s, and this spec never
  puts two dead peers in one tick. A regression that merged the arms' budgets would pass here.
- **The pool double-count test uses two peers against a concurrency cap of 6**, so it proves task
  disjointness, not that the cap is respected — `stabilize-concurrency.spec.ts` owns the cap.
- **`snapshotsFetched` is deliberately unasserted anywhere in this spec.** `fetchAndMergeSnapshot`
  swallows its own failure into an empty snapshot and still counts it (documented accepted
  overcount), so the counter moves on ticks where nothing was fetched.
- **`failureCount` is asserted with `at.least` in the recovery test, exactly** in Block 1/2. The
  killing tick produces *two* decays (phase 1's near probe, then phase 2's dead-arm probe of the
  freshly-dead peer), which is why the exact numbers only appear where the tick shape is pinned.
  If phase 2's selection changes, the Block 2 exact counts move and the recovery test does not.
- **Timing-shaped, not time-mocked.** Everything is wall-clock `Date.now()` with rewinds; there is
  no fake clock. A machine slow enough for two hand-driven ticks to land >500 ms apart would break
  "cannot kill a neighbor in a burst of back-to-back ticks" — measured at ~50 ms for three ticks, so
  the margin is ~10×, but it is a margin, not a guarantee.
- **The identify block waits on `identifyPush` with a hand-rolled 8 s async poll** (`waitForAsync`
  at the foot of the file) because `helpers/wait-for.ts`'s `waitFor` takes a *sync* predicate and the
  peerStore read is async. If a third caller ever needs this, it belongs in the helper, not here.
- **`docs/fret.md`'s soft-failure bullet is the only doc line touched.** The neighboring bullets were
  read and are accurate; nothing else was audited.

## Review findings

- **Tripwire parked at `src/service/fret-service.ts`, on `classifyByProtocols`** (`NOTE:`): a
  deployment running libp2p `identify` without `identifyPush` never sees a peer's protocol list go
  stale-negative, so `seedFromPeerStore`'s per-tick re-classification keeps resetting that peer's
  negotiate-failure run and it can never demote to `foreign`. Conditional on deployment config;
  liveness detection is unaffected. Analysis lives at the NOTE and in the section above.
