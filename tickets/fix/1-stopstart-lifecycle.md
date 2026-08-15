----
description: Stopping the service does not fully shut it down and restarting it can crash the process or spawn duplicate background loops that never stop, because start and stop are not proper mirror images of each other.
files: packages/fret/src/service/fret-service.ts
difficulty: medium
----
`stop()` and `start()` are asymmetric and leak or duplicate work.

- `stop()` never calls `node.unhandle()`, so a stopped service keeps serving RPCs. On restart, `start()` re-registers the same protocol handlers; libp2p rejects the duplicate registration, and because the call is `void node.handle(...)` that rejection becomes an unhandled promise rejection — process-fatal by default.
- The stabilization and preconnect timers are untracked, so `stop()` leaves pending ticks alive. A stop→start sequence lets an old scheduled tick observe the freshly re-set boolean run flags and keep going, so two concurrent loops end up rescheduling each other forever.
- `start()` has no re-entrancy guard, so calling it twice attaches duplicate event listeners.
- The fire-and-forget bodies `void announceReplacementsToNeighbors(...)` and `void announceOnDeparture(...)` can reject outside any try/catch, producing unhandled rejections.

Expected behavior: `stop()` unregisters handlers and cancels all timers so a stopped service serves nothing and schedules nothing; `start()` is idempotent/guarded; a stop→start cycle results in exactly one live loop; and no handler-registration or fire-and-forget rejection escapes unhandled.

Requirements:
- Call `node.unhandle()` for every registered protocol in `stop()`.
- Attach a `.catch` (log) to each `node.handle(...)` call so a registration failure is handled, not fatal.
- Store timer handles and clear them in `stop()`.
- Replace the shared boolean run flags with a per-run generation token so a stale tick from a previous run detects it is stale and exits instead of rescheduling.
- Add a started-guard so `start()` is safe to call more than once.
- Wrap the `announceReplacementsToNeighbors` and `announceOnDeparture` fire-and-forget bodies in try/log.

References: fret-service.ts `stop()`/`start()` (~364-374, 401-418), stabilization/preconnect scheduling (~828-850, 549-572), fire-and-forget announce sites (~672, 331). Review "Core service" major finding (stop/start lifecycle broken) plus the misc finding's unguarded fire-and-forget note.
