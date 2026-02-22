description: Register FRET as a libp2p PeerDiscovery module
dependencies: FRET core (Digitree, S/P sets), libp2p interfaces
----

Implement a libp2p `peerDiscovery`-compatible interface backed by FRET's Digitree.

### Behavior

- Emit `peer` events from S/P/F entries as they are discovered or updated.
- Prune: don't re-emit recently emitted peers (debounce window).
- Respect start/stop lifecycle of the discovery interface.
- Filter dead peers from emission.

### Interface

- Implements the standard libp2p PeerDiscovery interface (tag, start, stop, EventEmitter with 'peer' events).
- Configurable emission interval and batch size.

See [fret.md](../docs/fret.md) — libp2p integration, Integration adapters (A10).
