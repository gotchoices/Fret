description: Sign or HMAC serialized routing table exports and verify coordinates on import
dependencies: 5-message-signatures (same key infrastructure)
files: src/service/fret-service.ts (exportTable/importTable ~line 1347-1360), docs/fret.md
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
