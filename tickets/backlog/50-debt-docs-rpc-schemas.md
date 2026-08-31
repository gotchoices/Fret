description: Document JSON schemas for RPCs with examples
dependencies: FRET RPC layer
tradeoffs: Hand-written schema documents drift from the TypeScript wire types the moment either changes; a maintainer may prefer generating them from the types, or judge the exported types to be sufficient documentation already.
----

Document the wire protocol with:

- JSON schemas for each RPC message type (NeighborSnapshotV1, RouteAndMaybeActV1, NearAnchorV1, LeaveNotice, PingLite).
- Example request/response pairs for each protocol.
- Error response formats and backpressure signaling.
- Versioning strategy for future protocol evolution.
