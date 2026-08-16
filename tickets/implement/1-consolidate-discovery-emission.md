----
description: Three different pieces of code announce newly found peers to the rest of the networking stack, one of which leaks peers belonging to a different network; collapse them into the single correct one, and connect that one to libp2p properly — today its announcements go nowhere.
files: packages/fret/src/service/discovery.ts, packages/fret/src/service/peer-discovery.ts, packages/fret/src/service/libp2p-fret-service.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/index.ts, packages/fret/test/peer-discovery.spec.ts, docs/fret.md
difficulty: medium
----

## What this is

FRET tells libp2p "here is a peer" from three independent places:

| # | Site | Mechanism | Filtered? |
|---|---|---|---|
| 1 | `discovery.ts` `seedDiscovery` (8–16), called at `libp2p-fret-service.ts:55` | `node.dispatchEvent('peer:discovery')` | **no filter at all** |
| 2 | `fret-service.ts` `emitDiscovered` (1668–1698), called from 4 sites | `node.dispatchEvent('peer:discovery')` | member-only, dead-blind, own debounce map (`announcedIds`) + own token bucket (`bucketDiscovery`) |
| 3 | `peer-discovery.ts` `FretPeerDiscovery.scan` (67–90) | `safeDispatchEvent('peer')` on itself | member-only, non-dead, own debounce map (`emitted`) |

Path 3 is the correct one and this ticket consolidates onto it. Paths 1 and 2 are deleted.

## Two facts established during planning that change the shape of the work

**Fact A — paths 1 and 2 are not the same mechanism as path 3, and are strictly weaker.**
`libp2p.js:81-89` dispatches `peer:discovery` on the node when its *internal* event bus sees a new peer, and `libp2p.js:323-333` (`#onDiscoveryPeer`) is what feeds that bus — it is subscribed to the `peer` event of registered discovery sources and calls `peerStore.merge`. The node's own emitter forwards **internal → node**, never node → internal (`libp2p.js:43-47`). So dispatching `peer:discovery` directly on the node object, which is exactly what paths 1 and 2 do, reaches only application code that added a listener to the node. It never reaches libp2p's peerStore or its auto-dialer. Path 3's `peer` event reaches both.

**Fact B — path 3 is currently wired to nothing, so deleting 1 and 2 without also fixing this is a regression.**
libp2p discovers a service's discovery capability by reading `service[peerDiscoverySymbol]` while constructing the node (`libp2p.js:157-162`). `Libp2pFretService` does not implement that symbol, so the `FretPeerDiscovery` it builds and starts in `start()` has no listeners and its events go nowhere. The alternative wiring — passing `getPeerDiscovery()` into libp2p's `peerDiscovery: []` array — is impossible, because `getPeerDiscovery()` calls `ensure()`, which throws until `setLibp2p()` has run, and `setLibp2p()` cannot run until the node exists.

Fixing B is therefore part of this ticket, not a follow-up. Once fixed, FRET's discovery genuinely lands in the peerStore for the first time.

## Target design

```
DigitreeStore ──scan(tick)──> FretPeerDiscovery ──'peer'──> libp2p #onDiscoveryPeer
                                    ▲                              │
                       one debounce map (`emitted`)                └─> peerStore.merge
                       one filter: member && !dead && !self             └─> node 'peer:discovery'
```

### `FretPeerDiscovery` takes a lazily-resolved source

libp2p reads `peerDiscoverySymbol` during node construction, i.e. before the node reference can be injected into `Libp2pFretService`, so the discovery object must be constructible before the store exists. Give it an input that is resolved per scan:

```ts
/** What one scan tick needs. Resolved lazily: libp2p reads `peerDiscoverySymbol` while
 *  constructing the node, which is before `setLibp2p` can supply the node the store hangs off. */
export interface DiscoverySnapshotSource {
	store: DigitreeStore;
	/** This node's own peer id. Never emitted — libp2p logs an error when a discovery
	 *  source reports self (`libp2p.js:325-328`), and self is always labelled `member`. */
	selfId: string;
}

export type FretPeerDiscoveryInput = DigitreeStore | (() => DiscoverySnapshotSource | null);
```

- A bare `DigitreeStore` keeps working (existing tests and `ring-membership.spec.ts:552` construct it that way); it means "no self id known, emit every matching entry".
- A thunk returning `null` means "not ready yet" — `scan` returns without emitting and without throwing. This is the state between libp2p construction and `Libp2pFretService.start()`.

### `scan` gains a self filter

`scan` walks the whole store, and self is seeded `member` (`fret-service.ts:1287`), so without this filter every debounce window produces one `peer discovery mechanism discovered self` error log from libp2p. Skip the entry whose id equals the resolved `selfId`.

### `Libp2pFretService` implements `peerDiscoverySymbol`

- Build the single `FretPeerDiscovery` in the constructor, passing a thunk that returns `{ store: this.inner.getStore(), selfId: <node peer id> }` once `this.inner` and `this.nodeRef` exist, and `null` before that.
- `get [peerDiscoverySymbol](): PeerDiscovery` returns that instance. It must not call `ensure()` — that throws pre-injection and would break node construction.
- `getPeerDiscovery()` returns the same instance (do not build a second one). Keep the method: an application may want to listen directly.
- `start()` drops the `seedDiscovery` call and keeps `await this.discovery.start()` after `await core.start()`, so the first scan runs against an already-seeded store. libp2p does not start discovery sources reached via the symbol, only registers the listener, so the explicit `start()`/`stop()` stay.

### Deletions

- `packages/fret/src/service/discovery.ts` — whole file, plus its `export { seedDiscovery }` at `index.ts:125` and the import + call in `libp2p-fret-service.ts`.
- `fret-service.ts`: `emitDiscovered` (1668–1698), the `announcedIds` map (162), the `bucketDiscovery` token bucket (161, 255–258), and the now-unused `PeerInfo` type import (line 1).
- The four `emitDiscovered` call sites (1238, 1292, 1351, 1542). At 1238 and 1542 the `discovered` / `announced` delta array is still needed by the `announceToNewPeers` call on the next line — keep it. At 1292 (`seedFromPeerStore`) and 1351 (`seedFromBootstraps`) the array has no other reader, so remove the array and its `if (!this.store.getById(...)) push(...)` bookkeeping.

## Decisions taken (do not reopen)

**Does `scan` subsume `seedDiscovery`?** Yes, and improves on it. `seedDiscovery` ran once against a store that is empty unless `importTable` restored one; `FretPeerDiscovery.start()` calls `scan()` synchronously and then every `emissionIntervalMs`. `importTable` preserves membership labels (see *Routing table persistence* in `docs/fret.md`), so restored members emit on the first tick and restored foreign/dead entries never do — which is the leak this ticket closes.

**Does `scan` subsume `emitDiscovered`?** Yes. `emitDiscovered` fires on the tick a peer id is first learned, but a freshly learned peer is `unknown`, so the member gate skips it — the `NOTE:` at `fret-service.ts:1677` already says as much. The observable change is that a peer that was somehow already `member` when re-learned emits up to `emissionIntervalMs` (5 s default) later. Accepted.

**Debounce ownership:** `FretPeerDiscovery.emitted` only. `announcedIds` and `bucketDiscovery` go with `emitDiscovered`. Rate is now `batchSize / emissionIntervalMs` = 20 per 5 s = 4/s, in the same range as the deleted Edge bucket (3/s) and below Core's (25/s).

**Empty multiaddrs:** keep them empty, and document that FRET discovery is peerStore-relative by design. FRET's wire format carries no addresses at all (`docs/fret.md`, *Dialability*), and the only addresses available locally are the ones libp2p's own peerStore already holds — feeding those back through `#onDiscoveryPeer` merges a peerStore's contents into itself. Changing this needs address hints on the wire, which is the existing backlog ticket `feat-address-hints-in-neighbor-exchange` (its option 1 is exactly this); an arm has been appended there noting the three emission sites collapse to one. Record the decision as a `NOTE:` at the emission site in `peer-discovery.ts`.

## Edge cases & interactions

- **Self is never emitted.** Self is `member` and in the store; assert no `peer` event carries the local peer id when the source supplies a `selfId`.
- **Source not ready.** Thunk returns `null` (libp2p constructed, `Libp2pFretService.start()` not yet run, or `getPeerDiscovery()` called early). `scan` must no-op, not throw; the interval must survive it and emit normally once the source resolves.
- **Bare-store construction still works** unchanged — `peer-discovery.spec.ts` and `ring-membership.spec.ts:552` pass a `DigitreeStore` directly.
- **Restored foreign / dead / unknown entries.** After `importTable`, only `member && !dead` entries may ever be emitted. This is the regression the ticket exists for.
- **start → stop → start.** `stop()` clears `emitted`, so a restart re-emits; the interval must not be left armed, and a second `start()` must not stack a second interval (existing `running` guard).
- **Double registration.** If an application both relies on `peerDiscoverySymbol` and adds its own `peer` listener via `getPeerDiscovery()`, both fire. Same instance, so no duplicate scan; `peerStore.merge` is idempotent. Acceptable — just do not build two instances.
- **Batch drain on a large restored table.** At `batchSize` 20 per 5 s tick, a full 2048-entry table takes ~8.5 min to surface. Fine today (peers are re-learned from the peerStore anyway); park as a `NOTE:` tripwire at `scan`, not a ticket.
- **`announceToNewPeers` must keep firing** at both snapshot-merge sites — it shares the delta array with the deleted `emitDiscovered` call and is easy to remove by accident.
- **Emission ordering in `Libp2pFretService.start()`**: `core.start()` before `discovery.start()`, so the first scan sees a peerStore-seeded table rather than an empty one.

## Tests

`packages/fret/test/peer-discovery.spec.ts` unless noted.

- *never emits self* — store with self (member) + one other member, source thunk supplying `selfId`; emitted ids include the other, exclude self.
- *tolerates a not-yet-ready source* — thunk returns `null`; `start()`, wait two intervals, zero emissions, no rejection; then let the thunk return a real source and assert emission on a later tick.
- *bare store input still emits* — existing tests must pass untouched.
- *`Libp2pFretService` exposes discovery via `peerDiscoverySymbol`* — new or in `libp2p-fret-service` coverage: the symbol is readable on a freshly constructed instance **before** `setLibp2p`, is a `PeerDiscovery`, and is reference-identical to `getPeerDiscovery()` after injection.
- *restored table never leaks a foreign or dead peer* — integration: construct `Libp2pFretService` over an in-memory node, `await importTable(...)` with one `member`, one `foreign`, one `dead` entry, listen on the symbol, `start()`, collect the first scan; only the member id appears. This is the guarantee `seedDiscovery` violated.
- Full suite must stay green — `ring-membership.spec.ts` ("excludes the foreign peer from … discovery") and `network.isolation.spec.ts` (asserts store contents, not emission) both exercise this area.

## TODO

Phase 1 — rework the emission path
- Add `DiscoverySnapshotSource` / `FretPeerDiscoveryInput` to `peer-discovery.ts`; resolve the input at the top of each `scan`, no-op on `null`.
- Add the self filter to `scan`, with the comment explaining libp2p's discovered-self error.
- Add the `NOTE:` for peerStore-relative multiaddrs at the emission site, and the batch-drain tripwire `NOTE:` at `scan`.

Phase 2 — wire it into libp2p
- Build the `FretPeerDiscovery` in the `Libp2pFretService` constructor with the lazy thunk; add `get [peerDiscoverySymbol]()`; make `getPeerDiscovery()` return that instance.
- Drop the `seedDiscovery` import and call from `start()`; keep `core.start()` → `discovery.start()` ordering.

Phase 3 — delete the two dead paths
- Delete `src/service/discovery.ts` and its `index.ts` export.
- Delete `emitDiscovered`, `announcedIds`, `bucketDiscovery`, the `PeerInfo` import, and the four call sites; keep the delta arrays only where `announceToNewPeers` reads them.

Phase 4 — tests and docs
- Write the tests above.
- `docs/fret.md`: in *libp2p integration*, drop `FretService.emitDiscovered` from the member-only sentence, state that `FretPeerDiscovery` is the single emission path and that it reaches libp2p through `peerDiscoverySymbol` on `Libp2pFretService`, and add the peerStore-relative-multiaddr note.
- `cd packages/fret && npx tsc --noEmit` then `yarn test` in the foreground.
