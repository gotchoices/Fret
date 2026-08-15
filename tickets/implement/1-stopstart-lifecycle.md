----
description: Stopping the service does not fully shut it down, and restarting it floods the process with fatal errors and leaves two copies of the background maintenance loop running forever. Make stop a true mirror of start.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/ping.ts, packages/fret/test/identity-verification.spec.ts, packages/fret/test/payload-bounds-ttl.spec.ts, packages/fret/test/rpc.fuzz.spec.ts, packages/fret/test/churn.leave.spec.ts
difficulty: medium
repro: verified
----

`FretService.start()` and `FretService.stop()` are not mirror images. Every defect below
was reproduced against `main` with a throwaway mocha spec over in-memory libp2p nodes
(`test/helpers/libp2p.ts` → `createMemNode`); observed numbers are quoted per item. The
repro spec was deleted after the run — recreating it as a permanent spec is part of this
ticket (skeleton at the bottom).

## Observed behavior

**1. `stop()` leaves all five protocol handlers registered.**
`stop()` never calls `node.unhandle()`. Measured: `node.getProtocols()` contains 5 FRET
protocols after `start()` and still 5 after `stop()`. A "stopped" service keeps serving
neighbors / announce / maybeAct / leave / ping requests.

**2. Restart raises unhandled `DuplicateProtocolHandlerError` rejections.**
Because the handlers were never removed, `start()` → `stop()` → `start()` re-registers the
same protocols; libp2p's registrar rejects duplicates. The registrations are made as
`void node.handle(...)` inside `src/rpc/*.ts`, so nothing observes the rejection. Measured:
**10 unhandled rejections**, all `DuplicateProtocolHandlerError`. Node's default
`--unhandled-rejections=throw` makes that process-fatal.

**3. A stop→start cycle leaves two stabilization loops running.**
`startStabilizationLoop`'s tick reschedules itself with an untracked `setTimeout`, and its
only exit test is the shared `stabilizing` boolean. `stop()` clears the boolean but cannot
cancel the pending timer; the next `start()` sets the boolean back to `true`, so when the
stale timer fires it sees a truthy flag, runs, and reschedules — alongside the loop the new
`start()` created. Measured with a counting stub over `stabilizeOnce`: 2 ticks in 1.6 s
before the cycle (correct for the 1500 ms passive cadence), **5 ticks in 3.4 s after** the
cycle (~2 ticks expected) — i.e. two live loops. The active-preconnect loop
(`startActivePreconnectLoop`, 1000 ms) has the identical shape via `preconnectRunning`.

**4. `start()` has no re-entrancy guard.**
Calling it twice attaches every node event listener twice and re-registers every protocol.
Measured: **10 tracked listeners** after a double `start()` (5 expected), plus 10 unhandled
`DuplicateProtocolHandlerError`.

**5. Detached async work can reject with no catch.**
`void this.announceOnDeparture(...)` (~342), `void this.announceReplacementsToNeighbors(...)`
(~689) and `void this.announceToNewPeers(...)` (~828, ~1102) call methods with **no internal
try/catch**; each awaits `this.snapshot()` and a store walk. A throw there becomes an
unhandled rejection exactly like case 2. (`preconnectNeighbors` ~311,
`proactiveAnnounceOnStart` ~888 and `mergeAnnounceSnapshot` ~782 already wrap their bodies —
they are safe today, but nothing at the call site enforces that.)

**6. Run-scoped flags are never reset.** `postBootstrapAnnounced` and `firstStabilizeDone`
stay `true` across a stop→start, so a restarted service skips its post-bootstrap announce
and its first-tick proactive announce.

## Target design

Lifecycle state becomes a **run generation** plus an explicit started flag, replacing the two
shared booleans (`stabilizing`, `preconnectRunning`) that a stale tick can misread:

```ts
private started = false;
private runGen = 0;                                   // ++ on each start() and each stop()
private stabilizeTimer: ReturnType<typeof setTimeout> | null = null;
private preconnectTimer: ReturnType<typeof setTimeout> | null = null;
private preconnectGen = -1;                           // runGen the preconnect loop was started for
```

Each loop captures `const gen = this.runGen` when it starts and tests
`if (this.stopped || gen !== this.runGen) return;` both at the top of the tick and before
rescheduling. A tick from a previous run therefore sees a bumped generation and exits
instead of re-arming — the stale tick can no longer be resurrected by a later `start()`.
The `stopped` flag stays: it is what quiesces in-flight handlers mid-await.

`stop()` becomes a strict mirror, in this order: bump generation and clear `started`; set
`stopped`; clear both timers; detach node listeners; `await node.unhandle(Object.values(this.protocols))`
(try/log — the node may already be stopping); then the existing `sendLeaveToNeighbors()`.
Unhandling before the leave notices is correct: `unhandle` only affects inbound handlers,
while leave notices go out over our own outbound streams.

`start()` returns immediately if `started`, otherwise bumps the generation, clears `stopped`,
resets the run-scoped flags (`postBootstrapAnnounced`, `firstStabilizeDone`), and proceeds.
`stop()` on a never-started service stays safe (tests call it in `afterEach` unconditionally).

Handler registration stops being fire-and-forget. The four `register*` functions in
`src/rpc/` become `async` and `await node.handle(...)`; `registerRpcHandlers()` becomes async,
awaits them, and logs (does not rethrow) a registration failure, so a failed registration is
a logged error rather than a process-fatal rejection. `node.unhandle` is
`(protocols: string | string[]) => Promise<void>` — verified in
`@libp2p/interface` — so one call with `Object.values(this.protocols)` removes all five.

Detached promises route through one helper so the pattern is greppable and uniform:

```ts
/** Attach a logging catch to an intentionally-detached promise so a rejection can never escape. */
private detach(promise: Promise<unknown>, label: string): void {
	void promise.catch((err) => log.error('%s failed - %e', label, err));
}
```

## TODO

- Add `started`, `runGen`, `stabilizeTimer`, `preconnectTimer`, `preconnectGen`; delete the
  `stabilizing` and `preconnectRunning` booleans and every read of them.
- Rewrite `startStabilizationLoop` to capture `gen`, store the timer handle, and guard both
  entry and reschedule on `!this.stopped && gen === this.runGen`.
- Rewrite `startActivePreconnectLoop` the same way; its "already running" guard becomes
  `if (this.preconnectGen === this.runGen) return;` (it is re-entered from `setMode`).
- Add the `start()` guard + generation bump + reset of `postBootstrapAnnounced` and
  `firstStabilizeDone`.
- Rewrite `stop()` in the mirror order above; add `unregisterRpcHandlers()` doing a
  try/log `await this.node.unhandle(Object.values(this.protocols))`.
- Make `registerNeighbors` / `registerMaybeAct` / `registerLeave` / `registerPing` async
  (`await node.handle(...)`, drop the `void`); make `registerRpcHandlers` async with a
  try/log around the awaited registrations, and `await` it in `start()`.
- Update the direct `register*` call sites in tests to `await`:
  `test/identity-verification.spec.ts` (~49, ~65, ~81, ~102, ~123),
  `test/payload-bounds-ttl.spec.ts` (~66), `test/rpc.fuzz.spec.ts` (~11),
  `test/churn.leave.spec.ts` (~188). Awaiting also removes a latent
  register-vs-dial race those specs currently rely on timing for.
- Add the `detach()` helper and route the detached calls at ~311, ~342, ~689, ~782, ~828,
  ~888, ~1102 through it. Also make the bare `tick();` at the end of `startStabilizationLoop`
  a `void tick();` to match `startActivePreconnectLoop`.
- Add `test/service-lifecycle.spec.ts` covering all four observed failures (skeleton below).
  Assert the double-`start()` case as "listener count unchanged by the second call", not a
  hardcoded 5, so adding a listener later does not break it.
- Verify: `cd packages/fret && npx tsc --noEmit`, then `yarn test`. Pay attention to
  `test/churn-scenarios.spec.ts`, `test/fret.mesh.spec.ts` and
  `test/membership-identify.spec.ts` — they start/stop many services and are the specs most
  likely to surface an ordering regression in the new `stop()`.

### Repro skeleton (verified failing on `main`; should pass after the fix)

```ts
import { createMemNode } from './helpers/libp2p.js'
import { FretService } from '../src/service/fret-service.js'
import { makeProtocols } from '../src/rpc/protocols.js'

// 1. handlers gone after stop()
const mine = Object.values(makeProtocols('net'))
await svc.start(); await svc.stop()
expect(node.getProtocols().filter((p) => mine.includes(p))).to.have.length(0)

// 2. no unhandled rejection across a restart
const rejections: unknown[] = []
process.on('unhandledRejection', (r) => rejections.push(r))
await svc.start(); await svc.stop(); await svc.start()
await new Promise((r) => setTimeout(r, 300))
expect(rejections).to.have.length(0)

// 3. exactly one stabilization loop after a stop→start
;(svc as unknown as { stabilizeOnce: () => Promise<void> }).stabilizeOnce = async () => { ticks++ }
await svc.start(); await svc.stop(); await svc.start()
ticks = 0; await new Promise((r) => setTimeout(r, 3400))
expect(ticks).to.be.at.most(3)          // 1500 ms passive cadence; 5 observed pre-fix

// 4. double start() does not duplicate listeners
await svc.start(); const n = listenerCount(); await svc.start()
expect(listenerCount()).to.equal(n)     // 5 → 10 pre-fix
```

Source ticket: `tickets/fix/1-stopstart-lifecycle.md`. Originating review finding: "Core
service" major finding (stop/start lifecycle broken) plus the misc finding's unguarded
fire-and-forget note.
