description: A peer with no dialable address (a phone that dials out and listens nowhere) used to stay a live ring member forever after it went away, and its graceful leave notice either never arrived or was undone a tick later. All three departure paths now retire such a peer promptly; this is the code-review pass over that change.
architecture: docs/fret.md#stabilization-and-churn-handling
files: packages/fret/src/service/fret-service.ts (`NearWindow`, `nearProbeTargets`, `strikeUncontactable`, `stabilizeOnce`, `handleLeave`, `markDeparted`), packages/fret/src/service/libp2p-fret-service.ts (`beforeStop`, `stop`, `shutdown`), packages/fret/test/address-less-departure.spec.ts (new), packages/fret/test/churn.leave.spec.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/test/ring-membership.spec.ts, packages/fret/test/libp2p-facade-forwarding.spec.ts, packages/fret/test/stabilize-concurrency.spec.ts, packages/fret/test/failure-recovery.spec.ts, packages/fret/test/scoring-never-creates.spec.ts, docs/fret.md
----
Reported from sereus (`p2p-fret` v1.0.1): always-on members kept an offline phone in their Optimystic cohorts, so every member write waited ~50 s on it and failed.

## What changed

**Arm 1 — an uncontactable live member is a failed contact, once per tick.** `nearProbeTargets` now returns `{ targets, uncontactable }` over the S/P window (`max(2, m)` live members per side). `targets` = dialable members, at most 4, closest first; `uncontactable` = the rest of the window (not connected, no peerStore address). `stabilizeOnce` calls `strikeUncontactable` before phase 1, which runs `applyContactFailure` per id (skipped once the run signal has fired; one debug log line per strike). The existing 500 ms spacing guard makes each 1.5 s passive tick one strike → `dead` after three ticks. Recovery is the existing proof-of-life paths (`peer:connect`, inbound RPC).

**Deviation from the ticket, deliberate:** the ticket said "the same `getNeighbors(selfCoord, 'both', max(2, m))` walk". That walk is successor-biased (documented NOTE on `getNeighbors`): at m = 8 it returns self + 7 successors on any ring of more than nine live members, so predecessors were never verified *and* would never have been struck. The window now comes from `ringNeighborsBothSides` (the same walk `enforceCapacity`'s protection set uses), so **near-probe targets changed** from s1..s4 to s1, p1, s2, p2 on larger rings. Every spec passes; reviewer should judge whether this belongs here or should have been split out.

**Arm 2 — leave notices go out before connections close.** `Libp2pFretService.beforeStop()` runs the whole shutdown (`discovery.stop()`, then core `stop()`); `stop()` runs the same private `shutdown()` and is a no-op by then (both halves idempotent). Verified in libp2p 3.3.11: `Libp2p.stop()` → `components.beforeStop()` → `components.stop()` (the latter is where the connection manager closes connections, under one `Promise.all`). docs A1 lifecycle states that a host using the core `FretService` directly must stop it before its node.

**Arm 3 — a leave notice marks the sender `dead` instead of removing it.** `handleLeave` → `markDeparted` (self-guarded `store.update(id, { state: 'dead' })`) when we hold an entry; nothing when we don't. `dead` survives `seedFromPeerStore` re-seeds and `peer:update`, which is what undid removal.

## Tests

Added — `test/address-less-departure.spec.ts`:
- *marks a vanished address-less member dead after three spaced ticks* — arm 1 reproduction. Observer never started (ticks by hand, `lastContactFailureAt` rewound between them); the phone is a memory node with `listen: []` and no FRET; membership/entry seeded by hand (stand-in for peer:connect + inbound RPC, since memory nodes run no identify and an inbound-only peer is not in the observer's peerStore).
- *delivers a libp2p-hosted address-less peer's leave notice, and the re-seed does not undo it* — arms 2 + 3. Phone hosted via `fretService()` in `services`, `start: false` → `setLibp2p` → `start()`. Observer started with `deadAfterFailures: 1000` so `dead` can only come from the notice (arm 1 would otherwise reach it within a few real ticks). Asserts `dead` within 2 s of `a.stop()`, then still `dead` and out of `getNeighbors` after one more re-seed + tick.
- Mutation-checked: reverting arm 1, arm 2 (renaming `beforeStop`), or arm 3 (`store.remove` back) each reddens exactly the case that names it.

Updated:
- `churn.leave.spec.ts` — "removes the departing peer…" → *marks the departing peer dead, which drops it from the ring window*.
- `rpc.codec-properties.spec.ts` — four sites (the ticket named two; ~1521 and ~1714 also used removal/presence as the observable) now check `state === 'dead'` / `!== 'dead'`.
- `ring-membership.spec.ts` — *does not demote a confirmed member on a single failed negotiation* failed: `svcC.stop()` now delivers a real leave, so A marks C dead and drops it from the ring. That test had only passed before because the re-seed undid the removal (the arm-3 bug). Both negotiate-failure "blip" cases now use a local `stopWithoutNotice` helper (stubs `sendLeaveToNeighbors`, then stops) so the blip is "handlers gone, no notice". Reviewer: confirm that matches the tests' intent.
- `libp2p-facade-forwarding.spec.ts` — `beforeStop` and `shutdown` added to the lifecycle `SKIP_LIST` beside `start`/`stop`; forwarding count stays 20.
- `stabilize-concurrency.spec.ts`, `failure-recovery.spec.ts` — read `.targets` off the new return shape.
- `scoring-never-creates.spec.ts` — header/comment no longer cites leave as the removal path (eviction is the remaining one).

Validation: `npx tsc --noEmit` clean, `yarn build` clean, `yarn test` 1306 passing / 0 failing.

## Known gaps / things to look at

- **Window-only sweep (tripwire, `NOTE:` at `strikeUncontactable`).** On a ring of more than 2·max(2, m) + 1 live members, an address-less member outside our S/P window is never struck by us and stays in our cohorts. Fine for sereus-sized rings; the NOTE says to widen to all live members if cohorts over larger rings start waiting on departed phones.
- **Shutdown latency moved.** The leave fan-out (bounded by `SHUTDOWN_BUDGET_MS`, 3 s) now runs in `beforeStop`, before libp2p closes connections, so a libp2p-hosted node's `stop()` can take up to ~3 s longer when neighbours stall. Previously the fan-out raced the closes and failed fast (which was the bug).
- **`beforeStop` runs concurrently with other components' `beforeStop`** (libp2p `Promise.all`). Nothing in libp2p 3.3.11 implements it; a future component that tears something down there could race us.
- **A departed entry now lingers until capacity evicts it**, like any peer killed by failed contacts; a still-dialable departed peer is pinged by the dead re-probe arm at backoff cadence.
- No diagnostics counter for uncontactable strikes (ticket marked it optional) — only a debug log line.
- `tickets/backlog/22-debt-leave-authentication.md` already carries the interaction note (a liveness ping before acting on a leave would now usually succeed, since the notice is sent while still connected). docs "Not yet implemented" wording updated from "before removal" to "before acting on the notice".
- `tess` submodule shows as modified in the working tree; not touched by this ticket.

## Docs updated (`docs/fret.md`)

Tick bullet (near window + uncontactable strikes), rotation bullet (two-sided near list and why), *Hard failure* (third kind of failed contact; leave as an immediate `dead` source), *Leave* (recipients mark dead, and why), A1 lifecycle (`beforeStop`; core-direct hosts stop FRET before the node), the `ringNeighborsBothSides` call-site list, leave-authentication wording.
