description: Path obfuscation for breadcrumbs and routing metadata to reduce traffic analysis and surveillance
dependencies: 2-e2e-payload-encryption (related privacy concern), 5-message-signatures
files: src/service/fret-service.ts (iterativeLookup, routeAct), docs/fret.md
----

### Problem

`RouteAndMaybeActV1.breadcrumbs` contains the full ordered list of peer IDs visited during routing. Every forwarding node sees the originator (first breadcrumb), the full routing path, the target key, and whether activity is included. Combined with the originator identity leaked via correlation ID prefix (`${selfId}-...`), this enables complete surveillance of who is looking up what.

Additionally, neighbor snapshots reveal complete S/P sets with coordinates and relevance scores. Any connected peer can query any other peer for a full topology snapshot — there's no authentication for who can request snapshots.

### Expected behavior

Design exploration for reducing information leakage in routing:

1. **Breadcrumb obfuscation**: Replace plaintext peer IDs in breadcrumbs with encrypted or hashed tokens that still allow loop detection but don't reveal the full path to forwarding nodes. Each hop should only see enough to detect if it has already been visited.
2. **Correlation ID privacy**: Remove the `selfId` prefix from correlation IDs so the originator isn't embedded in every message.
3. **Snapshot access control**: Consider limiting what information is shared in neighbor snapshots based on the requester's relationship to the node (e.g., full snapshots only for S/P neighbors, limited info for others).

This is a design exploration — the tradeoff is between privacy and routing diagnostics/debuggability.

### Threat references

- threat-analysis.md §6.2 (Medium): Traffic analysis via breadcrumbs
- threat-analysis.md §6.1 (Medium): Network topology inference via snapshots
- threat-analysis.md §6.4 (Medium): Key interest surveillance
