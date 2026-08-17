----
description: Add tests that watch a peer actually go unreachable and come back — one node stops answering, its neighbor down-ranks it, gives up on it, and re-admits it once it returns — because today that whole sequence is only checked one isolated step at a time.
files: packages/fret/test/failure-recovery.spec.ts (new), packages/fret/test/dead-state.spec.ts, packages/fret/test/helpers/libp2p.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: medium
----

## What is already covered, and what is not

`test/dead-state.spec.ts` (~1040 lines) already pins the failure machinery at the *seam* level:
the strike counter and its 500 ms spacing guard, the negotiate-failure-is-not-a-strike rule, the
clamp, self-immunity, resurrection from `applySuccess` / `noteInboundRpc` / `peer:connect`, ring-view
exclusion of a dead peer, capacity eviction, and the "cancellation is not evidence" guards. Two of
its tests already reach a real remote (`probeNeighborLatency` against a live node, and the dead arm
of `reprobeExcludedTargets` restoring a peer inside one `stabilizeOnce`).

**Do not re-derive any of that.** What is missing is one level up:

1. **The whole stabilization tick.** Every existing run-to-`dead` calls `probeNeighborLatency` (or
   `applyContactFailure`) in a hand-written loop. Nothing drives the failure through
   `stabilizeOnce` → `nearProbeTargets` → pooled `probeAndFetch` → `probeNeighborLatency` →
   `noteRpcFailure`, so a regression in *target selection* — a near peer that stops being selected,
   a strike counted twice by the pool — passes every current test.
2. **The handoff between passes across ticks.** While a peer is alive it is probed by the near pass
   with no backoff; once it is `dead` it leaves the near list entirely and only the backed-off dead
   arm of `reprobeExcludedTargets` will ever touch it again. That transfer is the peer's only path
   back, and nothing asserts it happens.
3. **The two-node arc on real nodes.** No test takes a real peer down, watches its neighbor's view
   degrade through soft failure to `dead`, brings it back, and watches the view recover.

## Shipped behavior these tests must be written against

The plan verified each of these by running them; write the assertions to match, not the older
design-document prose.

- **Soft failure decays relevance and records no backoff.** `probeNeighborLatency` — the near pass —
  calls `applyFailure` (relevance decay, `failureCount++`) plus one contact strike, and never calls
  `recordBackoff`. `nearProbeTargets` has no backoff filter either, so a near neighbor is re-probed
  on *every* tick while it is still a live member. Backoff belongs to the off-ring passes
  (`probeMembership`, used by the classify / foreign / dead arms) and to the routing path.
  The escalation is therefore **staged**, not per-failure: at most 4 near peers verified
  unconditionally every tick for at most `deadAfterFailures` (3) strikes, then exclusion from the
  ring plus an exponentially backed-off dead arm. `docs/fret.md:68` currently says only
  "retry with exponential backoff", which reads as if the near pass backs off; fix that line.
- **Only failure to *reach* the peer counts.** Verified with real nodes:
  - Stopping the remote **node** → dials fail → `contactFailures` reaches 3 → `state: 'dead'`,
    and `membership` stays `member` (a dial that never landed says nothing about which network the
    peer serves).
  - Stopping only the remote **FRET service** while its node stays up → dials succeed and protocol
    negotiation fails → `negotiateFailures` reaches 3 → `membership: 'foreign'`, `contactFailures`
    stays 0 and `state` is never `dead`.
  This pair is the sharpest statement of the distinction and belongs in the two-node block.
- **Recovery does not reset relevance.** `noteProofOfLife` clears `contactFailures` and
  `lastContactFailureAt` and restores `state`; `successCount` / `failureCount` / `relevance` keep
  their history, and ordinary success scoring is what up-ranks the peer.
- **The first dead-arm probe after death gates the next tick.** When a peer is marked dead in phase 1
  of a tick, phase 2 of that *same* tick selects it into the dead arm, probes it, fails, and records
  backoff at factor 1 (~1 s). The immediately following tick therefore skips it
  (`getBackoffPenalty !== 0`). Confirmed by running it: an immediate recovery tick left the peer
  `dead`; after the window passed, one tick restored it to `connected` + `member` + `contactFailures: 0`.

## Approach

Real libp2p memory nodes throughout (`test/helpers/libp2p.ts`'s `createMemNode`) — no new stub
harness is needed and `helpers/maintenance-rig.ts` needs no change. A stopped memory node restarts
with the **same peer id and the same multiaddr**, and the dialer's peerStore keeps the address across
the outage, so the full down → dead → up → resurrect arc runs on real transport. This was verified
before writing the ticket.

Follow the convention the existing specs use: construct the *observing* service and never `start()`
it, driving `stabilizeOnce()` by hand so its own loop cannot race the assertions; `start()` the
*remote* service so it registers this network's handlers.

Put the work in a **new** `test/failure-recovery.spec.ts`. Do not add it to `fret.mesh.spec.ts` —
`plan/5-networked-test-assertions` owns that file and the two would collide. Do not grow
`dead-state.spec.ts`: its own header already says a seventh block should be split out by evidence
source, and this is that split.

Two idioms to reuse rather than reinvent:
- **Rewind, don't sleep, for the 500 ms strike spacing:** `store.update(id, { lastContactFailureAt: 0 })`
  between ticks (`dead-state.spec.ts`).
- **Expire, don't sleep, for a backoff window:**
  `bo.set(id, { ...bo.get(id)!, until: Date.now() - 1 })` (`ring-membership.spec.ts:380`).
  A real 1.2 s sleep works but is wasted wall-clock in a suite that already runs the tick by hand.

## Key tests and expected outcomes

**Block 1 — soft failure through one whole tick.** Observer A (constructed, not started), remote B
seeded as a dialable `member`, then B's node stopped. One `await (svcA as any).stabilizeOnce()`:

- `relevance` strictly lower than before the tick, `failureCount` 1, `diag.pingsFail` +1.
- `contactFailures` 1, `state` not `dead`, entry still present.
- Still a neighbor: B appears in `svcA.getNeighbors(selfCoord, 'both', m)` and in
  `assembleCohort`, and is still returned by `nearProbeTargets()`.
- **No backoff recorded** — `backoffMap.get(B)` is `undefined`. This is the assertion that pins the
  shipped staging against the old prose.
- Non-vacuity: assert B *was* in `nearProbeTargets()` before the tick, so a zero strike count could
  not be an empty target list.

**Block 2 — escalation and the pass handoff across ticks.**

- Three ticks with the spacing rewind between them drive B to `contactFailures: 3` and
  `state: 'dead'`, with `membership` still `member` — the whole run through `stabilizeOnce`, never
  calling `probeNeighborLatency` directly.
- **Handoff:** after the third tick, `nearProbeTargets()` no longer contains B (it is no longer a live
  member) and `reprobeExcludedTargets()`'s dead arm does — modulo the backoff entry that tick's own
  phase 2 recorded, so expire it before asserting selection.
- **Spacing guard through the real tick:** three back-to-back ticks *without* the rewind leave
  `contactFailures` at 1 and B alive. Ticks land well inside the 500 ms window, so a live service
  under mass failure cannot kill a neighbor in one burst.
- **Backoff cadence of the dead arm:** after a failed dead-arm probe, the next `reprobeExcludedTargets()`
  omits B; expiring the window re-admits it, and the next failure doubles `factor` (1 → 2).
- **Pool does not double-count:** two near peers both unreachable in one tick end at exactly one
  strike each (the pooled phase-1 tasks are disjoint by construction).

**Block 3 — the two-node arc on real nodes.**

- *Down:* B's node stopped → three ticks → B is `dead`, `membership` still `member`, and B is gone
  from A's `getNeighbors`, `assembleCohort`, and the outgoing `snapshot()`'s successors /
  predecessors / sample.
- *Up:* `await b.start(); await svcB.start()` — same id, same address — then expire B's backoff and run
  one tick. B is `state: 'connected'`, `contactFailures: 0`, `membership: 'member'`, and back in
  `getNeighbors` / `assembleCohort`. Assert `diag.pingsSent` increased across that tick, so the dead
  arm is provably what restored it rather than an incidental `peer:connect`.
- *History survives recovery:* `failureCount` is still ≥ 3 and `relevance` is not a fresh-entry
  baseline — the "deliberately not reset" contract.
- *Contrast, service-only stop:* B's node left up, `svcB.stop()` only → four ticks with both the
  contact and negotiate spacing stamps rewound → `negotiateFailures: 3`, `membership: 'foreign'`,
  `contactFailures: 0`, `state` never `dead`.

## Edge cases & interactions

- **Strike spacing vs. tick cadence.** Hand-driven ticks land microseconds apart, far inside the
  500 ms spacing window, so *without* the rewind a three-tick loop produces one strike. Block 2 turns
  that trap into an assertion; every other multi-tick test must rewind or it silently tests nothing.
- **Backoff recorded by the same tick that kills the peer.** Phase 2 of the killing tick selects the
  freshly-dead peer into the dead arm and backs it off, so the next tick skips it. A recovery test
  that runs one tick immediately after restart observes *no change* and looks like a broken dead arm.
- **`seedFromPeerStore` rebuilds the dialability set wholesale every tick.** A manual
  `(svc as any).setAddressKnown(id, true)` is wiped by the next tick's `peerStore.all()` walk. Real
  dialed peers survive because the peerStore holds their address; synthetic ids do not. Assert
  `isDialable` (or `nearProbeTargets()` membership) at the start of each multi-tick test so a target
  list that quietly emptied cannot read as "no failures".
- **B must not dial A during recovery.** `svcB` is constructed with no bootstraps precisely so the
  restarted B does not connect to A on its own — an inbound `peer:connect` or RPC would resurrect B
  through `noteProofOfLife` and make the dead-arm assertion vacuous. The `pingsSent` assertion is the
  guard; keep it.
- **Peer state on the observer's side after the remote stops.** A's `peer:disconnect` fires when B
  goes down: that path applies relevance decay and *no* strike, so `failureCount` may be one higher
  than the number of ticks. Assert monotone direction (`relevance` decreased, `failureCount ≥ n`)
  rather than exact equality on the decay counters; `contactFailures` *is* exact and is the counter
  the escalation assertions should use.
- **`fetchAndMergeSnapshot` runs after every near ping.** Against a downed peer it swallows its own
  failure into an empty snapshot and still increments `snapshotsFetched` (documented accepted
  overcount). Do not assert that counter is unchanged in Block 1.
- **`enforceCapacity` runs inside every tick.** Keep the default capacity so nothing under test is
  evicted mid-run.
- **Both services must be stopped and both nodes torn down in `afterEach`**, including the node that
  was deliberately stopped mid-test (`stop()` on an already-stopped node is safe via `stopAll`). The
  mocha exit watchdog fails the run on a leaked handle, so a restarted node left running fails the
  whole suite, not just this spec.
- **Self is never a near-probe target and never marked dead** — already covered in `dead-state.spec.ts`;
  do not duplicate.

## TODO

- Read `test/dead-state.spec.ts` first and confirm nothing below duplicates it; the overlap boundary
  is "seam and single call site" (there) vs "whole tick, tick-to-tick, and two real nodes" (here).
- Add `test/failure-recovery.spec.ts` with the three blocks above, using real memory nodes, an
  unstarted observer service driven through `stabilizeOnce()`, and a started remote service.
- Reuse the spacing-rewind and backoff-expiry idioms; add a short file header stating why this spec
  exists separately from `dead-state.spec.ts`.
- Fix `docs/fret.md:68` so the soft-failure bullet describes the staged escalation actually shipped:
  the near pass decays relevance and re-verifies every tick with no backoff; backoff applies to the
  off-ring probe passes, which is where a peer lands once it is excluded from the ring.
- Run `npx tsc --noEmit` and the full `yarn test` from `packages/fret/`.
