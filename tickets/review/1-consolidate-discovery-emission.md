---
description: FRET used to announce newly found peers to libp2p from three different places, one of which leaked peers belonging to a different network — and none of which libp2p actually listened to. All three are now one path, and it is properly connected.
files: packages/fret/src/service/peer-discovery.ts, packages/fret/src/service/libp2p-fret-service.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/index.ts, packages/fret/test/peer-discovery.spec.ts, packages/fret/test/profile.behavior.spec.ts, docs/fret.md
difficulty: medium
---

## What landed

Three emission paths collapsed to one, and that one wired into libp2p for the first time.

**Deleted**
- `packages/fret/src/service/discovery.ts` (whole file — `seedDiscovery`, the unfiltered path that dispatched *every* store entry including foreign and dead ones), its `export` from `src/index.ts`, and its call in `Libp2pFretService.start()`.
- `FretService.emitDiscovered` and everything it owned: the `announcedIds` debounce map, the `bucketDiscovery` token bucket (field + constructor init), the now-unused `PeerInfo` type import, and its four call sites.

**Reworked — `FretPeerDiscovery` (`peer-discovery.ts`)**
- Constructor input widened from `DigitreeStore` to `FretPeerDiscoveryInput = DigitreeStore | (() => DiscoverySnapshotSource | null)`, where `DiscoverySnapshotSource` is `{ store, selfId }`. Resolved at the top of every `scan`, not captured. Needed because libp2p reads `peerDiscoverySymbol` off a service while *constructing* the node, which is before the node (and therefore the store) exists.
- A thunk returning `null` = "not ready": the tick no-ops, the interval stays armed. A thunk that *throws* is caught and logged with the same result (the thunk runs on a timer, so an escaping throw would be an unhandled rejection).
- New self filter: an entry whose id equals the resolved `selfId` is skipped. Self is seeded `member` and lives in the store, so without it every debounce window produced one "discovery mechanism discovered self" error from libp2p. A bare-store input has no self id and emits everything matching, unchanged.
- Two `NOTE:` tripwires added: batch-drain rate at `scan` (2048-entry table takes ~8.5 min to surface at 20 per 5 s), and peerStore-relative multiaddrs at the emission site.

**Reworked — `Libp2pFretService`**
- Builds the single `FretPeerDiscovery` in its constructor with a lazy thunk (`discoverySource()`, which returns `null` until both `inner` and `nodeRef` exist and deliberately does not call `ensure()` — that throws pre-injection).
- New `get [peerDiscoverySymbol]()` returns it. **This is the fix that makes FRET discovery reach libp2p at all**: the node reads that symbol during construction and subscribes to the object's `peer` event, merging into its peerStore and auto-dialer. The two deleted paths dispatched `peer:discovery` directly at the node object, which only reaches application listeners — libp2p forwards internal → node, never node → internal, so the peerStore never saw them.
- `getPeerDiscovery()` returns that same instance (no second build). `start()` keeps `core.start()` → `discovery.start()` ordering so the first scan sees a peerStore-seeded table.

## How to validate

```
cd packages/fret
npx tsc --noEmit
yarn build
yarn test
```

Both clean; **437 passing, 0 failing** (~5 min).

Targeted: `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/peer-discovery.spec.ts" --timeout 30000` — 16 passing.

### Use cases the new tests pin

In `test/peer-discovery.spec.ts`:
- *never emits self when the source supplies a self id* — two members in the store, thunk names one as self; the other is emitted, self is not.
- *tolerates a not-yet-ready source, then emits once it resolves* — thunk returns `null` for two intervals (zero emissions, no rejection), then returns a real source and the peer emits on a later tick. This is the libp2p-constructed-but-service-not-started window.
- *survives a throwing source thunk* — same shape, but the thunk throws instead of returning `null`.
- *exposes a PeerDiscovery via `peerDiscoverySymbol` before the node is injected* — reads the symbol on a freshly constructed `Libp2pFretService` with no `setLibp2p` call (must not throw — libp2p does exactly this), then asserts `getPeerDiscovery()` is reference-identical after injection.
- *never leaks a foreign or dead peer from a restored routing table* — the regression `seedDiscovery` caused. `importTable` with one `member` and one `foreign` entry over an in-memory node, listen via the symbol, `start()`, collect: only the member appears; foreign, dead, and self do not.
- All pre-existing bare-store tests untouched and green, including `ring-membership.spec.ts`'s "excludes the foreign peer from … discovery" and the `CoreFretService` integration test.

`test/profile.behavior.spec.ts` lost its `bucketDiscovery` row (the bucket no longer exists); a comment there records why and what bounds the rate now (`batchSize / emissionIntervalMs` = 4/s default, between the deleted Edge 3/s and Core 25/s).

## Known gaps / things worth an adversarial look

- **The `dead` arm of the restored-table test does not come through `importTable`.** `importEntries` forces every restored entry to `state: 'disconnected'` (liveness cannot survive a restart), so a `dead` entry is unrepresentable in a snapshot. The test imports that peer as `member` and then sets it dead directly on the store via a cast — `(svc as unknown as { inner: CoreFretService }).inner.getStore()`. That cast reaches a private field; it is the only way in without widening the public surface, but it will break silently if `inner` is renamed. Worth a reviewer's judgment on whether a narrow test accessor is preferable.
- **No test asserts that libp2p's peerStore actually receives the merged peer.** The tests assert on the `peer` event via the symbol, which is the interface libp2p subscribes to — one layer short of end-to-end. Proving the merge needs a node constructed with the service in its `services` map plus an observable peerStore write; I judged that out of scope, but it is the claim the ticket rests on and it is currently argued from libp2p's source (`libp2p.js:157-162`, `323-333`), not from a test.
- **Behavior change, accepted in planning, not separately tested:** a peer that was somehow already `member` when re-learned now emits up to `emissionIntervalMs` (5 s default) later than it used to, because the delta-triggered `emitDiscovered` is gone. In practice a freshly learned peer is `unknown` and the old path skipped it anyway.
- **`announceToNewPeers` is the one thing easy to break here** and there is no new test guarding it. It shares the `discovered` / `announced` delta array with the deleted `emitDiscovered` call at both snapshot-merge sites (`mergeAnnounceSnapshot`, `mergeNeighborSnapshots`); the arrays were kept there and removed only in `seedFromPeerStore` / `seedFromBootstraps` where nothing else read them. Verify by inspection that both `detach(this.announceToNewPeers(...))` calls survive.
- **Double registration is possible but benign** — an application that both relies on the symbol and adds its own listener via `getPeerDiscovery()` gets both, on one instance, so no duplicate scan and `peerStore.merge` is idempotent.
- `docs/review.html` still contains the old review write-up naming `seedDiscovery`; it is a generated artifact from an earlier review pass and was left alone.
