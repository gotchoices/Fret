description: libp2p PeerDiscovery module backed by FRET's Digitree
dependencies: @libp2p/interface (PeerDiscovery, TypedEventTarget), main-event (TypedEventEmitter), FRET core (DigitreeStore)
----

### Summary

`FretPeerDiscovery` is a libp2p `PeerDiscovery`-compatible module that periodically scans the Digitree store and emits `peer` events for non-dead entries. It is wired into `Libp2pFretService` for automatic lifecycle management.

### Files

- `packages/fret/src/service/peer-discovery.ts` — `FretPeerDiscovery` class (PeerDiscovery + Startable)
- `packages/fret/src/service/fret-service.ts` — Added `getStore()` public accessor
- `packages/fret/src/service/libp2p-fret-service.ts` — Discovery lifecycle management, `getPeerDiscovery()` accessor, `fretService()` accepts optional config
- `packages/fret/src/index.ts` — Exports `FretPeerDiscovery` and `FretPeerDiscoveryConfig`
- `packages/fret/test/peer-discovery.spec.ts` — 10 tests

### Key Design Points

- Periodic scan via `setInterval` at configurable interval (default 5s)
- Debounce: tracks emitted peer IDs with configurable TTL (default 10 min)
- Dead peer filtering: skips entries with `state === 'dead'`
- Batch size cap per scan tick (default 20)
- Memory-bounded: prunes expired debounce entries when map exceeds 4096

### Validation

- 10 peer-discovery tests passing (symbol compliance, emission, dead filtering, debounce, batch limits, idempotency, stop/restart, integration)
- Full suite: 84 tests passing, 0 failures
- Clean TypeScript build
