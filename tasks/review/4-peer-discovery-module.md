description: libp2p PeerDiscovery module backed by FRET's Digitree
dependencies: @libp2p/interface (PeerDiscovery, TypedEventTarget), main-event (TypedEventEmitter), FRET core (DigitreeStore)
----

### Summary

Implemented `FretPeerDiscovery`, a libp2p `PeerDiscovery`-compatible module that periodically scans the Digitree store and emits `peer` events for non-dead entries. The module is wired into `Libp2pFretService` for automatic lifecycle management.

### Changes

**New file: `packages/fret/src/service/peer-discovery.ts`**
- `FretPeerDiscovery` extends `TypedEventEmitter<PeerDiscoveryEvents>` and implements `PeerDiscovery`, `Startable`, and `PeerDiscoveryProvider`
- Periodic scan via `setInterval` at configurable `emissionIntervalMs` (default 5s)
- Debounce: tracks emitted peer IDs with configurable TTL (default 10 min); does not re-emit within window
- Dead peer filtering: skips entries with `state === 'dead'`
- Batch size cap: limits peers emitted per scan tick (default 20)
- `peerDiscoverySymbol` getter for libp2p service registration

**Modified: `packages/fret/src/service/fret-service.ts`**
- Added `getStore()` public accessor for the internal `DigitreeStore`

**Modified: `packages/fret/src/service/libp2p-fret-service.ts`**
- Added `FretPeerDiscovery` lifecycle management (start/stop)
- Added `getPeerDiscovery()` accessor returning a `PeerDiscovery` instance
- Updated `ensure()` return type to `CoreFretService` for proper `getStore()` access
- Replaced `(this.inner as any)?.store` cast with proper `core.getStore()` call
- `fretService()` factory now accepts optional `FretPeerDiscoveryConfig`

**Modified: `packages/fret/src/index.ts`**
- Exports `FretPeerDiscovery` and `FretPeerDiscoveryConfig`

**New file: `packages/fret/test/peer-discovery.spec.ts`** (10 tests)
- `peerDiscoverySymbol` implementation check
- `Symbol.toStringTag` correctness
- Emits peer events for store entries on start
- Filters dead peers from emission
- Debounce: single emission within debounce window
- Re-emission after debounce window expires
- Batch size limit per scan tick
- Start idempotency
- Stop clears debounce cache (re-emit on restart)
- Integration: emits peers discovered by CoreFretService stabilization

### Testing

- 10 new peer-discovery tests, all passing
- Full suite: 84 tests passing, 0 failures
- Build: clean TypeScript compilation

### Usage

```typescript
import { FretPeerDiscovery } from 'p2p-fret';

// Standalone
const disc = new FretPeerDiscovery(store, {
  emissionIntervalMs: 5000,
  batchSize: 20,
  debounceMs: 600_000,
});
disc.addEventListener('peer', (evt) => {
  console.log('discovered:', evt.detail.id.toString());
});
await disc.start();

// Via Libp2pFretService
const svc = new Libp2pFretService(components, fretCfg, discoveryCfg);
svc.setLibp2p(node);
await svc.start(); // auto-starts discovery
const discovery = svc.getPeerDiscovery(); // PeerDiscovery interface
```
