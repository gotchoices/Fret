---
description: Our design says a lightweight node should accept at most 32 simultaneous incoming requests per protocol and a server-grade node 128, but the code never sets those limits so both get the networking library's default of 32. Set them, and fix a related bug where hitting our own outgoing limit would wrongly be blamed on the peer we were talking to.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/rpc/request.ts, packages/fret/src/rpc/outcome.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: medium
---

Implement the per-protocol stream caps `docs/fret.md` describes but never applied, and fix the
misclassification that shipping them would otherwise activate.

## What is wrong today

`registerRpcHandler` (`packages/fret/src/rpc/protocols.ts:117`) is the single site that calls
`node.handle(protocol, handler)`, and it passes no options. libp2p therefore applies its own
defaults to all five FRET protocols on both profiles: `DEFAULT_MAX_INBOUND_STREAMS = 32` and
`DEFAULT_MAX_OUTBOUND_STREAMS = 64` (`node_modules/libp2p/dist/src/registrar.js:4-5`). Both limits
are counted **per protocol per connection**, not per node. So a Core node is provisioned at the
Edge number, and the two profiles are identical where the document said they differ.

## Design

### Where the numbers live

Add a private `streamCaps()` to `FretService`, sibling to `mergeSnapshotCaps()`
(`packages/fret/src/service/fret-service.ts:2006`) and written in the same shape — branch on
`this.cfg.profile`, return a small record, carry a doc comment saying it is the single source of
these numbers and that callers must not inline them.

```ts
private streamCaps(): { maxInboundStreams: number; maxOutboundStreams: number } {
	return this.cfg.profile === 'core'
		? { maxInboundStreams: 128, maxOutboundStreams: 256 }
		: { maxInboundStreams: 32,  maxOutboundStreams: 64  };
}
```

The numbers stay hard-coded. No new config knob — matching `mergeSnapshotCaps()`. If a deployment
ever needs to tune them that is a follow-up with a measurement behind it.

### How they reach `node.handle`

`handle(protocol, handler, options?: StreamHandlerOptions)` documents exactly `maxInboundStreams`
and `maxOutboundStreams` (`node_modules/@libp2p/interface/dist/src/index.d.ts:655-656`). The
registrar spreads the caller's options over its own defaults
(`node_modules/libp2p/dist/src/registrar.js:72-73`), so passing either alone is fine — the other
keeps its default. Pass both.

Threading: widen `registerRpcHandler`'s existing `opts` bag (it already carries `closeBudgetMs`,
which is the precedent to copy) with the two optional numbers, and forward them into `node.handle`.
`registerJsonHandler` already forwards `closeBudgetMs` down; widen it the same way. Then give each
of the four registrar functions — `registerNeighbors` (`neighbors.ts:17`), `registerLeave`
(`leave.ts:20`), `registerPing` (`ping.ts:24`), and `registerMaybeAct` (`maybe-act.ts:18`, which
calls `registerRpcHandler` directly at `maybe-act.ts:30`) — **one more optional trailing
parameter**, `opts?: { maxInboundStreams?: number; maxOutboundStreams?: number }`, forwarded
verbatim.

That shape was chosen over two alternatives and the tradeoff is settled, not open:

- A bare positional number would be the worst call site of the three (`registerNeighbors` already
  takes eight parameters).
- Converting all four to options bags gives the best call site but is a four-file refactor with its
  own review surface; it is a separate `debt-` ticket, and this change helps it rather than
  blocking it.

An optional trailing parameter is what these four functions already do — `registerNeighbors`'s last
parameter is a defaulted trailing argument added by the parser work, carrying a comment saying it is
trailing *precisely* so existing positional callers keep compiling. This follows that precedent.

Apply the caps where the service registers handlers (`registerRpcHandlers`, ~line 955), which is on
the **`start()` path** — not at construction. `stop()` unhandles all five protocols and `start()`
re-registers them, so caps applied only once at construction would be silently dropped by a
start→stop→start cycle.

### The scoring fix — do not ship the caps without it

`rpcRequest`'s `classify` (`packages/fret/src/rpc/request.ts`) has no arm for the stream-cap
errors, so both fall through to `{ kind: 'unreachable' }`. `noteRpcFailure`
(`fret-service.ts:873`) books `unreachable` as a **contact strike** via `applyContactFailure`, and
`deadAfterFailures` (3) then marks the peer `dead` — removing it from every ring view.

**Our own outbound cap firing is not evidence about the peer at all.** libp2p throws
`TooManyOutboundProtocolStreamsError` out of `newStream` — i.e. out of FRET's own
`openRpcStream` — on a dial to a peer that is perfectly healthy. It is the same class as a
tick-budget expiry (see *Stabilization and churn handling* in `docs/fret.md`): our local ceiling,
not the remote's state. It must score **nothing** — no contact strike, no relevance decay, no
backoff. Today it scores a strike. That is a latent defect that becomes live the moment the caps
are configured, which is why the fix belongs in this ticket rather than a follow-up.

Both error identities are stable and matchable by `name`, in the same style as
`isFrameTruncationError` / `isPayloadTooLargeError`
(`node_modules/@libp2p/interface/dist/src/errors.js:300-316`):

```
TooManyInboundProtocolStreamsError.name  === 'TooManyInboundProtocolStreamsError'
TooManyOutboundProtocolStreamsError.name === 'TooManyOutboundProtocolStreamsError'
```

Add a predicate beside the existing two (`isStreamLimitError`, or a matching pair) and a new
`RpcOutcome` variant:

```ts
/**
 * Our own per-connection stream cap refused to open the stream — `TooMany{In,Out}bound
 * ProtocolStreamsError`, raised locally before anything reached the wire. **Not evidence about
 * the peer**: no contact strike, no relevance decay, no backoff — the same class as a tick-budget
 * expiry. Distinct from `skipped`, which means the dial *mode* forbade dialing; this one means we
 * were willing and our own ceiling refused, and that distinction is the diagnostic.
 */
| { kind: 'local-limit'; error: Error }
```

Adding a variant is public-surface growth and was weighed against reusing `skipped`. `skipped` is
documented as "nothing was attempted: the dial mode forbade dialing and no connection existed", and
callers already read it for the `snapshotsFetched` distinction; folding a ceiling hit into it
erases the fact that the ceiling fired — and on both profiles the caps sit so far above FRET's own
concurrency (below) that *firing at all* is itself a signal worth seeing. `noteRpcFailure`'s
`switch` has a `default` arm that returns without scoring, so the new variant is correctly inert
there by construction; add it to the `default` comment explicitly rather than leaving it implicit.
Place the check in `classify` **before** the `unreachable` fallback and after the
foreign-protocol / truncation checks (the identities are disjoint, so order among them is free).

Add a diagnostic counter for it (`diag.streamLimit`, or the nearest existing shape) so a cap that
does fire is visible rather than silent.

### The remote's inbound cap is not distinguishable, and the ticket must say so

When a remote refuses our stream at its own inbound cap, `onIncomingStream` throws
`TooManyInboundProtocolStreamsError` and the catch calls `muxedStream.abort(err)` — so the *sender*
sees a **reset**, not a reply. That error object is constructed on the remote's side; a muxer reset
carries at most a numeric code on the wire, so the reason does not travel. **We therefore cannot
classify a remote inbound-cap refusal by error identity** — on our side it is indistinguishable
from any other reset and reads as `unreachable`, booking a contact strike against a peer that is
alive and merely overloaded.

This is a stated residual, not something to paper over with a heuristic. It is acceptable because
of the concurrency arithmetic below: FRET's own traffic cannot approach any peer's inbound cap, so
the only way to trip it is a peer flooding us, or a consumer opening its own streams over the same
connection. Record it as a `NOTE:` at the `classify` site and as a sentence in `docs/fret.md` —
someone will otherwise re-derive it as a bug.

### Why the caps are backstops, not operating limits

FRET's own concurrency is **per node**, while these caps are **per connection per protocol**:
`maintenanceConcurrency` is Core 6 / Edge 2 and governs the whole stabilization tick pool, the
start-up warm-up pass, and the active-mode warm-up tick; `announceFanout` is Core 8 / Edge 4 and
fans out to *distinct* peers. So the number of concurrent outbound streams FRET opens to **one
peer on one protocol** is ~1, orders of magnitude below an outbound cap of 64 or 256. The same
holds inbound: the `handleMaybeAct` inflight cap (Core 16 / Edge 4) sits far below the inbound
stream cap (Core 128 / Edge 32) and binds first, answering `busy` politely.

State that ordering explicitly in the doc: **inflight binds first and answers politely; the stream
cap is an outer backstop that should essentially never fire against an honest peer — which is why
firing is itself a signal.**

## Edge cases & interactions

- **Core↔Edge on one connection.** Each side's *inbound* cap is its own choice, so the two are
  independent and the pair is asymmetric by design (a Core node may open more outbound streams than
  an Edge peer will accept inbound: 256 vs 32). Check nothing in the codebase assumes symmetry.
  This asymmetry is only safe because of the backstop arithmetic above; if FRET's per-peer
  concurrency ever rises, this is the interaction that breaks first.
- **`stop()` / `start()` re-registration.** `stop()` unhandles all five protocols; `start()`
  re-registers. Caps must be on the `start()` path. A start→stop→start cycle must end with the
  caps still applied — assert it, do not assume it.
- **The exact off-by-one at the cap.** The comparison is `streamCount > limit` over
  `connection.streams` filtered by protocol and direction (`countStreams` in libp2p's
  `connection.js`). Whether the stream being admitted is already in that collection at check time
  was **not** verified, so whether the cap admits `limit` or `limit + 1` concurrent streams is
  unknown. **Pin it by observation in the test** — write the assertion against what the run does,
  and do not assert a number derived from reading libp2p's source.
- **Outbound caps vs the pooled maintenance passes.** `maintenanceConcurrency` (Core 6 / Edge 2) is
  a per-*node* pool while the outbound cap is per connection per protocol, so the pool cannot
  saturate an outbound cap of 64 against one peer. State this in the doc so the reviewer can see
  the two are not silently in tension.
- **Consumers sharing the connection.** `registerRpcHandler` and `openRpcStream` are exported from
  the package root; a consumer opening its own streams on its own protocol over the same libp2p
  node has its own caps, since the limits are per protocol. Nothing to do — but confirm the new
  `opts` field is optional so an existing external caller still compiles.
- **A cap of 0 or a negative number** must not be constructible from `streamCaps()`; the profile
  branch returns literals, so this is a "do not add a knob" constraint rather than a runtime check.

## Tests

Two, both new:

- **Cap enforcement + sender-side outcome.** Register a handler at a deliberately small cap and
  drive N+1 concurrent inbound streams on **one** connection. Assert the excess stream is refused
  and record what the sender's `RpcOutcome` actually is. This one case pins three things at once:
  that caps reach `node.handle` at all, the off-by-one above, and the fact that a remote's inbound
  refusal surfaces as `unreachable` on the sender (the stated residual) — so if a future libp2p
  version *does* propagate the reason, this test fails and the residual gets revisited.
- **Profile split.** A cheap spy on `node.handle` asserting the service passes Core 128/256 and
  Edge 32/64 through for all five protocols, in the spirit of the `mergeSnapshotCaps` acceptance-cap
  specs (`test/rpc.snapshot-merge-cap.spec.ts`). This is what actually pins the profile split, and
  it should also cover the start→stop→start case above.

Plus: extend `test/rpc.request.spec.ts` with a `classify` case driving a thrown
`TooManyOutboundProtocolStreamsError` and asserting `{ kind: 'local-limit' }` — and a service-level
assertion that `noteRpcFailure` books **no** contact strike for it.

## TODO

- Add `streamCaps()` to `FretService` beside `mergeSnapshotCaps()`, with the single-source doc comment.
- Widen `registerRpcHandler` / `registerJsonHandler` option bags with `maxInboundStreams` /
  `maxOutboundStreams`; forward into `node.handle`.
- Add the optional trailing `opts` parameter to `registerNeighbors`, `registerLeave`, `registerPing`,
  `registerMaybeAct`; forward verbatim.
- Wire `streamCaps()` into `registerRpcHandlers` on the `start()` path for all five protocols.
- Add `isStreamLimitError` beside `isFrameTruncationError` / `isPayloadTooLargeError`.
- Add the `local-limit` variant to `RpcOutcome` with its "what it proves about the peer" doc comment;
  add the `classify` arm before the `unreachable` fallback; add the diagnostic counter.
- Update `noteRpcFailure`'s `default`-arm comment to name `local-limit` explicitly.
- `NOTE:` at the `classify` site recording that a *remote's* inbound-cap refusal is not
  distinguishable from any other reset, and why that is acceptable.
- Write both new tests plus the `rpc.request.spec.ts` and service-level scoring cases.
- Update `docs/fret.md` *Stream management*: replace the "FRET passes no `maxInboundStreams` /
  `maxOutboundStreams`" bullet with the implemented split, state the inflight-binds-first ordering,
  state the per-node-vs-per-connection arithmetic, and state the non-distinguishable-reset residual.
  **The current bullet points at `tickets/backlog/debt-inbound-stream-caps-unimplemented`, a slug
  that no longer exists — that pointer must go.**
- Run `cd packages/fret && npx tsc --noEmit` and `yarn test` before handing off.
