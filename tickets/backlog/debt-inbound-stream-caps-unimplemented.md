----
description: The design document says a lightweight node should accept at most 32 simultaneous incoming requests per protocol and a server-grade node 128, but the code never sets those limits, so both get the networking library's default of 32.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/ping.ts, docs/fret.md
tradeoffs: The default happens to equal the Edge target and nothing has been observed hitting it, so a maintainer could reasonably say the profile split buys nothing until a Core node is measured saturating 32 concurrent inbound streams on one connection.
----

`docs/fret.md`, *Stream management*, states:

> Max inbound: 32 (Edge) / 128 (Core)
> Max outbound: 64 (Edge) / 256 (Core)

None of that is implemented. FRET registers all five protocols with a bare
`node.handle(protocol, handler)` and passes no `maxInboundStreams` / `maxOutboundStreams`, so
libp2p falls back to `DEFAULT_MAX_INBOUND_STREAMS = 32` and `DEFAULT_MAX_OUTBOUND_STREAMS` for
every protocol on every profile (`libp2p/dist/src/registrar.js`, and `findIncomingStreamLimit` /
`findOutgoingStreamLimit` in `libp2p/dist/src/connection.js`). The limits are counted **per
protocol per connection**, not per node.

Effect: a Core node is provisioned at the Edge number — a quarter of what the document says it
should carry — and the two profiles are identical where the document says they differ. Nothing
has been measured hitting the ceiling; the concern is that the stated design and the running code
disagree, which is how a capacity assumption gets relied on without existing.

Found while planning `7-rpc-codec-fuzzing`, where the per-connection cap of 32 is what bounds the
blast radius of the leaked-inbound-stream defect that `implement/7-rpc-handler-fault-isolation`
fixes. That ticket corrects `docs/fret.md` to describe the current behavior and points here; this
ticket is the decision about whether to implement the profile split for real.

Shape of the work, if taken: thread the profile's caps into the `StreamHandlerOptions` third
argument of each `node.handle` call. `implement/7-rpc-handler-fault-isolation` introduces a single
`registerRpcHandler` registration seam, so there is one place to add them rather than five —
land this after that, and after `plan/15-rpc-shared-helper` if that refactor moves the seam again.
