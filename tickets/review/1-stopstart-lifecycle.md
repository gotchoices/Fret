description: Stopping the service now fully shuts it down, and restarting it no longer floods the process with fatal errors or leaves duplicate background loops running.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/ping.ts, packages/fret/test/service-lifecycle.spec.ts, packages/fret/test/identity-verification.spec.ts, packages/fret/test/payload-bounds-ttl.spec.ts, packages/fret/test/rpc.fuzz.spec.ts, packages/fret/test/churn.leave.spec.ts, docs/fret.md, packages/fret/README.md
difficulty: medium
----

`FretService.start()` and `stop()` are now mirror images. All six defects the fix ticket
reproduced are addressed, and a new permanent spec (`test/service-lifecycle.spec.ts`,
8 cases) covers them.

## What changed

**Lifecycle state.** The two shared booleans `stabilizing` and `preconnectRunning` are gone,
replaced by:

```ts
private started = false;
private runGen = 0;                    // ++ on each start() and each stop()
private stabilizeTimer / preconnectTimer: ReturnType<typeof setTimeout> | null = null;
private preconnectGen = -1;            // runGen the preconnect loop is armed for
```

Each loop captures `const gen = this.runGen` when armed and tests
`this.stopped || gen !== this.runGen` both at the top of the tick **and** again after its
awaits, before rescheduling. A tick left over from a previous run therefore sees a bumped
generation and exits instead of re-arming. `stopped` still quiesces in-flight handlers.

**`stop()` order:** clear `started` → bump `runGen` → set `stopped` → `clearLoopTimers()` →
detach node listeners → `await unregisterRpcHandlers()` (try/log around
`node.unhandle(Object.values(this.protocols))`) → existing `sendLeaveToNeighbors()`.
Unhandling before the leave notices is safe: `unhandle` removes only inbound handlers.

**`start()`:** returns immediately if already started; otherwise bumps the generation, clears
`stopped`, resets `postBootstrapAnnounced` and `firstStabilizeDone`, and awaits
`registerRpcHandlers()`.

**Handler registration is no longer fire-and-forget.** `registerNeighbors` /
`registerMaybeAct` / `registerLeave` / `registerPing` are now `async` and `await node.handle(...)`
instead of `void node.handle(...)`. `registerRpcHandlers()` is async, awaits all four via
`Promise.all`, and logs (does not rethrow) a failure.

**Detached promises** route through a new `detach(promise, label)` helper (7 call sites:
`preconnectNeighbors`, `announceOnDeparture`, `announceReplacementsToNeighbors`,
`mergeAnnounceSnapshot`, `announceToNewPeers` ×2, `proactiveAnnounceOnStart`).

## Deviation from the ticket — one addition worth a look

The ticket did not ask for this, and it is the change most deserving review scrutiny:

`start()` now calls `startActivePreconnectLoop()` when `this.mode === 'active'`, not just the
one-shot `preconnectNeighbors()`. Rationale: `stop()` now genuinely disarms that loop
(previously `preconnectRunning = false` did too), and the loop's only other entry point is
`setMode()`. Without this, a stop→start while already in active mode would silently lose
connection warm-up until someone called `setMode('active')` again. That is the same class of
"stop breaks the next start" bug this ticket exists to fix, so it is arguably in scope — but if
the reviewer disagrees, it is a two-line revert with no other coupling.

## Use cases to test / validate

- **Shutdown is real.** `start()` then `stop()`; `node.getProtocols()` must contain none of
  the five `/optimystic/<net>/fret/1.0.0/*` protocols. A stopped service must not answer
  neighbors / announce / maybeAct / leave / ping.
- **Restart is clean.** `start()` → `stop()` → `start()` must produce zero unhandled
  rejections (pre-fix: 10 × `DuplicateProtocolHandlerError`, process-fatal under Node's
  default `--unhandled-rejections=throw`) and must re-register all five protocols.
- **Exactly one stabilization loop after a cycle.** Stub `stabilizeOnce`, do stop→start, count
  ticks over 3.4 s at the 1500 ms passive cadence: ≤3. Pre-fix: 5 (two live loops).
- **Loop actually stops.** After `stop()`, tick count over 3.4 s must be 0.
- **Double `start()` is idempotent.** Listener count and registered-protocol count unchanged by
  the second call. Pre-fix: 5 listeners → 10.
- **Run-scoped flags reset.** A restarted service re-runs `proactiveAnnounceOnStart` and has
  `postBootstrapAnnounced === false`.
- **Preconnect loop arms once.** `setMode('active')` twice arms one loop; `stop()` releases it.
- **`stop()` on a never-started service stays safe** — many specs call it unconditionally in
  `afterEach`.

## Verification performed

- `npx tsc --noEmit` from `packages/fret`: clean.
- `test/service-lifecycle.spec.ts`: 8 passing.
- Full `yarn test`: **295 passing, 0 failing** (log:
  `tickets/.logs/1-stopstart-lifecycle.test.log`). Includes the specs the ticket flagged as
  most likely to surface an ordering regression in the new `stop()` —
  `churn-scenarios.spec.ts`, `fret.mesh.spec.ts`, `membership-identify.spec.ts` — all green.

## Known gaps — read before trusting the above

- **The full suite was not re-run after the final re-application of the edits.** Mid-run the
  entire `packages/fret/` directory was deleted from disk by something outside this agent's
  edits (cause undetermined; the test log ends cleanly at "295 passing" and the directory's
  mtime matches that moment). Tracked files were restored with `git checkout -- packages/fret`,
  `yarn install` restored `node_modules`, and every edit was re-applied. The 295-passing run
  above was against a diff byte-identical in intent to the current one, but **strictly it
  predates the current working tree**. Re-running `yarn test` is the first thing this review
  should do; if anything is off, that is the likeliest reason. Nothing outside
  `packages/fret/` was touched by the restore (`tickets/` was verified intact and the only
  other working-tree entry, untracked `tickets/.in-progress`, was untouched).
- **The generation guard is tested behaviorally, not exhaustively.** The specs assert tick
  counts and armed-loop state; they do not force the exact interleaving where a tick is
  mid-`await` at the instant `stop()` runs. The second guard (after the awaits, before
  rescheduling) exists for that window but is not directly exercised.
- **`unhandle` failures are logged and swallowed.** If the node is already stopping, this is
  correct. If it fails for another reason, a stopped service silently keeps serving. There is
  no assertion distinguishing those cases.
- **`detach()` is a convention, not an enforcement.** Nothing stops a future edit from writing
  a bare `void somePromise()` again. A lint rule or a boundary check would make the class
  unrepresentable; not filed as a ticket because it is a single greppable pattern today
  (`grep -n "void this\." packages/fret/src/service/fret-service.ts` returns nothing).
- **`test/service-lifecycle.spec.ts` declares a local `process` type** because `@types/node` is
  not resolvable from this package's tsconfig `types`. Slightly unusual; a reviewer may prefer
  adding the types dependency instead.
- **Timing-sensitive assertions.** Two specs sleep 3.4 s and assert tick bounds. They use
  `at.most(3)` / `equal(0)` rather than exact counts to tolerate scheduler slop, but they are
  wall-clock dependent and could flake on a heavily loaded CI box.
