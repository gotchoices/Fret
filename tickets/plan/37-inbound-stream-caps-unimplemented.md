----
description: The design document says a lightweight node should accept at most 32 simultaneous incoming requests per protocol and a server-grade node 128, but the code never sets those limits, so both get the networking library's default of 32.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: medium
tradeoffs: The default happens to equal the Edge target and nothing has been observed hitting it, so a maintainer could reasonably say the profile split buys nothing until a Core node is measured saturating 32 concurrent inbound streams on one connection.
----

<!-- resume-note -->
A prior plan run hit the runner's soft token budget partway through and stopped. No code was
changed and no next-stage ticket was emitted. What that run established is under *Findings from
the first pass*; what is left is under *TODO for the next plan run*. Start from the findings — the
code reading they record does not need repeating.

## The gap

`docs/fret.md`, *Stream management*, originally stated:

> Max inbound: 32 (Edge) / 128 (Core)
> Max outbound: 64 (Edge) / 256 (Core)

None of that is implemented. FRET registers all five protocols with a bare
`node.handle(protocol, handler)` and passes no `maxInboundStreams` / `maxOutboundStreams`, so
libp2p falls back to `DEFAULT_MAX_INBOUND_STREAMS = 32` and `DEFAULT_MAX_OUTBOUND_STREAMS` for
every protocol on every profile (`libp2p/dist/src/registrar.js`, and `findIncomingStreamLimit` /
`findOutgoingStreamLimit` in `libp2p/dist/src/connection.js`). The limits are counted **per
protocol per connection**, not per node.

Effect: a Core node is provisioned at the Edge number — a quarter of what the document said it
should carry — and the two profiles are identical where the document said they differ. Nothing
has been measured hitting the ceiling; the concern is that the stated design and the running code
disagree, which is how a capacity assumption gets relied on without existing.

`docs/fret.md` has since been corrected to describe the *current* behavior (no caps passed, both
profiles at the libp2p default) and to point at the gap. This ticket is the decision about whether
to implement the profile split for real.

## Findings from the first pass

Read and confirmed against the tree at the time of the pass:

- **The registration seam exists and is single.** `registerRpcHandler`
  (`packages/fret/src/rpc/protocols.ts:117`) is the one place that calls `node.handle`. Its
  signature is `registerRpcHandler(node, protocol, serve, opts: { closeBudgetMs?: number } = {})`.
  All five protocols reach it: neighbors / neighbors-announce / leave / ping go through
  `registerJsonHandler` (same file, ~line 199), itself a thin wrapper over `registerRpcHandler`
  that already forwards one option (`closeBudgetMs`) down to it; maybeAct calls
  `registerRpcHandler` directly (`packages/fret/src/rpc/maybe-act.ts:30`). So the `node.handle`
  call to widen is one line, and the option-forwarding precedent already exists — `closeBudgetMs`
  is the model to copy.
- **Threading the numbers down from the service is the actual work**, not the `node.handle` call.
  The four per-protocol registrars (`registerNeighbors`, `registerMaybeAct`, `registerLeave`,
  `registerPing`) all take long **positional** argument lists — `registerNeighbors` is already at
  eight positional parameters — and `FretService.registerRpcHandlers`
  (`packages/fret/src/service/fret-service.ts:1232`) calls each with those positionals. Adding a
  caps argument to each is a ninth positional on an already-unreadable call. This is the one open
  design question; see the TODO below.
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
- **Prereqs named in the original ticket have landed.** `7-rpc-handler-fault-isolation` (which
  introduced `registerRpcHandler`) and the `15.x` RPC-seam series are all in `tickets/complete/`;
  neither `plan/15-rpc-shared-helper` nor a successor is still open, so nothing is expected to
  move the seam again. No `prereq:` header is needed.

## TODO for the next plan run

Small, ordered, each independent:

- **Settle the threading design and write it into the implement ticket** — the one open question,
  and the reason this is still a plan ticket. Three candidates:
  1. Add an optional caps argument to each of the four registrars (simplest diff, worst call site
     — a ninth positional on `registerNeighbors`).
  2. Convert the four registrars to an options bag and add caps as one field (best call site,
     largest diff, touches four files plus the service; arguably its own `debt-` ticket with this
     one chained behind it).
  3. Add the caps to `registerRpcHandler`'s existing `opts` bag and to `registerJsonHandler`'s two
     option interfaces, then give the four registrars a single optional trailing
     `opts?: { maxInboundStreams?, maxOutboundStreams? }` they forward verbatim — one new
     positional each, but a named object rather than a bare number, and it is the shape option 2
     would keep.

  Option 3 looks like the defensible default (it is where `closeBudgetMs` already sits, and it does
  not block a later options-bag refactor), but confirm by reading the four registrar signatures
  before committing the ticket to it.
- **Verify the libp2p option names and the outbound half against the installed version.** Read
  `node_modules/@libp2p/interface`'s `StreamHandlerOptions` (or equivalent) and confirm the third
  argument of `node.handle` accepts `maxInboundStreams` / `maxOutboundStreams`, and confirm what
  `maxOutboundStreams` registered via `handle` actually governs — whether it bounds streams this
  node *opens* on that protocol (consulted by `findOutgoingStreamLimit` at `newStream` time) or
  something else. If it does not do what the doc's "Max outbound" line assumes, say so and scope
  the implement ticket to the inbound half alone rather than shipping a number that means nothing.
- **Decide whether the numbers stay hard-coded or become config.** `mergeSnapshotCaps()` hard-codes
  its profile numbers, so matching that is the consistent choice; state it rather than leaving the
  call to the implementer.
- **Write the `## Edge cases & interactions` section** for the implement ticket. At minimum: a Core
  node and an Edge node on one connection (each side's *inbound* cap is its own choice, so the two
  are independent — check nothing assumes symmetry); the interaction with `handleMaybeAct`'s
  inflight concurrency cap (Core 16 / Edge 4), which sits *behind* the stream cap and bounds a
  different axis — the ticket must say which binds first and why both exist; behavior when the cap
  is reached (libp2p resets the excess stream — confirm, and confirm the sender surfaces that as an
  `RpcOutcome` variant that is *not* scored as a contact strike, since a capped peer is alive); and
  `stop()` / `start()` re-registration carrying the caps.
- **Name the test.** A test registering a handler at a known small cap, showing the N+1th
  concurrent inbound stream on one connection is refused; plus a cheap assertion that the service
  passes Core 128 / Edge 32 through to `node.handle` (a spy on `handle`, in the spirit of the
  `mergeSnapshotCaps` acceptance-cap specs) — the latter is what actually pins the profile split.
- **Update `docs/fret.md`'s *Stream management* bullet** as part of the implement ticket, including
  the stale ticket pointer noted above.
