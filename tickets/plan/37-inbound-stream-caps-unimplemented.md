----
description: The design document says a lightweight node should accept at most 32 simultaneous incoming requests per protocol and a server-grade node 128, but the code never sets those limits, so both get the networking library's default of 32.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/rpc/request.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: medium
tradeoffs: The default happens to equal the Edge target and nothing has been observed hitting it, so a maintainer could reasonably say the profile split buys nothing until a Core node is measured saturating 32 concurrent inbound streams on one connection.
----

<!-- resume-note -->
Two plan runs have now stopped on the runner's soft token budget. No code has been changed and no
next-stage ticket emitted. Everything established so far is under *Findings* — that code reading
does not need repeating. What is left is under *TODO for the next plan run*, now down to four
items, only one of which needs fresh code reading.

## The gap

`docs/fret.md`, *Stream management*, originally stated:

> Max inbound: 32 (Edge) / 128 (Core)
> Max outbound: 64 (Edge) / 256 (Core)

None of that is implemented. FRET registers all five protocols with a bare
`node.handle(protocol, handler)` and passes no options, so libp2p falls back to its defaults for
every protocol on every profile. The limits are counted **per protocol per connection**, not per
node.

Effect: a Core node is provisioned at the Edge number — a quarter of what the document said it
should carry — and the two profiles are identical where the document said they differ. Nothing has
been measured hitting the ceiling; the concern is that the stated design and the running code
disagree, which is how a capacity assumption gets relied on without existing.

`docs/fret.md` has since been corrected to describe the *current* behavior and to point at the gap.
This ticket is the decision about whether to implement the profile split for real.

## Findings (first pass — the FRET side)

- **The registration seam exists and is single.** `registerRpcHandler`
  (`packages/fret/src/rpc/protocols.ts:117`) is the one place that calls `node.handle`. Signature:
  `registerRpcHandler(node, protocol, serve, opts: { closeBudgetMs?: number } = {})`. All five
  protocols reach it: neighbors / neighbors-announce / leave / ping go through
  `registerJsonHandler` (same file, ~line 199), itself a thin wrapper that already forwards one
  option (`closeBudgetMs`) down; maybeAct calls `registerRpcHandler` directly
  (`packages/fret/src/rpc/maybe-act.ts:30`). So the `node.handle` call to widen is one line, and the
  option-forwarding precedent already exists — `closeBudgetMs` is the model to copy.
- **The profile-numbers idiom to follow is `mergeSnapshotCaps()`**
  (`packages/fret/src/service/fret-service.ts:2006`): a private method on `FretService` that
  branches on `this.cfg.profile` and returns a small record, with a doc comment stating it is the
  single source of those numbers and that callers must not inline them. A sibling
  `streamCaps(): { maxInboundStreams: number; maxOutboundStreams: number }` returning Core 128/256
  and Edge 32/64 is the shape to write.
- **The doc's pointer is stale.** The *Stream management* bullet in `docs/fret.md` points at
  `tickets/backlog/debt-inbound-stream-caps-unimplemented`, a slug that no longer exists (this
  ticket is `plan/37-inbound-stream-caps-unimplemented`). Whatever this becomes must rewrite that
  bullet — either to describe the implemented split, or to point at a slug that exists.
- **Prereqs named in the original ticket have landed.** `7-rpc-handler-fault-isolation` and the
  `15.x` RPC-seam series are all in `tickets/complete/`; nothing is expected to move the seam
  again. No `prereq:` header is needed.

## Findings (second pass — libp2p, and the threading decision)

Read against the installed `libp2p` / `@libp2p/interface` in `node_modules`.

- **The option names are confirmed, and the third argument exists.**
  `handle(protocol, handler, options?: StreamHandlerOptions)` documents exactly
  `maxInboundStreams` / `maxOutboundStreams`
  (`node_modules/@libp2p/interface/dist/src/index.d.ts:655-656`). The registrar spreads the caller's
  options over its own defaults (`node_modules/libp2p/dist/src/registrar.js:72-73`), so passing
  either one alone is enough — the other keeps its default. Defaults are
  `DEFAULT_MAX_INBOUND_STREAMS = 32` / `DEFAULT_MAX_OUTBOUND_STREAMS = 64`
  (`registrar.js:4-5`), which is where today's uniform behavior comes from.
- **The outbound half is real, and it governs what the doc's "Max outbound" line assumed.**
  `findOutgoingStreamLimit(protocol, registrar, options)`
  (`node_modules/libp2p/dist/src/connection.js:246`) consults the **registered handler's**
  `maxOutboundStreams` *first*, and only falls back to the per-`newStream` call option and then to
  the default. So a value registered through `handle` bounds the streams **this node opens** on that
  protocol on each connection. The implement ticket therefore covers both halves; it does not need
  to be scoped to inbound alone.
- **But the outbound half is the sharp edge, not the easy half.** Exceeding it throws
  `TooManyOutboundProtocolStreamsError` out of `newStream` — i.e. out of FRET's own
  `openRpcStream`, on a dial to a peer that is perfectly healthy. If `rpcRequest` classifies that as
  `unreachable`, the local node's own concurrency ceiling books a **contact strike** against an
  innocent peer, and `deadAfterFailures` (3) marks it `dead`. That is a new failure mode this ticket
  would introduce, and it is the one thing the implement ticket must get right.
- **Inbound over-cap resets the excess stream.** `onIncomingStream` throws
  `TooManyInboundProtocolStreamsError` and the catch calls `muxedStream.abort(err)`
  (`connection.js:156-181`) — so the *sender* of the (limit+1)-th stream sees a reset, not a reply.
  Same scoring question as above, from the other side.
- **The comparison is `streamCount > limit`** over `connection.streams` filtered by protocol and
  direction (`countStreams`, `connection.js:262`). Whether the stream being admitted is already in
  that collection at check time was **not** verified, so the exact off-by-one (limit vs limit+1
  concurrent streams) is unknown. Pin it by observation in the test rather than asserting it from
  this reading.
- **Threading design: option 3 is confirmed and settled.** All four registrar signatures were read
  (`neighbors.ts:17`, `maybe-act.ts:18`, `leave.ts:20`, `ping.ts:24`). Every one already ends in
  optional or defaulted positional parameters — `registerNeighbors` is at eight, and its last one is
  a defaulted trailing argument added by the parser work, carrying a comment explaining it is
  trailing *precisely* so existing positional callers keep compiling. Appending one more optional
  trailing `opts?: { maxInboundStreams?: number; maxOutboundStreams?: number }` that each registrar
  forwards verbatim into `registerRpcHandler` / `registerJsonHandler` is therefore consistent with
  the established shape of these four functions, not a new precedent. Rejected alternatives: a bare
  ninth positional number (worst call site), and converting all four to options bags (best call site,
  but a four-file refactor that is its own `debt-` ticket, and one this change would help rather than
  block).
- **The numbers stay hard-coded, matching `mergeSnapshotCaps()`.** Settled, not left to the
  implementer: no new config knob. If a deployment ever needs to tune them, that is a follow-up with
  a measurement behind it.

## TODO for the next plan run

Four items. Only the first needs fresh code reading; the rest are writing.

- **Read `packages/fret/src/rpc/request.ts` and settle how a stream-cap refusal is scored.** This is
  the last open design question and the reason this is still a plan ticket. Determine which
  `RpcOutcome` variant `rpcRequest` produces for (a) `TooManyOutboundProtocolStreamsError` thrown out
  of `openRpcStream` / `newStream` on our own side, and (b) a stream reset by the remote's inbound
  cap. Then decide, and write into the implement ticket:
  - Our own outbound cap firing is **not evidence about the peer at all** — the same class as the
    tick-budget expiry documented under *Stabilization and churn handling* — so it must score
    nothing: no contact strike, no relevance decay, no backoff. If it currently lands in a scoring
    arm, the implement ticket owns fixing that, and the fix is part of this change rather than a
    follow-up: shipping the caps without it makes the caps actively harmful.
  - A remote's inbound cap resetting our stream proves the peer is **alive and overloaded**. It must
    not be a contact strike either. Whether it deserves backoff (like a `busy` reply) or nothing is a
    call to make and state; note that unlike `busy` there is no `retry_after_ms` to read.
  - If distinguishing these needs a new `RpcOutcome` variant, say so explicitly and weigh it against
    reusing an existing one — `RpcOutcome` is public surface.
- **Write the `## Edge cases & interactions` section.** At minimum:
  - A Core node and an Edge node on one connection: each side's *inbound* cap is its own choice, so
    the two are independent — check nothing in the codebase assumes symmetry.
  - The interaction with `handleMaybeAct`'s inflight concurrency cap (Core 16 / Edge 4), which sits
    *behind* the stream cap and bounds a different axis. The ticket must say which binds first and
    why both exist. The ordering is worth stating explicitly: on both profiles the stream cap (128 /
    32) sits far above the inflight cap (16 / 4), so inflight binds first and answers `busy`
    politely, and the stream cap is an outer backstop that should essentially never fire against an
    honest peer — which means firing is itself a signal.
  - The exact off-by-one at the cap (see the `streamCount > limit` finding), pinned by observation.
  - `stop()` / `start()` re-registration carrying the caps: `stop()` unhandles all five protocols and
    `start()` re-registers, so the caps must be applied on the `start()` path, not only at
    construction.
  - Outbound caps versus the pooled maintenance passes: `maintenanceConcurrency` is Core 6 / Edge 2
    and the tick's pool is per-node, while the outbound cap is per connection per protocol — so the
    pool cannot saturate an outbound cap of 64 against one peer. State it, so the reviewer can see
    the two are not silently in tension.
- **Name the tests.** Two. A handler registered at a deliberately small cap, showing the N+1th
  concurrent inbound stream on one connection is refused and showing what the sender's `RpcOutcome`
  is — that case also pins the off-by-one and the scoring decision above. Plus a cheap spy on
  `node.handle` asserting the service passes Core 128/256 and Edge 32/64 through, in the spirit of
  the `mergeSnapshotCaps` acceptance-cap specs; that second one is what actually pins the profile
  split.
- **Update `docs/fret.md`'s *Stream management* bullet** as part of the implement ticket, including
  the stale ticket pointer noted above.
