description: Re-hash peer IDs for sample entries instead of trusting provided coords
dependencies: none
files: src/service/fret-service.ts (lines 644-651, 803-810), src/ring/hash.ts
----

### Context

Sample entries in neighbor snapshots carry pre-computed `coord` values that are decoded with `u8FromString(s.coord, 'base64url')` and inserted directly into the store. Unlike successor/predecessor entries (which re-hash from the peer ID), sample entries never verify the coordinate against `SHA-256(peerId.toMultihash().bytes)`.

This allows an attacker to place a peer ID at any ring position by providing a spoofed coordinate — no ID grinding needed. This breaks the fundamental assumption that ring positions are deterministic.

### Fix

In both `mergeAnnounceSnapshot` (~line 644) and `mergeNeighborSnapshots` (~line 803), replace the trusted coord decode with a re-hash, identical to how successors/predecessors are handled.

**Before** (both locations):
```ts
const coord = u8FromString(s.coord, 'base64url');
```

**After** (both locations):
```ts
const coord = await hashPeerId(peerIdFromString(s.id));
```

`peerIdFromString` and `hashPeerId` are already imported and used in both methods for successor/predecessor entries. No new imports needed.

### Tests

- Unit test: construct a `NeighborSnapshotV1` with a sample entry whose `coord` is deliberately wrong (e.g., all zeros). Feed it through announce/neighbor merge. Assert the stored coord matches `hashPeerId(peerIdFromString(s.id))`, not the spoofed coord.
- Existing test in `seed-new-peers.spec.ts` (`sample entries have valid base64url coords`) validates snapshot generation — it should continue to pass since generation already uses correct coords.

### TODO

- In `mergeAnnounceSnapshot` (~line 646): replace `u8FromString(s.coord, 'base64url')` with `await hashPeerId(peerIdFromString(s.id))`
- In `mergeNeighborSnapshots` (~line 805): same replacement
- Add test: spoofed sample coord is ignored, correct coord is stored
- Verify build passes (`npx tsc --noEmit`)
- Verify all tests pass (`yarn test`)
