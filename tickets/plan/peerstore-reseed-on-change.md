description: Every 1.5 seconds FRET re-reads and re-decodes libp2p's entire list of known peers, and re-parses its configured bootstrap addresses, even when nothing in either has changed. Do this work only when the list actually changes.
prereq: maintenance-redial-off-the-tick
architecture: docs/fret.md#dialability-can-we-reach-this-peer-at-all
files: packages/fret/src/service/fret-service.ts (seedFromPeerStore and its NOTEs, seedFromBootstraps, startStabilizationLoop, addressKnown / setAddressKnown, peer:update / peer:identify listeners, classifyByProtocols, adoptPeerRecord, start), packages/fret/test/address-less-departure.spec.ts, packages/fret/test/ring-membership.spec.ts, docs/fret.md
----
Reported as gotchoices/Fret#2 (p2p-fret 1.0.2, via sereus on phones). This ticket covers the reporter's suggestion 3. The `NOTE:` at `seedFromPeerStore` already proposes it ("gate the re-seed itself on a peerStore change/epoch"), and its revisit condition — tick cadence and cost on constrained hosts — has now tripped: `pbToPeer` and multiaddr parsing show up in the reporter's emulator CPU profile while idle.

## Problem

Every stabilization pass starts with two seeds:

- **`seedFromPeerStore`** calls `peerStore.all()`, which decodes every stored record (protobuf to `Peer`, multiaddr parsing). For each peer it then upserts the routing-table entry, re-classifies membership from the protocol list, and adopts a signed peer record if the entry holds none. It also rebuilds the `addressKnown` set wholesale and re-upserts self. On a stable node every one of those operations is a no-op, apart from the decode cost.
- **`seedFromBootstraps`** re-parses up to 8 configured bootstrap strings as multiaddrs and SHA-256-hashes each peer id, then calls `noteDiscovered`. That call leaves an id already held untouched. The configuration is static for the life of the run.

## Expected behavior

The per-pass full peerStore walk goes away. Its four jobs move to the events that signal the change:

- **New or updated peer** (upsert, protocol classification, record adoption, has-addresses): `peer:update`, which libp2p fires on every peerStore merge, including the first one for a never-seen peer. The `peer:update` and `peer:identify` listeners already do classification, record adoption and `setAddressKnown`. Extend them to do the upsert, through the same hearsay rules the walk uses today.
- **Addresses dropped**: the wholesale rebuild of `addressKnown` is today the only path by which a peer whose addresses the peerStore dropped stops reading as dialable. The event path must cover that too: `peer:update` carries the previous peer, and plan stage must check what libp2p v3 emits when a peer is deleted from the peerStore.
- **Self**: upserted and marked `member` once at `start()`. Nothing rotates self's coordinate.
- **Startup**: `start()` keeps one full walk, since peers identified before the service started produced no event we heard.

Plan stage decides whether a slow full re-walk remains as a backstop for missed events (e.g. once every few minutes, or when a `stabilize-idle-backoff` reset fires). If it stays, it must be documented as a backstop rather than as the primary path.

Bootstraps are parsed and hashed once per run (at `start()` or construction), and the parsed ids and coordinates are cached. The per-pass work, if any is kept, is the cheap "is this bootstrap still in the table" check that re-adds one evicted at capacity. Plan stage confirms whether that re-add is wanted at all.

## Edge cases & interactions

- **Departed peers re-seeded as members.** A leave notice marks the departed peer `dead`, precisely because the per-pass re-seed used to re-create it as a live `member` from its lingering peerStore record (`docs/fret.md`, *Leave*). With the walk gone, that re-creation path largely disappears. `dead` must still survive any `peer:update` for that peer. Verify with the existing `test/address-less-departure.spec.ts` case, which must stay green unchanged.
- **Evicted peers.** Today an evicted peer that libp2p still holds is re-added on the next pass. Event-driven seeding would re-add it only on its next `peer:update`. Decide whether that is desired (it probably is — eviction should stick), and state it in the docs.
- **Discovery feedback loop.** `FretPeerDiscovery` emissions create peerStore entries, and each first-time merge fires `peer:update`, which would now upsert. That is the same set the walk already re-reads, so no new growth, but verify there is no event storm on a large table at start-up.
- **Event ordering versus the store.** Listeners run while a pass may be mid-await. The existing `NOTE:` about wholesale replacement clobbering a concurrent `setAddressKnown` goes away with the wholesale replacement. Confirm no new race between per-peer updates and phase-1 merges, both of which call `store.upsert`.
- **Capacity enforcement.** Today the walk's inserts are trimmed by the pass's single `enforceCapacity`. Event-driven inserts arrive between passes, so plan stage states where they are trimmed: the next pass, or the listener itself. `docs/fret.md` currently says the caller of an insert sequence owns its enforcement.
- **Documentation.** The *Dialability* section says the has-addresses set "is rebuilt wholesale from the `peerStore.all()` walk the stabilization tick already performs". That must be restated, along with the `NOTE:`s at `seedFromPeerStore` and `seedFromBootstraps`.

## Measuring success

Zero `peerStore.all()` calls per pass in steady state (count them with a test spy on the node). On the reporter's emulator profile, `pbToPeer` and multiaddr parsing no longer appear while idle.
