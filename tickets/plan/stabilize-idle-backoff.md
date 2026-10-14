description: FRET's background upkeep runs every 1.5 seconds forever, even when nothing in the network has changed for minutes, which keeps idle phones busy and slow. Let the interval grow while things are stable and snap back to fast the moment anything changes.
prereq: maintenance-redial-off-the-tick, stabilize-skip-redundant-near-exchange
architecture: docs/fret.md#stabilization-and-churn-handling
files: packages/fret/src/service/fret-service.ts (startStabilizationLoop, stabilizeOnce, phaseTwoTargets, strikeUncontactable, applyContactFailure, applyMembershipSignal, peer:connect / peer:disconnect / peer:update / peer:identify listeners, mergeAnnounceSnapshot, handleLeave, setMode, redial), packages/fret/src/index.ts (FretConfig), packages/fret/test/address-less-departure.spec.ts, packages/fret/test/failure-recovery.spec.ts, packages/fret/test/dead-state.spec.ts, packages/fret/test/stabilize-concurrency.spec.ts, docs/fret.md
difficulty: hard
----
Reported as gotchoices/Fret#2 (p2p-fret 1.0.2, via sereus on phones over a circuit relay). This ticket covers the reporter's suggestion 1. See `stabilize-skip-redundant-near-exchange` for the measured traffic and CPU numbers. That ticket makes each pass cheaper; this one makes passes rarer when they would find nothing.

## Problem

`startStabilizationLoop` re-arms a fixed timer after every pass: 1500 ms in passive mode, 300 ms in active mode. The two-phase structure, budgets and pooling make one pass cheap and bounded, but nothing ever makes passes rarer. A two-member strand that has been stable for ten minutes runs about 400 passes, and every one is the same pass as the first.

## Expected behavior

In **passive mode**, after a pass that observed nothing new, the delay to the next pass doubles from the base interval (1.5 s) up to a cap. The reporter suggests 30–60 s, and plan stage settles the default. The cap is host-configurable through `FretConfig` and validated like `dialTimeoutMs`. Any change resets the delay to the base interval. **Active mode is unchanged** (300 ms, no backoff): it exists precisely for operations in flight.

**What counts as "nothing new"** (plan stage pins the exact list; the rule is that anything the next pass could act on resets the delay):
- no peer entered or left the live-member window around self;
- no snapshot merge discovered a new id;
- no contact strike, no membership or state change, no redial requested or settled;
- phase 2 had nothing to select (`phaseTwoTargets` found all three label counts at zero). An `unknown`, `foreign` or `dead` peer present means probing work is pending on its own backoff schedule, so the loop must not sleep past it.

**Reset triggers that arrive between passes:** `peer:connect`, `peer:disconnect`, `peer:update`/`peer:identify` that changes a membership label or the has-addresses set, an inbound announce or leave notice, an inbound RPC from a peer not currently a live member, a redial settling, `setMode`, and `importTable`. A reset must take effect immediately: it cancels the long pending timer and re-arms at the base interval (or runs a pass at once — plan stage decides). It must not wait out the long timer.

## Edge cases & interactions

- **Pass-counted failure detection.** `strikeUncontactable` books one strike per *pass* against address-less window members. Today that kills a departed phone in 3–4.5 s. With backoff, a member whose connection is gone would be struck at most once per backed-off interval, i.e. minutes. This is safe only because the departure is itself a `peer:disconnect`, which resets the delay. That reset is therefore load-bearing, not an optimisation. Pin it with a test: an address-less member whose connection drops on a fully backed-off loop is still marked dead within the existing bound. `test/address-less-departure.spec.ts` is the natural home. Restate the docs bullet that quotes "3–4.5 s".
- **Silent loss with no disconnect event.** A peer that vanishes while its connection object stays open (half-open relay circuit) generates no event, so it is detected only by the probe at the backed-off cadence. State the worst-case detection time at the chosen cap in `docs/fret.md`. If it is unacceptable, cap the near-pass interval separately from the rest.
- **Spacing guards.** The 500 ms contact-failure and negotiate-failure spacing assume passes can be close together. Longer intervals only make observations more independent, so verify by inspection that no test assumes a pass count inside a wall-clock window.
- **Run-scoped housekeeping that rides the tick.** The sweeps of `ProbeBackoff` and the departure-debounce map, the store-membership prune, `enforceCapacity`, `ready()` resolution after the first pass, and size-estimate decay (0.95 per minute without updates) all run on or depend on the tick. At a 60 s cap each must still meet its stated bound. `ProbeBackoff`'s 5-minute retain is fine; check the others and say so in the docs.
- **Off-ring re-probe cadence.** The foreign and dead arms back off up to 32 s per peer. The "phase 2 pending" rule above keeps the loop fast whenever such peers exist, which on a mixed-network deployment may mean it never backs off. That is acceptable but must be stated, or the loop must instead sleep until the earliest per-peer backoff expiry. Plan stage picks one.
- **Redials outlive the tick** (from `maintenance-redial-off-the-tick`). A redial in flight is pending work. Its settling resets the delay, so a slow relayed reconnect is followed up promptly, not a minute later.
- **Lifecycle.** `stop()` clears the delay state, and a start→stop→start cycle begins at the base interval. The existing run-generation guard must still stop a stale long timer from resurrecting a loop. That is unchanged, but the timer is now often long-lived, so verify by inspection.
- **Multiple services per node.** Sereus runs one FRET per libp2p node, so each service backs off independently. No shared state is needed.
- **Diagnostics.** Expose the current loop delay (or a count of backed-off passes) on `getDiagnostics`, so a host can see the loop is idling.

## Measuring success

The reporter offered to re-measure on the same two phones. Target: on an idle two-member strand, passes fall from ~20/min to ~1–2/min after a few minutes of stability, and the loop returns to 1.5 s within one pass of a `peer:connect` or `peer:disconnect`.

## Interaction with `peerstore-reseed-on-change` (added by that ticket's plan stage)

That ticket removes the per-pass `peerStore.all()` walk. Peers, protocol lists and records now arrive through the `peer:update` / `peer:identify` listeners, and a time-driven backstop walk (`PEERSTORE_BACKSTOP_INTERVAL_MS`, 5 min, run from the pass when due) reconciles only the has-addresses set against libp2p's silent changes (address aging, `delete`, peer expiry). With idle backoff the backstop runs at most one backed-off interval late, which is fine against libp2p's 1 h address-age clock. A backstop pass that changes the has-addresses set should count as "something new". The listener reset triggers listed above are unaffected.

## Interaction with `stabilize-skip-redundant-near-exchange` (added by that ticket's plan stage)

That ticket lets a pass skip a near neighbour's ping when proof of life arrived during or after the previous pass, and skip its snapshot fetch when the neighbour's snapshot fingerprint is unchanged. Both windows are counted in **passes** (a monotonic pass sequence number), not milliseconds, so under backoff they scale with the delay automatically. Consequences for this ticket:
- **Silent-loss detection gains one interval.** After a peer's last answered ping, the next pass may skip it, then three probing passes strike it dead — four backed-off intervals in the worst case, not three. Use that figure in the worst-case detection time this ticket must state.
- **Content re-check cadence is per pass.** A neighbour's fingerprint must be re-confirmed at least every fourth pass (`NEAR_PROBE_MAX_SKIPS` = 3), so at a 60 s cap a changed neighbour list is noticed within ~4 minutes unless an announce delivers it first. Decide whether a pass that fetched because a fingerprint changed counts as "something new" (it merged content; the conservative answer is yes when the merge discovered an id, which is already on the list above).
- A pass in which every near probe was skipped and nothing was fetched is, by itself, "nothing new".
