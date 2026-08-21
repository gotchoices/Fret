description: Re-hash peer IDs for sample entries instead of trusting provided coords
dependencies: none
files: src/service/fret-service.ts (lines 644-651, 803-810), src/ring/hash.ts
tradeoffs: Replaces a cheap base64 decode with a SHA-256 per sample entry on the snapshot-merge path, and once coordinates are distrusted the wire field becomes dead weight — a maintainer may prefer to remove the field from the wire format outright rather than pay to re-derive it.
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

---

## Implemented and verified 2026-08-20

`yarn check`: **1085 passing, 0 failing**, typecheck + build clean.

### What shipped

Both inbound merge loops in `src/service/fret-service.ts` — `mergeAnnounceSnapshot` (announce
path) and `fetchAndMergeSnapshot` (fetch path) — now derive a sample entry's ring coordinate with
`await hashPeerId(peerIdFromString(s.id))` instead of decoding `s.coord` off the wire, matching
what the successor/predecessor loops beside them have always done. `base64urlToCoord` is no longer
imported by the service.

`s.coord` stays in the wire format: the parser still width-checks it (removing the field is a
format change, and a sender emitting malformed coordinates is worth dropping the entry over), but
nothing reads the value.

### Pinned by `test/sample-coordinate-verification.spec.ts` (4 tests)

Verified to bite: with the two lines reverted to `base64urlToCoord(s.coord)`, **all four fail.**
The positional one states the attack directly —

```
expected '_____________________________________…'   (attacker-chosen: all zeros)
      to equal 'R8MhNmRVNtv1pV67XiVSXh8Ku0AVS-g1cZT6u…' (SHA-256 of the peer id)
```

— a victim parked at the start of the ring, adjacent to whatever key the attacker wants it to
anchor, rather than where its id hashes.

### Consequence not anticipated by the original ticket

A sample entry whose `id` will not parse as a peer id is now **dropped** rather than merged at a
wire-supplied coordinate: a ring position cannot be derived for a non-peer-id, and such an entry
was never dialable anyway. This is the merge loop's per-entry `try/catch` doing the job the coord
decode used to — that guard did not disappear, its remaining arm is the id parse.

It broke six existing tests whose fixtures used synthetic sample ids (`'good-1'`,
`sample-<n>`), across `test/rpc.handler-fuzz.spec.ts` and `test/announce-rate-limit.spec.ts`.
Fixture churn from a real behavior change, not a regression; fixed in `f11e4f1` by switching those
fixtures to real peer ids, with a comment at each helper explaining why they must be real.

`docs/fret.md` moved this out of *Not yet implemented* in the same commit.

### Note on history

The source change and its spec were written while a tess runner was live and were swept into two
commits labelled `ticket(review): sim-route-local-selector` (`755a6a8`, `895942a`). Content is
intact; the commit messages do not describe it. Recorded here because the commit log will not say
so.
