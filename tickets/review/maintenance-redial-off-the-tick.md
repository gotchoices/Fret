description: When FRET's background maintenance has to open a new connection to a peer, it used to allow only 2 seconds, which a relayed connection on a slow link can't meet, so such a peer was never reconnected. Connection-opening now has its own, host-configurable time limit and runs outside the stabilization tick.
architecture: docs/fret.md#stabilization-and-churn-handling
files: packages/fret/src/service/fret-service.ts (`RedialResult`, `redials` map, `redial`, `dialForMaintenance`, `redialWithin`, `probeAndFetch`, `probeNeighborLatency`, `probeMembership`, `pingWarmupTargets`, `stop`, constructor `dialTimeoutMs`, `requirePositiveMs`, `diag.redials`, NOTEs at `sendAnnouncementsRateLimited` and the `routeAct` forward), packages/fret/src/index.ts (`FretConfig.dialTimeoutMs`), packages/fret/src/utils/deadline.ts (`awaitUnlessAborted`, `ABORTED`), packages/fret/src/rpc/ping.ts (`sendPing` `dial` option), packages/fret/test/maintenance-redial.spec.ts (new), packages/fret/test/helpers/libp2p.ts (`createSlowHandshakeMemNode`), packages/fret/test/dead-state.spec.ts, packages/fret/test/failure-recovery.spec.ts, packages/fret/test/stabilize-budget-invariants.spec.ts, docs/fret.md
difficulty: hard
repro: verified
----
Reported from sereus (`p2p-fret` 1.0.2). A strand member that restarted on a slow relayed link was never reconnected: every maintenance ping ran under the 2 s `MAINTENANCE_RPC_TIMEOUT_MS`, that budget also covered the dial the ping had to make first, and because `rpcRequest` always passes an abort signal, libp2p's own whole-dial `dialTimeout` was switched off, so 2 s was the only limit on a dial that takes ~9 s there. Ping times out → strike; three strikes → `dead`; the dead arm re-probes with the same 2 s → never reconnects.

## What shipped

**Split by where the dial runs.** Every maintenance ping is now `dial: 'never'` and assumes a connection; `MAINTENANCE_RPC_TIMEOUT_MS` stays 2000 and its comment says it bounds the exchange only. Opening a connection is a separate private seam, `FretService.redial(id)`:

- One `node.dial(peerIdFromString(id), { signal })` under `deadline(cfg.dialTimeoutMs, runSignal)` — a child of the **run** signal, so it outlives the tick that asked and `stop()` collapses it.
- Returns `'connected' | 'failed' | 'cancelled' | 'skipped'`. An in-flight redial for the same id is returned as the **same promise** (a `Map<string, Promise<RedialResult>>`), so a later tick, a warm-up pass and the dead arm share one dial and one verdict. `'skipped'` (no dial, no score) when already connected, no peerStore address, or `maintenanceConcurrency` redials already in flight. A malformed id is logged and `'skipped'`; the promise never rejects (a waiter whose phase ended is no longer listening).
- The seam books its verdict exactly once: a failure that is not our own cancellation → `applyContactFailure(id)` (relevance decay + one strike, the same evidence a dialing ping's `unreachable`/`timeout` was). Success books nothing (the `peer:connect` listener records the connection). No backoff inside the seam — each caller's arm adds what it owes.
- `redialWithin(id, signal)` awaits the redial only until the caller's phase/tick signal fires (`awaitUnlessAborted` in `utils/deadline.ts`, new), returning `'pending'` then; the dial carries on.
- Map entries remove themselves on settling (guarded so a successor run's entry is never deleted); `stop()` clears the map alongside the other run-scoped maps.
- `diag.redials = { started, connected, failed }` so a failed redial is visible as itself. It is **not** a `pingsFail`: no ping was sent.

**Callers.**
- Near pass (`probeAndFetch`): a not-connected target is redialed against the phase-1 signal; `'connected'` → ping + fetch in the same task (fast dial still reconnects and verifies within one tick; connection-refused still strikes within the tick); anything else → return with no further score. Near pass still records no backoff.
- Phase 2 (`probeMembership`): same shape against the tick signal; on `'failed'` the arm also records `backoff.record(id)`, matching what it books for a failed ping.
- Warm-up (`pingWarmupTargets`, start-up and active tick): the per-pass budget is sliced first, then connected targets are pooled pings and not-connected targets get a fire-and-forget `redial` (`detach`), so no pool slot is held for up to `dialTimeoutMs`. A failed warm-up redial strikes — stated in the method comment as deliberate: a failed dial is a failed contact, whoever asked.

**Config.** `FretConfig.dialTimeoutMs?: number`, default 10 000 (libp2p's own `dialTimeout` default, restated). Non-finite or non-positive throws in the constructor (`requirePositiveMs`). Hosts on slow relays: `createFret(node, { dialTimeoutMs: 21_500 })` or `fretService({ dialTimeoutMs: 21_500 })`.

**Tripwires (`NOTE:`)** at `sendAnnouncementsRateLimited` (announce still dials inline under 2 s; on slow links it never lands to a non-connected peer — request a redial and announce next pass if that ever matters) and at the `routeAct` forward (`sendMaybeAct` dials a non-connected hop inside the 5 s route budget; same class).

**Docs.** `docs/fret.md`: new redial bullets under *Stabilization and churn handling* (and the *Hard failure* definition now names a failed redial as a failed contact; the phase-1 chain reads connect → ping → fetch), the `MAINTENANCE_RPC_TIMEOUT_MS` sentence under *Stream management* plus the libp2p signal-disables-`dialTimeout` fact, a warm-up redial bullet under *Active vs passive state*, and `dialTimeoutMs` under *Configuration*.

## Verification

- `yarn check` from root: typecheck clean, build clean, **1316 passing, 0 failing** (`tickets/.logs/maintenance-redial.check.log`).
- libp2p claims checked against `node_modules/libp2p/dist/src/connection-manager/dial-queue.js:150` (`signal: options.signal ?? AbortSignal.timeout(this.dialTimeout)`) and `@libp2p/utils/dist/src/queue/job.js` (`onAbort` aborts the job only when every recipient's signal has aborted).
- Memory transport measured: a 1500 ms slow handshake aborts at a 500 ms budget and connects at ~1.5 s under a long one; a dial to a stopped memory peer fails in ~1 ms (`ConnectionFailedError`), which is why `failure-recovery.spec.ts`'s strikes still land inside the tick.
- Mutation check: restoring the pre-fix shape (no redial step, ping `dial: 'always'`) reddens the reproduction case on the strike assertion.

## Tests

New `test/maintenance-redial.spec.ts` (8 cases, ~8 s). Rig: A dials with a 4 s outbound handshake (`createSlowHandshakeMemNode` in `test/helpers/libp2p.ts` — a `plaintext` encrypter whose `secureOutbound` waits, honouring the abort signal), B is a normal memory node with a started service; A holds B as a live member with B's address and no connection; A is never started and ticks are hand-driven.
- *a dial slower than the phase is not a strike…* — the reproduction: tick returns on the phase-1 budget with no strike, no decay, no ping sent, one redial started; the connection forms afterwards within the dial budget; the next tick pings and fetches with no second dial.
- *a dial that completes within the phase is pinged and fetched in the same tick* — the fast path (300 ms handshake).
- *a dial budget below the handshake fails the redial…* — the control: `dialTimeoutMs` 1000 → one strike, one decay, no backoff from the near pass, inside the tick, no connection left behind.
- *a failed redial from the dead arm also records backoff* — phase 2 adds backoff on `'failed'`.
- *two concurrent requests share one dial and book one strike* — dedup: identical promise, one `started`, one strike, map empty afterwards.
- *skips — no dial, no score — when connected, when address-less, and when the cap is full*.
- *a run cancelled mid-dial settles the redial cancelled and books nothing*.
- *rejects a dialTimeoutMs that is not a positive finite number* — plus the 10 000 default.

`test/dead-state.spec.ts`: the "through a real outbound call site" block now drives `probeAndFetch` (the near pass's real task) since a ping no longer dials; its ghost is marked address-known so the redial issues the dial libp2p then refuses. Rewritten: *marks an unreachable neighbor dead after a run of failed redials*, *still strikes once from the near pass when the run is live*, *still strikes and backs off from a membership probe when the run is live* (assert on `redials.failed`, not `pingsFail`). Added: *a ping alone cannot strike a peer with no connection: skipped, never dialed* and *issues no dial and records nothing from a redial when the run is cancelled*. `countDials` now wraps `node.dial` as well as `dialProtocol`.

`test/failure-recovery.spec.ts`: one assertion swapped — the first failing tick is `redials.failed + 1` and `pingsFail` unchanged; header note on the chain. `test/stabilize-budget-invariants.spec.ts`: header states the redial budget is outside the arithmetic. No other spec changed; `stabilize-concurrency` and `preconnect-concurrency` pass unchanged because the rig's stub connections make every peer connected.

## Known gaps and judgment calls for the reviewer

- **`pingsFail` semantics changed for non-connected peers.** A failure to reach such a peer is now `diag.redials.failed`, not `pingsFail`. Any host dashboard reading `pingsFail` as "unreachable neighbours" will read lower. Correct in my view (no ping was sent) but a visible diagnostic change.
- **Warm-up's fire-and-forget redial is unpinned.** `preconnect-concurrency.spec.ts` connects every peer through the rig, so no spec asserts that a not-connected warm-up target requests a redial without holding a pool slot. `dead-state.spec.ts`'s cancelled-preconnect case does drive the live half through the redial (one `node.dial`), so the wiring is covered; the "not awaited" property is not.
- **No counter for `'skipped'` redials.** A request past the concurrency cap is silently skipped and re-asked next tick. Fine for now; if reconnection on a busy node ever looks slow, count skips by reason.
- **Two dials to one dead peer in a killing tick.** Phase 1's redial fails and strikes; the same tick's phase 2 dead arm selects the now-dead peer and redials again (the phase-1 entry has already removed itself). The second strike is spacing-guarded away and it records the backoff. Same shape as the two pings this used to be; no new cost, but worth knowing when reading `redials.started`.
- **A connected check races the dial.** `redial` returns `'skipped'` if the peer connected between `probeAndFetch`'s `isConnected` test and the seam's own check (e.g. the peer dialed us); that tick then does not ping it. Next tick does. Not worth a special case.
- **Timing assertions in the new spec:** the reproduction asserts the tick lasted at least `STABILIZE_PHASE_ONE_BUDGET_MS - 200` and under the 4 s handshake, and waits up to 8 s for the connection. Lower bounds only get safer on a loaded box; the 4 s upper bound has ~1 s of slack over the 3 s phase.
- **Facade:** `Libp2pFretService` passes `Partial<FretConfig>` straight through, so `dialTimeoutMs` reaches the core with no facade change; `getDiagnostics` is typed by `ReturnType`, so the widened `diag` flows through.
