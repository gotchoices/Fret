description: FRET no longer re-reads and re-decodes libp2p's whole list of known peers (and re-parses its bootstrap addresses) every 1.5 seconds; the list is read once at start, its changes arrive as events, and a slow 5-minute re-read catches the few changes libp2p makes silently.
prereq: maintenance-redial-off-the-tick
architecture: docs/fret.md#dialability-can-we-reach-this-peer-at-all
files: packages/fret/src/service/fret-service.ts, packages/fret/test/per-tick-hotpath.spec.ts, packages/fret/test/service-lifecycle.spec.ts, packages/fret/test/address-less-departure.spec.ts, packages/fret/test/membership-identify.spec.ts, packages/fret/test/failure-recovery.spec.ts, docs/fret.md, docs/threat-analysis.md
----
Fixes gotchoices/Fret#2: libp2p's `pbToPeer` and multiaddr parsing showed in an idle phone CPU profile because every stabilization pass ran `seedFromPeerStore()` (`peerStore.all()` decodes every record) and `seedFromBootstraps()`.

## What landed (`ticket(implement): peerstore-reseed-on-change`)

- The loop pass is `runStabilizationPass()`: the address backstop (`reconcileAddressesFromPeerStore`) only when `PEERSTORE_BACKSTOP_INTERVAL_MS` (300 000 ms) has passed since the last walk began, then `stabilizeOnce()`.
- `start()`: `attachPeerStoreListeners()` → `seedFromPeerStore()` (start walk) → `seedFromBootstraps()` → `enforceCapacity()` → RPC handlers → loop → connect/disconnect listeners.
- One creation helper, `notePeerStorePeer`, shared by the `peer:update` / `peer:identify` listeners and the start walk: create at the hearsay baseline through `noteDiscovered` on a miss, leave a held entry untouched, then classify off the protocol list.
- `readPeerStore()` rebuilds the address-known set wholesale; ids written by an event while `peerStore.all()` was pending keep the event's answer (per-walk "touched" sets, removed in a `finally`).
- Bootstraps parsed once in the constructor; seeded once per `start()`.
- Docs: `docs/fret.md` (Dialability, Relevance scoring incl. "Eviction sticks", Two phases, Recovery, Leave, Mirroring, Evidence strength, Ring membership, Replace by id, self-import) and `docs/threat-analysis.md` §2.1 / §4.5.

## Review findings

**Checked, by reading the diff first and then the surrounding code:**
- *Correctness of the event-wins rebuild* (`readPeerStore`): every per-peer write to the address set goes through `setAddressKnown` (grep confirms the only other writer is the rebuild swap), all post-await work is synchronous, and the `finally` closes the window on throw or `stop()`. Correct. Two overlapping walks can let the older snapshot finish last and overwrite the newer one's answer for ids no event touched; that only matters for libp2p's silent hour-scale changes, so not worth code.
- *libp2p contract the design rests on*: confirmed in `@libp2p/peer-store` that `peer:update` is dispatched only when `result.updated` (`#emitIfUpdated`), so an unchanged merge is silent as the ticket claims; `PeerUpdate` carries `previous`.
- *Listener attach before the start walk*: a throw later in `start()` leaves `started = true`, so `stop()` still detaches them — same as before for the connect listeners. Listeners check `stopped` and do no RPC.
- *Synchronous classification for a held entry* in `notePeerStorePeer`: the async body runs to `classifyByProtocols` before its first await on the held arm, as the membership-identify spec needs.
- *Self*: no longer re-upserted per tick. Nothing removes self (`enforceCapacity` protects it, `importTable` drops a snapshot's self record, the leave path marks `dead` rather than removes, and `noteDiscovered` refuses self). Fine.
- *Bootstrap that is self, or already held*: skipped before hashing. Fine.
- *Resource cleanup*: no new timer (the backstop rides the loop's run generation); per-walk sets cleaned in `finally`; nothing to clear on `stop()` since `start()` rebuilds.
- *Behaviour change — hearsay baseline for peerStore-learned peers instead of relevance 0*: intended, matches the documented `noteDiscovered` rule; full suite green, no eviction spec affected. No new test (the baseline is `noteDiscovered`'s contract, already pinned by `relevance.eviction.spec.ts`).
- *Tests*: the new (d) case in `per-tick-hotpath.spec.ts` is the ticket's success measure and would redden if a per-pass walk returned (reads would be 4, not 1). The reworked lifecycle case and the (c) capacity case (now asserting it starts over capacity, so it is not vacuous) are sound.

**Found and fixed in this pass (minor):**
- `per-tick-hotpath.spec.ts` (d): removed a spy wrapping the private `seedFromBootstraps` — the store assertion that the bootstrap never appears already proves a pass did not seed it, without mocking an owned method.
- `per-tick-hotpath.spec.ts`: the coordinate-reuse comment still cited the deleted `tickets/backlog/plan/2-routing-table-export-integrity`; now points at `tickets/backlog/4-debt-import-table-coordinate-verification`.
- `address-less-departure.spec.ts`: `tick()`'s doc said "as the loop drives it: the peerStore re-seed, then the tick", no longer true; rewritten to say it is the old per-tick shape, kept as the stronger test (the walk is a superset of what a `peer:update` can do). Header comment updated likewise.

**Tripwire parked (no ticket):**
- `classifyByProtocols` NOTE (`fret-service.ts`): any `peer:update` — not only a protocol change — re-applies the stored protocol list, so a record another service churns often (tags, addresses) would re-apply a stale-positive list just as often and could again keep a non-serving peer from demoting to `foreign` on a deployment without `identifyPush`. Extended the existing NOTE with the fix to reach for (compare against the event's `previous` list).

**Considered and not acted on:**
- Backstop uses `Date.now()` (wall clock); a backwards clock jump delays it. Matches every other interval in the service, and the cost of a late backstop is a failed dial. No note added.
- `docs/threat-analysis.md` §4.5 cites `fret-service.ts:662-684`, line numbers that were stale before this ticket. Left alone.
- Listener inserts between passes overshoot capacity until the next pass trims them — already documented in *Two phases* and the widened accepted-cost NOTE in `stabilizeOnce`.

**No new tickets filed.** Nothing found past the filing bar.

**Validation:** `npx tsc --noEmit` clean; `yarn test` from `packages/fret`: 1317 passing, 0 failing.
