description: Stopping the service now fully shuts it down, and restarting it no longer floods the process with fatal errors or leaves duplicate background loops running.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/ping.ts, packages/fret/test/service-lifecycle.spec.ts, docs/fret.md, packages/fret/README.md
----

`FretService.start()` and `stop()` are mirror images, and both are idempotent. Shipped and
reviewed.

## What shipped

**Run generation replaces the shared booleans.** `stabilizing` and `preconnectRunning` are
gone. `runGen` is bumped by both `start()` and `stop()`; each background loop captures the
generation it was armed for and exits — rather than rescheduling — once it no longer matches.
A boolean cannot do this: `stop()` clears it but cannot cancel a pending timer, and the next
`start()` sets it back to true, so the stale tick resurrects itself and the service ends up
running two loops. Both loops also store their timer handle so `stop()` cancels them outright,
and both re-check the generation *after* their awaits so a `stop()` landing mid-tick cannot
re-arm the timer on the way out.

**`stop()` is a real shutdown.** Order: return early if no run is in progress → clear
`started` → bump `runGen` → set `stopped` → clear loop timers → detach node listeners →
`unhandle` all five protocols → send leave notices. Unhandling before the leaves is safe:
`unhandle` removes only inbound handlers.

**`start()` is guarded and resets run-scoped state.** Returns immediately if already started;
otherwise bumps the generation, clears `stopped`, resets `postBootstrapAnnounced` and
`firstStabilizeDone`, and awaits handler registration.

**Handler registration is awaited, not fire-and-forget.** `registerNeighbors` /
`registerMaybeAct` / `registerLeave` / `registerPing` are `async` and `await node.handle(...)`.
Without this, a restart produced ten `DuplicateProtocolHandlerError` rejections — process-fatal
under Node's default `--unhandled-rejections=throw`.

**Detached async work routes through `detach(promise, label)`,** which attaches a logging
catch. Nine call sites; no bare `void <promise>` remains in `src/`.

## Review findings

### Checked

Read the implement diff first (`git show 1aa3f2b`) before the handoff summary, then walked the
lifecycle state machine for interleavings, the adjacent lifecycle layers, source hygiene, and
docs. Re-ran the full suite — the handoff's top ask, since it warned its own 295-passing run
predated the working tree after a mid-run directory loss and restore.

Baseline before any review edits: `npx tsc --noEmit` clean, `yarn test` **295 passing, 0
failing**. The handoff's tree was sound; that gap is closed.

### Fixed in this pass (minor)

- **`stop()` was not idempotent.** A second `stop()` — or one on a never-started service — ran
  the whole teardown again, including a fresh leave fan-out of up to ten outbound streams to
  peers already told goodbye, plus a spurious `runGen` bump. Specs double-stop routinely
  (`libp2p-memory.integration.spec.ts` stops a service at line 277 and again in its `afterEach`;
  the new lifecycle spec's `afterEach` does the same). Fixed with an early return in `stop()`
  when no run is in progress, mirroring the guard `start()` already had. Covered by a new spec.
- **Two `void tick()` sites bypassed `detach()`** — the stabilization loop and the active
  preconnect loop, i.e. the two loops this ticket exists to fix. Their tick bodies have internal
  try/catch, but the generation guards, the `release()` call and the `setTimeout` assignment sit
  outside it, so a throw there escapes as an unhandled rejection: exactly the process-fatal class
  the ticket eliminated everywhere else. The handoff's own grep (`void this\.`) could not see
  them because the call is on a local. Both now route through `detach()`.
- **The test file's local `process` type declaration was unnecessary.** The handoff justified it
  with "`@types/node` is not resolvable from this package's tsconfig `types`" — that is not so:
  `@types/node` is a devDependency of `p2p-fret` and `packages/fret/tsconfig.json` sets no
  `types` array, so the default type-root sweep picks it up. Shim removed; `npx tsc --noEmit`
  from `packages/fret` is clean without it. Worth knowing: the in-editor language server *does*
  report `Cannot find name 'process'` here — it is resolving a different project context than the
  documented compiler invocation. Trust `npx tsc --noEmit`; do not re-add the shim.

### Fixed in this pass (test coverage)

The implementer's eight specs cover the cadence and registrar-state behaviors well. Three gaps
closed, taking `service-lifecycle.spec.ts` to 11 cases and the suite to **298 passing**:

- **Post-stop refusal was asserted only through the registrar.** The ticket's own use-case list
  says "a stopped service must not answer neighbors / announce / maybeAct / leave / ping", but the
  spec only checked that `node.getProtocols()` no longer lists them. Added a spec that dials the
  namespaced ping from a second node holding an open connection and asserts the negotiation
  fails with `UnsupportedProtocolError` — the view that actually matters is the peer's.
- **The second generation guard was untested,** as the handoff admitted. Added a spec that parks
  a stabilization tick mid-`await` on a controllable promise, calls `stop()` while it is parked,
  then releases it. It asserts on `stabilizeTimer`, not on tick counts: a tick armed after
  `stop()` still short-circuits at the top guard, so a count-based assertion would pass either
  way. Mutation-verified — removing the guard fails the spec with the timer object present.
- **Double-`stop()`** now has a spec, counting leave fan-outs.

### Parked as tripwires (not tickets)

Both are conditional — fine now, only work if the condition trips — so they are `NOTE:` comments
at their exact sites in `fret-service.ts`, not queue entries:

- `registerRpcHandlers` logs and continues on failure, so a registrar error yields a service that
  looks started but answers nothing, with no signal to the caller. Acceptable while the only
  realistic failure is duplicate registration, which `start()` already guards.
- `unregisterRpcHandlers` swallows an `unhandle` failure. Correct when the node is already
  stopping; a failure for any other reason would leave a stopped service still serving. Not
  distinguished today because libp2p's registrar `unhandle` is a map delete that cannot throw.

### Checked and clean — no finding

- **Active-preconnect arm/release interleavings.** Walked `setMode` churn, `setMode('active')`
  before `start()`, `setMode` on a stopped service, and a stale tick racing a restart. No path
  leaves two live loops or a permanently-held arm slot: `release()` only clears the slot when the
  tick still owns the current generation, and a tick arriving on a stopped service releases
  immediately at its top guard.
- **A stale tick overwriting the live loop's timer handle.** Impossible — reaching the assignment
  requires `gen === runGen`, which means the tick *is* the live loop.
- **`unhandle(Object.values(this.protocols))`.** `makeProtocols` returns five strings and nothing
  else, so no non-protocol value reaches `unhandle`.
- **Restart safety one layer up.** `Libp2pFretService.start/stop`, `FretPeerDiscovery.start/stop`
  (already guarded by a `running` flag and `clearInterval`), and `seedDiscovery` (dispatches
  events only — registers no listeners) are all safe under repeated start/stop.
- **Docs.** `docs/fret.md` A1 and the `README.md` `await registerPing` snippet both match the
  shipped code; extended the A1 text to state that `stop()` is idempotent as well as `start()`.
  No other file documents the lifecycle.

### Considered and declined

- **`start()` leaves `started = true` if it throws part-way through.** Resetting it looks tidier
  but is wrong: it would make the subsequent `stop()` an early-return no-op and orphan whatever
  had already been registered. Left as-is. Unreachable in practice anyway — both awaits in
  `start()` swallow their own errors.
- **The `startActivePreconnectLoop()` call the handoff flagged in `start()`.** Keeping it. Since
  `stop()` now genuinely disarms that loop and its only other entry point is `setMode()`, dropping
  it would mean a stop→start while already in active mode silently loses connection warm-up until
  someone calls `setMode('active')` again — the same "stop breaks the next start" class this
  ticket exists to fix.

### No tickets filed

Nothing rose to major. Every finding was a one-line fix or a missing test at a site already in
this diff, so there was no class to retire with a type change, property test, or boundary
invariant — filing point tickets for them would have been queue noise. `detach()` remains a
convention rather than an enforced invariant, which the handoff correctly flagged; it stays
uncontracted because the pattern is a single greppable form and `src/` now has zero violations
(the two this review found are fixed), so a lint rule would guard an empty set.

## Verification

- `npx tsc --noEmit` from `packages/fret`: clean.
- `yarn build`: clean.
- `yarn test`: **298 passing, 0 failing** (log: `tickets/.logs/1-stopstart-lifecycle.review.log`).
  Includes the specs most likely to catch an ordering regression in the new `stop()` —
  `churn-scenarios.spec.ts`, `churn.leave.spec.ts`, `fret.mesh.spec.ts`,
  `libp2p-memory.integration.spec.ts`, `membership-identify.spec.ts` — all green.
- No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written.

## Residual risk

Two specs sleep 3.4 s and assert tick bounds (`at.most(3)` / `equal(0)`). They are wall-clock
dependent and use loose bounds to tolerate scheduler slop, but could flake on a heavily loaded
CI box. Left as-is: the alternative is fake timers, which would stop exercising the real
`setTimeout` re-arm path that is the whole subject of this ticket.
