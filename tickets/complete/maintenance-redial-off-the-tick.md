description: When FRET's background maintenance has to open a new connection to a peer, it used to allow only 2 seconds, which a relayed connection on a slow link can't meet, so such a peer was never reconnected. Connection-opening now has its own, host-configurable time limit and runs outside the stabilization tick.
architecture: docs/fret.md#stabilization-and-churn-handling
files: packages/fret/src/service/fret-service.ts (`RedialResult`, `redials` map, `redial`, `dialForMaintenance`, `redialWithin`, `probeAndFetch`, `probeNeighborLatency`, `probeMembership`, `pingWarmupTargets`, `stop`, constructor `dialTimeoutMs`, `requirePositiveMs`, `diag.redials`), packages/fret/src/index.ts (`FretConfig.dialTimeoutMs`), packages/fret/src/utils/deadline.ts (`awaitUnlessAborted`, `ABORTED`), packages/fret/src/rpc/ping.ts (`sendPing` `dial` option), packages/fret/test/maintenance-redial.spec.ts, packages/fret/test/helpers/libp2p.ts (`createSlowHandshakeMemNode`), packages/fret/test/dead-state.spec.ts, packages/fret/test/failure-recovery.spec.ts, packages/fret/test/stabilize-budget-invariants.spec.ts, docs/fret.md, AGENTS.md
difficulty: hard
repro: verified
----
Reported from sereus (`p2p-fret` 1.0.2). A strand member that restarted on a slow relayed link was never reconnected: every maintenance ping ran under the 2 s `MAINTENANCE_RPC_TIMEOUT_MS`, that budget also covered the dial the ping had to make first, and because `rpcRequest` always passes an abort signal, libp2p's own whole-dial `dialTimeout` was switched off, so 2 s was the only limit on a dial that takes ~9 s there. Ping times out → strike; three strikes → `dead`; the dead arm re-probes with the same 2 s → never reconnects.

## What shipped (`ticket(implement): maintenance-redial-off-the-tick`)

**Split by where the dial runs.** Every maintenance ping is `dial: 'never'` and assumes a connection; `MAINTENANCE_RPC_TIMEOUT_MS` stays 2000 and bounds the exchange only. Opening a connection is a separate private seam, `FretService.redial(id)`: one `node.dial` under `deadline(cfg.dialTimeoutMs, runSignal)` — a child of the **run** signal, so it outlives the tick that asked and `stop()` collapses it. An in-flight redial for the same id is returned as the same promise (`Map<string, Promise<RedialResult>>`), so a later tick, a warm-up pass and the dead arm share one dial and one verdict. The seam books its verdict exactly once: a failure that is not our own cancellation → `applyContactFailure(id)`; success books nothing (the `peer:connect` listener records the connection); no backoff inside the seam — each caller's arm adds what it owes. `redialWithin(id, signal)` awaits the redial only until the caller's phase/tick signal fires (`awaitUnlessAborted`), returning `'pending'` then; the dial carries on. `diag.redials = { started, connected, failed }`.

**Callers.** Near pass (`probeAndFetch`): a not-connected target is redialed against the phase-1 signal; `'connected'` → ping + fetch in the same task; anything else → return with no further score. Phase 2 (`probeMembership`): same against the tick signal; on `'failed'` also `backoff.record(id)`. Warm-up (`pingWarmupTargets`): budget sliced first, connected targets are pooled pings, not-connected targets get a fire-and-forget `redial`.

**Config.** `FretConfig.dialTimeoutMs?: number`, default 10 000; non-finite or non-positive throws in the constructor. Hosts on slow relays: `createFret(node, { dialTimeoutMs: 21_500 })`.

**Docs.** `docs/fret.md`: redial bullets under *Stabilization and churn handling*, the *Hard failure* definition, the `MAINTENANCE_RPC_TIMEOUT_MS` sentence under *Stream management*, a warm-up redial bullet under *Active vs passive state*, `dialTimeoutMs` under *Configuration*.

## Review findings

Read the implement diff first, then every method it touches and the seams it leans on (`wasCancelled`, `isConnected` / `hasAddresses` / `isDialable`, `applyContactFailure` / `applyContactStrike`, `stop()` ordering, `stabilizeOnce` phase layout, `nearProbeTargets`, `classifyTargets` / `reprobeOffRingTargets`, the `peer:connect` / `peer:disconnect` listeners, `rpcRequest`'s dial-mode mapping, `deadline`). Checked the happy path, cancellation, dedup, the concurrency cap, run restart, and the interaction between the near pass and the dead arm by reading; ran the three redial-related specs directly and the full gate.

**Checked and found sound (no change):**
- Dedup precedes the cap check, so a waiter for an in-flight dial is never `skipped` by a full cap. The map entry's self-removal is guarded against a successor run's entry; `stop()` aborts the run signal before clearing the map, so every in-flight dial settles `cancelled` and the next run starts fresh.
- `redial` on a never-started service (no run signal) is bounded by `dialTimeoutMs` alone; on a stopped service it returns `cancelled` with no dial. Both are what the hand-driven specs rely on.
- `redialWithin` leaks no listener: the abort listener is `once` and removed on settle; a settle after abort resolves an already-settled promise, a no-op.
- The near pass's `isDialable` partition and the seam's `hasAddresses` check agree, so a near target the seam skips for want of an address is only the disconnect-between-checks race, re-asked next tick.
- The libp2p dial-queue claim (a concurrent `dialProtocol` joins the pending dial and the job aborts only when every joiner's signal has) was verified by the implementer against `dial-queue.js` and `job.js`; the shared-promise design depends on it in one direction only, and that direction holds.
- The two-dials-in-a-killing-tick shape the handoff flagged (the phase-1 redial strikes the third time, the dead arm redials the now-dead peer in phase 2) is bounded by the 500 ms spacing guard and matches the two pings it replaced. Not a defect.
- Edge profile throughput: `maintenanceConcurrency` 2 caps redials at 2 in flight, so with 10 s relayed dials an Edge node reconnects at most ~2 peers per 10 s. Consistent with the profile's stated "fewer probes per window" posture; parked as the tripwire below rather than widened.

**Minor, fixed in this pass:**
- **A peer already connected when `redial` is asked now answers `connected`, not `skipped`.** The handoff listed the race (the peer dials us between `probeAndFetch`'s `isConnected` and the seam's own check) as "that tick does not ping it; next tick does". The honest verdict is that a connection exists, so the caller pings over it in the same tick. No dial is issued and `diag.redials.connected` is not incremented for it (that counter counts dialed verdicts). `RedialResult` doc, method doc, and the spec case updated (`issues no dial and scores nothing when address-less or the cap is full, and answers connected for a peer already connected`).
- **`awaitUnlessAborted` swallowed a rejection as `ABORTED`.** The redial seam never rejects, so the arm was dead, but as a utility it read any bug in the awaited work as "the budget ran out" with no log — the exception-eating the house rules forbid. It now rejects while the caller is still waiting (so a pooled task reports it through `logRejected`) and drops only a rejection landing after the signal fired, which has no listener left. Doc comment restated accordingly.
- **Test helper `slowHandshake`'s wait hung on an already-aborted signal** until its timer fired: no pre-aborted check. Added.
- **Docs drift under *Dialability*:** "Every FRET outbound RPC funnels through one seam" now names the redial as the one non-RPC dial, by the same bare id; "Announce is the one path that dials on purpose" corrected to "the one RPC sender", since the redial dials too.
- **`AGENTS.md` file-size claims** for `fret-service.ts` said ~3600 and ~2960 lines in two places; measured 4106 (`wc -l packages/fret/src/service/fret-service.ts`). Both updated to ~4100.

**Tripwires recorded:**
- `NOTE:` at the cap / address check in `redial`: a request past the concurrency cap or for an address-less peer is `skipped` with no counter by reason; if reconnection on a busy node ever looks slow, count skips by reason in `diag.redials`. (The handoff's "no counter for skipped" gap, now parked at its site.)
- The two `NOTE:`s from the implement pass stand: announce still dials inline under 2 s (`sendAnnouncementsRateLimited`), and `sendMaybeAct` dials a non-connected hop inside the 5 s route budget (the `routeAct` forward).

**Major / tickets filed: none.** No class-level defect found. The size of `fret-service.ts` (4106 lines) is a standing maintainability concern the project already acknowledges in `AGENTS.md` with navigation guidance; extracting the redial seam alone would need an injected bag of seven service callbacks and is not clearly better, so it is recorded here, not filed.

**Tests:** the implementer's eight cases in `test/maintenance-redial.spec.ts` each pin a distinct contract (reproduction, fast path, control, dead-arm backoff, dedup, skip/connected verdicts, cancellation, config validation); none restates the implementation or verifies a mock, so none was cut. The `dead-state.spec.ts` additions (`a ping alone cannot strike a peer with no connection`, `issues no dial ... when the run is cancelled`) pin the `dial: 'never'` wiring and the seam's cancellation gate end to end. No new test added: the already-connected fix changes an assertion in an existing case, and the `awaitUnlessAborted` change has no reachable producer.

**Known gaps carried forward (stated, not fixed):** `pingsFail` no longer counts a failure to reach a non-connected peer (that is `diag.redials.failed`), so a host dashboard reading `pingsFail` as "unreachable neighbours" reads lower; the warm-up pass's "redial not awaited" property is wired but unpinned by a spec (`preconnect-concurrency.spec.ts`'s rig connects every peer).

## Verification

- `yarn check` from root after the review edits: typecheck clean, build clean, **1316 passing, 0 failing** (`tickets/.logs/maintenance-redial.review.check.log`).
- `test/maintenance-redial.spec.ts`, `test/dead-state.spec.ts`, `test/failure-recovery.spec.ts` run directly after the review edits: 66 passing.
