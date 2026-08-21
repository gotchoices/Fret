description: Sign or HMAC serialized routing table exports and verify coordinates on import
dependencies: 5-message-signatures (same key infrastructure)
files: src/service/fret-service.ts (exportTable/importTable ~line 1347-1360), docs/fret.md
tradeoffs: The exported table is written and read by the local application, so the threat needs an attacker who can already write that application's own storage — arguably outside FRET's trust boundary and better handled by the storage layer. The coordinate re-verification half is cheap and defensible independently of the signing half.
----

### Problem

`exportTable`/`importTable` produce and consume JSON with no integrity protection. If the serialized table is stored on disk or transmitted, it can be tampered with:

- Modified relevance scores to promote attacker-controlled peers
- Fabricated peer entries with chosen coordinates
- Corrupted entries causing parsing errors on import

The design doc notes "The caller decides where and how to store the JSON" but provides no integrity mechanism. On import, coordinates are trusted without re-hashing from peer IDs, so tampered coordinates go directly into the routing table.

### Expected behavior

1. `exportTable` signs or HMACs the serialized table using the local peer's key. The signature covers the full JSON content.
2. `importTable` verifies the signature before processing. Reject tables with invalid or missing signatures.
3. On import, coordinates are re-verified: `hashPeerId(peerIdFromString(entry.id))` must match the stored coordinate.
4. Import from untrusted sources (e.g., received from another peer) is treated differently from import of self-exported tables.

### Threat references

- threat-analysis.md §5.5 (Medium): Serialized routing table tampering

### Arm: item 3 is now the only coordinate check for imported entries

Added by `implement/16-per-tick-hotpath-waste`.

Until that change, the background maintenance loop rehashed every peer's ring coordinate from its
peer id on every cycle and wrote the result back, which *incidentally* repaired a tampered
coordinate for any peer that libp2p's own peer store also knew about. That repair is gone: the loop
now reuses the coordinate already stored for a peer and only computes the hash for a peer it has
never seen.

Removing it was deliberate. The repair was partial (it only ever reached peers libp2p also knew),
owned by nobody, and paid for by every node on every cycle. But it means item 3 above — re-deriving
each imported entry's coordinate from its peer id and rejecting a mismatch — is now the only place
a wrong coordinate from a restored snapshot would be caught. Whoever picks this ticket up should
treat that half as the load-bearing one; it is also the half that stands on its own without the
signing work.

A test asserting the new behavior deliberately ("a tampered coordinate now survives a tick"), so
that it is not later rediscovered as a regression, is queued in
`implement/16.1-per-tick-hotpath-tests`.
