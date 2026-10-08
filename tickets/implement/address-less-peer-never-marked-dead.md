description: A peer with no dialable address (a phone that dials out and listens nowhere) is never contacted after it disconnects, so it is never marked dead and stays a live ring member forever; and when it shuts down gracefully its leave notice is sent after its connections are already closed, and even a leave that does arrive is undone by the next maintenance tick. Make all three paths retire a departed peer promptly.
architecture: docs/fret.md#stabilization-and-churn-handling
files: packages/fret/src/service/fret-service.ts (`nearProbeTargets`, `stabilizeOnce`, `applyContactFailure`, `handleLeave`, `seedFromPeerStore` for context), packages/fret/src/service/libp2p-fret-service.ts (`stop`, add `beforeStop`), packages/fret/test/dead-state.spec.ts or a new spec, packages/fret/test/churn.leave.spec.ts (the "removes the departing peer" case), packages/fret/test/rpc.codec-properties.spec.ts (~1097, ~1447: use removal as the observable), packages/fret/test/scoring-never-creates.spec.ts (header comment), docs/fret.md ("Stabilization and churn handling" → hard failure / recovery; "Leave"; "Aspect-oriented implementation plan" → A1 lifecycle)
repro: verified
----
Reported from sereus (`p2p-fret` v1.0.1). Sereus's always-on members keep a phone owner in their Optimystic cohorts after the phone goes offline, so every member write waits on it for the whole commit budget (~50 s) and fails with `Some peers did not complete: <phone>`.

## Reproduction (FRET-local, verified 2026-10-07)

A scratch spec (since deleted) used two memory-transport nodes: B listens; A is built with `addresses: { listen: [] }` and dials B. Both run FRET with `k: 7`. The spec waited until B labelled A `member`, stopped A, then logged B's entry for A (`state/membership/contactFailures`) on every change.

| Case | B's entry for A after A stops |
| --- | --- |
| Ungraceful: A's libp2p node stops, A's FRET never sends a leave notice | `disconnected/member/cf=0` for the whole observation window, which is the bug |
| libp2p-hosted A (`Libp2pFretService` registered as a service), `a.stop()` | log shows `sendLeave to <B>: unreachable`; entry stays `disconnected/member/cf=0`, which is the bug |
| Core FRET stopped *before* its node (`fa.stop()` then `a.stop()`) | leave lands, entry `absent` for ~1.5 s, then **re-created `disconnected/member/cf=0` at the next tick** and stays that way, which is a third bug |

Prototype of the fixes below, same rig:

| Change applied | Result |
| --- | --- |
| Arm 1 only, ungraceful case | `cf=1` at 1.5 s, `cf=2` at 3.0 s, `dead` at 4.5 s |
| Arms 1 + 2, libp2p-hosted, `handleLeave` still removes | `absent` at once, re-created `disconnected/member/cf=1` at 1.5 s, `dead` at 4.5 s. So the leave notice protects the peer for only one tick |
| Arms 1 + 2 + 3, libp2p-hosted | `dead` at once (4 ms) and still `dead` through the following ticks |

## Causes

**Arm 1: an address-less peer is never contacted.** A peer reaches `dead` only after `deadAfterFailures` (3) failed contacts spaced at least 500 ms apart (`applyContactStrike`), and a contact is an outbound RPC. `nearProbeTargets` (`fret-service.ts`, ~2466) filters the near window with `isDialable` (connected, or the peerStore holds an address). A phone is neither once its connection drops, so it is never pinged, never fails, and stays a live member indefinitely. No other pass rescues it: the classify, foreign and dead re-probe arms all require dialability too, and `peer:disconnect` is, by design, not a strike.

**Arm 2: the leave notice is sent too late.** libp2p's `stop()` runs `components.beforeStop()`, then `components.stop()`. That second call runs every component's `stop()` under one `Promise.all` (`node_modules/libp2p/dist/src/components.js`, `_invokeStartableMethod`), and the connection manager's `stop()` closes every connection at the same time. `Libp2pFretService.stop()` reaches `sendLeaveToNeighbors` only after `discovery.stop()` and `unregisterRpcHandlers()`, by which point the connections are gone. Nothing else in libp2p 3.3.11 implements `beforeStop`, so the facade has that hook to itself.

**Arm 3: the next tick undoes a delivered leave.** `handleLeave` calls `store.remove(from)`. On the next stabilization tick, `seedFromPeerStore` walks `peerStore.all()`. libp2p still holds the departed peer's record there, including the protocols negotiated with it. The walk re-`upsert`s the peer and `classifyByProtocols` labels it `member` again. (`peer:update` has the same effect.) The original ticket listed this as a tripwire; the prototype shows it fires on every graceful departure. `dead`, by contrast, survives re-seeding, because `upsert` preserves `state` and classification touches only `membership`.

## Design (recommended; prototyped as above)

**Arm 1: a live member in the near window that cannot be contacted counts as a failed contact.** Change `nearProbeTargets` to report the live members in its window (the same `getNeighbors(selfCoord, 'both', max(2, m))` walk, self excluded) that `isDialable` rejects, in addition to the dialable targets it returns today. For example, return `{ targets, uncontactable }`. `stabilizeOnce` then passes each uncontactable id to `applyContactFailure`. That function is the existing seam: it decays relevance and adds a spaced strike. Notes:
- Strike every uncontactable member in the window, not only those that would have made the top 4. The cap of 4 limits RPCs, and no RPC is involved here.
- The existing 500 ms spacing in `applyContactStrike` makes each 1.5 s passive tick one independent observation, so the peer is `dead` after three ticks (~4.5 s, measured). Recovery needs no new code. A phone comes back by reconnecting: `peer:connect` and any inbound RPC call `noteProofOfLife`. Once the peer is dead, the live-member filter drops it from the near window, so the strikes stop.
- Place the strikes after the `stop()`/generation guard. The work is local (no RPC), so the tick budget does not apply. Strike only if the run signal has not aborted, for consistency with "our own cancellation is not evidence".
- The documented rule that an idle `peer:disconnect` is not a strike stays true. The strike is for "cannot be contacted at all", observed once per tick. It is not tied to the disconnect event, so a phone that reconnects within a tick or two is never struck. Update the hard-failure bullet in `docs/fret.md` to list this as a third kind of failed contact, next to the thrown dial, stream or read.
- Consider a log line or a diagnostics counter for these strikes. Optional.

**Arm 2: send the leave fan-out before connections close.** Add `beforeStop()` to `Libp2pFretService` that runs what `stop()` runs today (`discovery.stop()`, then `inner?.stop()`). Keep `stop()` as is. Core `stop()` is idempotent (it returns early unless started), so the later libp2p `stop()` call becomes a no-op. Hosts that drive the facade by hand still get the same shutdown. Running the core's whole stop in `beforeStop` is simpler than splitting it, and the registrar is still live at that point, so unhandle works. Document in the A1 lifecycle bullet that a host using the core `FretService` directly (not as a libp2p service) must stop it before stopping its node, or its leave notices cannot go out.
- `test/libp2p-facade-forwarding.spec.ts` checks that the forwarded member count matches the `FretService` interface. `beforeStop` belongs to `Startable`, not `FretService`, so that spec may need nothing. Check it.

**Arm 3: a leave notice marks the departing peer `dead` instead of removing it.** In `handleLeave`, when we hold an entry for `from`, call `store.update(from, { state: 'dead' })` (self can never be `from`, because the identity check rejects that, but keep the self guard that `applyContactStrike` uses). If we hold no entry, there is nothing to do; `store.remove` was a no-op in that case too. Why `dead` and not a separate "departed" tombstone:
- It reuses the semantics FRET already has. A dead peer is excluded from every ring view (`isLiveMember`), survives `upsert` re-seeds and `peer:update`, is skipped by `isDoomedDial`, is an unprotected eviction victim, and is restored by any proof of life (`peer:connect`, inbound RPC, a successful dead-arm re-probe). A peer that left and later restarts comes back through the same path.
- A tombstone would need its own map, lifetime and capacity, and would duplicate all of that.
- Cost: the entry stays in the table until capacity evicts it, instead of being freed at once. That is what already happens to a peer marked dead by failed contacts. The `peer:disconnect` that follows a graceful departure already calls `applyFailure`, which decays its relevance.
- If the departed peer is dialable, the dead re-probe arm will ping it at backoff cadence (Core 2 / Edge 1 per tick, shared with other dead peers). That is acceptable and matches how any other dead peer is treated.
- Leave the `contactFailures` counter alone. `noteDisconnected` never clears `dead`, and `noteProofOfLife` clears both the counter and the label.
- Update docs/fret.md *Leave* ("Recipients remove the departing peer" becomes "mark it dead"), the *Per-leave outbound ceiling* bullet if its wording depends on removal, and the rate-limited-leave paragraph ("keeps a routing-table entry for a peer that has gone — until … marks it dead": still true). Add to *Hard failure* that a leave notice is a second, immediate source of `dead`.

## Alternatives considered and rejected

- **Strike on `peer:disconnect` for a peer with no address.** One event cannot meet a threshold of three spaced observations, and it would strike a phone that reconnects within moments.
- **`seedFromPeerStore` skips creating an entry for an undialable peer.** That handles arm 3 only for address-less peers. An addressed peer that left would still be re-created as a live `member` and stay one until three probes fail (~4.5 s). Marking it `dead` covers both shapes.
- **Optimystic drops address-less cohort members; cadre-core marks the entry dead itself; the control write excludes unreachable members.** See the original fix ticket's reasoning: shrinking the cohort makes the supermajority unreachable; marking from cadre-core reaches past FRET's seam and duplicates its rule; Optimystic owns the commit. FRET is the right owner.

## Interactions

- `tickets/backlog/22-debt-leave-authentication.md` plans a liveness ping before acting on a leave, and refuses removal if the peer answers. Arm 2 sends the notice while the departing peer is still fully connected, so that ping would usually succeed and every graceful leave would be refused. A note to that effect has been added to that ticket. No action is needed here.
- Existing specs that put fake live members with no addresses around self and then run several `stabilizeOnce` ticks will now see those members struck, and marked dead after three ticks at least 500 ms apart. Run the full suite. Where a spec's subject is not liveness, make the fixture dialable (`setAddressKnown(id, true)`, as `churn.leave.spec.ts` does) instead of weakening its assertions.

## Tests (one per behaviour)

- **Arm 1 reproduction:** two memory nodes; A has `listen: []` and dials B; wait until B labels A `member`; stop A's node only, with no graceful FRET stop. Expect B's entry for A to reach `dead` after three spaced strikes. Drive it with `stabilizeOnce` and rewind `lastContactFailureAt` between ticks, as `test/dead-state.spec.ts` does, rather than sleeping ~4.5 s of real ticks. Add a positive control: reconnecting A, or an inbound RPC from A, restores it. The existing recovery tests may already cover that, so don't duplicate.
- **Arms 2 + 3 reproduction:** A is libp2p-hosted (`Libp2pFretService` as a service, `listen: []`, built with `start: false`, then `setLibp2p`, then `start()`). After `a.stop()`, B's entry for A is `dead` at once, and is still `dead`, not `member`, after one more `stabilizeOnce` on B. That second check is the re-seed regression.
- Update the existing "removes the departing peer from the id map and from the ring window" case in `churn.leave.spec.ts` to assert `state === 'dead'` and absence from the ring window. Update the two `rpc.codec-properties.spec.ts` sites that use removal as their observable to check `state !== 'dead'` / `=== 'dead'` instead.

## TODO
- Arm 1: `nearProbeTargets` reports uncontactable live members; `stabilizeOnce` strikes them through `applyContactFailure`.
- Arm 2: `Libp2pFretService.beforeStop()` runs the shutdown, and `stop()` stays idempotent.
- Arm 3: `handleLeave` marks the departing peer `dead` instead of removing it.
- Tests as listed above; fix any fixtures that strike unintentionally under arm 1.
- docs/fret.md: hard-failure (third failed-contact kind, leave as an immediate `dead` source), Leave (mark dead), A1 lifecycle (`beforeStop`; core-direct hosts must stop FRET before the node).
- `cd packages/fret && npx tsc --noEmit && yarn test`.
