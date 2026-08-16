----
description: Outgoing network calls have no overall time limit — only the reply-reading step is capped — so a peer that accepts a connection but never answers, or is slow to connect in the first place, can hold up background maintenance indefinitely.
files: packages/fret/src/utils/deadline.ts (new), packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.protocols.spec.ts, packages/fret/test/deadline.spec.ts (new)
difficulty: medium
----

Every FRET outbound RPC is `openRpcStream` → write → `readAllBounded`. Only the last step
is bounded (`readAllBounded`, 5 s default). The two steps before it are not:

- `openRpcStream` (`src/rpc/protocols.ts:227`) calls `connection.newStream(...)` or
  `node.dialProtocol(...)` with `{ runOnLimitedConnection, negotiateFully }` and **no
  `signal`**, even though both accept one (`NewStreamOptions extends AbortOptions`,
  `@libp2p/interface`; `Libp2p.dialProtocol(peer, protocols, options?: NewStreamOptions)`).
  A dial that hangs — no address, unresponsive transport, half-open TCP — hangs the caller.
- The `finally` block in each sender does `await stream.close()`. On a stream whose remote
  has stalled, that close is itself unbounded, so the *cleanup* of a timed-out read can hang
  after the read's own deadline fired. `MessageStream.abort(err: Error): void` is synchronous
  and is the correct call on the failure path (`@libp2p/interface` `message-stream.d.ts:144`).
- Nothing anywhere carries an `AbortSignal`, so neither `stop()` nor a caller-imposed budget
  can cancel an RPC in flight.

Expected behavior: every outbound RPC completes, fails, or is cancelled within a stated
budget; `stop()` does not wait on background RPCs; a stream abandoned by timeout or
cancellation is released immediately rather than left to the muxer's own timeout (outbound
stream caps are 64 Edge / 256 Core, so leaked streams are a real ceiling).

### Deadline helper

New `src/utils/deadline.ts`, alongside the existing `token-bucket.ts` / `expiring-map.ts`:

```ts
export interface Deadline {
	readonly signal: AbortSignal;
	/** Clear the timer and detach the parent listener. MUST be called in a `finally`. */
	cancel(): void;
}

/** A signal that aborts after `ms`, or as soon as `parent` aborts, whichever is first. */
export function deadline(ms: number, parent?: AbortSignal): Deadline;
```

Built from `AbortController` + `setTimeout` + a parent `abort` listener — deliberately **not**
`AbortSignal.timeout` / `AbortSignal.any`, which are absent on React Native (Hermes) and older
browsers, and this codebase is cross-platform by rule.

`cancel()` is mandatory, not hygiene: an uncleared `setTimeout` keeps the Node process alive
and the repo's mocha exit watchdog (`test/mocha-exit-watchdog.ts`) fails the run on exactly
that. An undetached parent listener accumulates one entry per RPC on a long-lived run signal.

### Threading

`openRpcStream` gains `signal?: AbortSignal` in its options bag and forwards it into both
`newStream` and `dialProtocol` (merged into the existing `streamOpts`, which must stop being
`as const` to carry it).

`readAllBounded` gains `opts?: { signal?: AbortSignal }` and races the abort alongside its
existing deadline/poll race. On abort it throws — the same contract as its timeout, which is
already "a partial read is an error, never a short-but-valid result". Keep the existing
`pending.catch(() => {})`, or the abandoned `iter.next()` becomes an unhandled rejection.

Each of the five senders takes `opts: { signal?: AbortSignal; timeoutMs?: number } = {}` as a
trailing parameter (all five already take `protocol` as a trailing default, so this appends):

| sender | file | default `timeoutMs` |
|---|---|---|
| `sendPing` | `rpc/ping.ts:60` | 5000 |
| `fetchNeighbors` | `rpc/neighbors.ts:67` | 5000 |
| `announceNeighbors` | `rpc/neighbors.ts:105` | 5000 |
| `sendMaybeAct` | `rpc/maybe-act.ts:31` | 5000 |
| `sendLeave` | `rpc/leave.ts:59` | 5000 |

5000 is the *existing* `readAllBounded` default, so the default budget is unchanged in
magnitude — what changes is that it now covers dial + open + read rather than read alone.
Each sender: `const d = deadline(opts.timeoutMs ?? RPC_TIMEOUT_MS, opts.signal)` at entry,
`d.cancel()` in `finally`, `d.signal` passed to `openRpcStream` and `readAllBounded`, and the
read given the *remaining* budget (`deadline` owns the wall clock; pass `d.signal` and leave
`readAllBounded`'s own `timeoutMs` at the same value — the signal fires first or together).

`RPC_TIMEOUT_MS = 5000` exported from `rpc/protocols.ts` next to the other shared RPC
constants, so the four call families cannot drift.

Failure-path cleanup in every sender's `finally`: if the deadline signal aborted, call
`stream.abort(err)` (synchronous) instead of `await stream.close()`. On the success path
`close()` stays.

`sendPing` additionally starts its RTT clock *after* `openRpcStream` resolves — the dial is
not round-trip time and currently inflates first-contact latency into peer health scoring.
(This is also a listed requirement of `8-rpc-shared-helper`; landing it here is the same
one-line move and removes it from that ticket's list.)

### Service-side signals

`FretService` gains one run-scoped controller:

- `private runAbort: AbortController | null` — created in `start()` (after the `runGen++`),
  aborted in `stop()` **immediately after `clearLoopTimers()`**, i.e. *before*
  `unregisterRpcHandlers()` and the leave fan-out. Background maintenance RPCs die at once
  and do not compete with teardown.
- Exposed to call sites as `private get runSignal(): AbortSignal | undefined`.
- The leave fan-out must **not** use it (it runs after the abort, by design). `stop()` builds
  its own `deadline(SHUTDOWN_BUDGET_MS)` for `sendLeaveToNeighbors`, passing that signal plus
  `timeoutMs: 1500` per notice, and cancels it in a `finally`. `SHUTDOWN_BUDGET_MS = 3000`:
  the fan-out is `announceFanout`-bounded (Core 8 / Edge 4) and `isDoomedDial`-filtered, so
  3 s is generous for the reachable targets while capping a `stop()` that would otherwise
  serialize several dead dials.

Every existing outbound call site passes `{ signal: this.runSignal }`; the maintenance passes
additionally pass a tighter `timeoutMs` (see below). Call sites, all in
`service/fret-service.ts`: `probeNeighborsLatency` (~1657), `probeMembership` (~1801),
`preconnectNeighbors` (~1213), the active preconnect tick (~1239),
`mergeNeighborSnapshots`'s `fetchNeighbors` (~1830), `sendAnnouncementsRateLimited` (~1164),
`sendLeaveToNeighbors`, and the `sendMaybeAct` sites on the forward / iterative-lookup paths.

Per-site `timeoutMs` overrides:

- maintenance pings (`probeNeighborsLatency`, `probeMembership`, both preconnect paths):
  **2000**. A ping is a ~50-byte round trip; 5 s only ever means "this peer is gone", and the
  ping paths are the ones that must not hold a maintenance tick open.
- `announceNeighbors`: **2000**, same reasoning (fire-and-forget push, no reply of substance).
- `fetchNeighbors`, `sendMaybeAct`, `sendLeave`: leave at the 5000 default. `sendMaybeAct` in
  particular returns only once the *whole remaining route* has completed downstream, so its
  budget is a route budget, not a link budget — tightening it is out of scope here.

### Cancellation is not evidence about the peer

This is the correctness crux. Today every thrown error from an outbound RPC reaches
`noteRpcFailure` (`fret-service.ts:589`), which routes anything that is not an
unsupported-protocol error into `applyContactFailure` — a strike toward marking the peer
`dead` after 3 spaced failures.

Two aborts must be told apart:

- **The RPC's own `timeoutMs` fired** → the peer accepted nothing / answered nothing in the
  budget. This is genuine unreachability and keeps today's semantics: a contact failure.
- **A caller signal fired** (`stop()`, or the tick budget added by
  `stabilize-tick-concurrency`) → we gave up, the peer said nothing either way. This must
  record **nothing**: no `applyContactFailure`, no `applyFailure`, no `recordBackoff`, no
  `diag.pingsFail` increment.

Without this, a `stop()` or a busy tick manufactures strikes against healthy neighbors and
can mark them `dead` — inverting the ticket's intent.

Implementation: no new error types are needed, because the *caller* holds the signal it
passed. Add one guard on `FretService`:

```ts
/** True when `err` is (or follows) our own cancellation — not evidence about the peer. */
private wasCancelled(sig: AbortSignal | undefined): boolean { return sig?.aborted === true; }
```

and at each catch site check the signal *the call site passed* before scoring. Note the
subtlety: the sender's internal deadline signal is a *child* of the caller signal, so the
caller's own signal is aborted only in the cancellation case — checking the caller's signal
(not the sender's) is what discriminates the two. Document that at the guard.

## Edge cases & interactions

- **Cancellation must not score.** Covered above; the single highest-value assertion in this
  ticket. Also applies to `probeMembership`'s `recordBackoff` — a cancelled probe must not
  push a peer into a longer backoff window it never earned.
- **`deadline.cancel()` on every path.** Success, throw, and abort. A leaked timer fails the
  mocha exit watchdog rather than merely leaking, so this surfaces as a whole-suite failure
  with a confusing message.
- **Already-aborted signal at entry.** `deadline(ms, parent)` where `parent.aborted` is
  already true must produce an aborted signal synchronously, and the sender must fail without
  dialing. Otherwise a `stop()` racing a tick still issues dials.
- **Abort during dial vs during read vs during close.** All three must release the stream:
  during dial there is no stream yet (nothing to abort); during read, `stream.abort(err)`;
  during close, the close is already best-effort in a `try {} catch {}`.
- **`fetchNeighbors` swallows everything today** and returns a fabricated empty snapshot on
  any failure (`neighbors.ts:86-88`). A timeout there therefore still looks like success to
  the caller. Do **not** fix that here — it is `8-rpc-shared-helper`'s "fetchNeighbors
  fabricates success" arm — but do make sure the fabricated-snapshot path still runs the
  deadline `cancel()` and does not leave a stream open.
- **`announceNeighbors` and `sendLeave` already catch-and-log internally**, so their timeouts
  are invisible to callers by design. Keep it; just bound them.
- **Limited (circuit-relay) connections** already get `runOnLimitedConnection: true`; adding
  `signal` to the same options object must not disturb that or `negotiateFully: false`.
- **Inbound handlers are out of scope.** `readAllBounded`'s handler-side use keeps its 5 s
  budget and no signal; the slow-loris NOTE at `readAllBounded` still stands.
- **A start→stop→start cycle** must mint a fresh controller. A reused, already-aborted
  controller silently cancels every RPC of the new run — the same class of bug the `runGen`
  generation counter exists to prevent, so mirror its placement.
- **`stop()` ordering.** Abort *after* `clearLoopTimers()` and *before* the leave fan-out. The
  fan-out deliberately runs on its own shutdown deadline; asserting `stop()` still delivers
  leave notices is a required test, since aborting one step too early silently deletes the
  graceful-departure protocol.

## Tests

- `test/deadline.spec.ts` — fires after `ms`; `cancel()` before `ms` leaves the signal
  un-aborted and clears the timer (the suite passing the exit watchdog is the timer
  assertion); parent abort propagates immediately; `cancel()` after a parent abort is safe;
  an already-aborted parent yields an already-aborted child synchronously; double `cancel()`
  is a no-op.
- `test/rpc.protocols.spec.ts` (extend the existing stub-node harness there) — `openRpcStream`
  forwards `signal` into both `newStream` and `dialProtocol`; an already-aborted signal means
  `dialProtocol` is never called.
- New RPC-timeout cases against a stub node: a `dialProtocol` that never resolves →
  `sendPing({ timeoutMs: 100 })` rejects in ≈100 ms (today: never). A stream that opens but
  never yields a chunk → same. Both are the ticket's headline bug; assert elapsed wall time,
  not just rejection.
- Service-level: with a stubbed node whose dial hangs, `stop()` resolves within
  `SHUTDOWN_BUDGET_MS` + slack **and** leave notices still reach the reachable neighbors.
- Service-level: abort the run signal mid-probe; assert the target peer's `contactFailures`
  is unchanged, it is not `dead`, and no backoff entry was recorded.
- The existing suites are the no-regression gate — `churn.leave`, `dead-state`,
  `ring-membership`, `service-lifecycle`, `fret.mesh`, `libp2p-memory.integration` all
  exercise these senders on the happy path.

## TODO

### Phase 1 — helper
- Add `src/utils/deadline.ts` with `deadline()` / `Deadline` as specified; no
  `AbortSignal.timeout` / `AbortSignal.any`.
- Add `test/deadline.spec.ts`.

### Phase 2 — RPC layer
- Export `RPC_TIMEOUT_MS = 5000` from `rpc/protocols.ts`.
- `openRpcStream`: accept and forward `signal`.
- `readAllBounded`: accept and race `signal`; keep the `pending.catch`.
- Thread `{ signal, timeoutMs }` through all five senders; `deadline()` at entry,
  `cancel()` in `finally`, `stream.abort(err)` on the aborted path.
- Move `sendPing`'s RTT clock to after `openRpcStream` resolves.
- Extend `test/rpc.protocols.spec.ts` with the forwarding + timeout cases.

### Phase 3 — service
- Add the run-scoped `AbortController` (`start()` mints, `stop()` aborts right after
  `clearLoopTimers()`), plus the `runSignal` getter.
- Give `sendLeaveToNeighbors` its own `SHUTDOWN_BUDGET_MS` deadline and per-notice
  `timeoutMs: 1500`.
- Pass `{ signal: this.runSignal }` at every outbound call site; add the 2000 ms override on
  the ping and announce paths.
- Add the `wasCancelled` guard and apply it at every catch site that scores a peer
  (`probeNeighborsLatency`, `probeMembership`, and any `sendMaybeAct` catch that reaches
  `noteRpcFailure`).
- Add the two service-level tests.

### Phase 4 — validate
- `cd packages/fret && npx tsc --noEmit`
- `cd packages/fret && yarn test`
- Update `docs/fret.md`: the *Stream management* bullet currently says the read deadline is
  the only budget — restate it as a whole-RPC budget covering dial + open + read, and add the
  "our own cancellation is not evidence about the peer" rule next to the `deadAfterFailures`
  discussion under *Stabilization and churn handling*.
