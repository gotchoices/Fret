description: Verify ring coordinates in sample entries by re-hashing peer IDs instead of trusting provided coords
dependencies: none
files: src/service/fret-service.ts (mergeAnnounceSnapshot ~line 616-623, mergeNeighborSnapshots ~line 750-786), src/ring/hash.ts
----

### Problem

In `mergeAnnounceSnapshot`, sample entries contain pre-computed `coord` values that are decoded with `u8FromString(s.coord, 'base64url')` and used directly via `this.store.upsert(s.id, coord)`. The coord is never verified against `SHA-256(peerId.toMultihash().bytes)`.

This means an attacker can place a peer ID at **any** ring position by providing a spoofed coordinate — no ID grinding needed. This breaks the fundamental assumption that ring positions are deterministic from peer IDs.

Successor/predecessor entries in the same snapshot are correctly re-hashed from the peer ID. The inconsistency makes sample entries the easiest vector for arbitrary ring position placement.

### Expected behavior

Sample entries are treated identically to successors/predecessors: the coord is always recomputed as `coord = await hashPeerId(peerIdFromString(s.id))`. The provided `s.coord` is ignored (or optionally validated as a fast-reject: if it doesn't match the computed coord, drop the entry and penalize the sender).

Apply the same verification in `mergeNeighborSnapshots` if sample entries are processed there.

### Threat references

- threat-analysis.md §5.3 (High): Coordinate spoofing in sample entries
- threat-analysis.md §1.3 (High): Routing table pollution via snapshot injection (amplified by spoofed coords)
