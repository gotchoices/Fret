----
description: A badly-formed network message makes the receiving code fail halfway through answering, so it never replies and never lets go of the connection slot the message arrived on; after 32 such messages that peer can no longer use that protocol on that connection at all. Fix the receive path so a bad message is always answered or dropped cleanly, and add tests that fire malformed messages at every protocol.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.fuzz.spec.ts, packages/fret/test/helpers/libp2p.ts, docs/fret.md
difficulty: hard
----

The existing `test/rpc.fuzz.spec.ts` has zero assertions and feeds exactly one malformed shape,
so it proves nothing. Writing the real fuzz tier first turned up a reproducible defect class, so
this ticket is the fix *and* the regression net; the property/round-trip and rate-limit tiers
follow in `7.5-rpc-codec-property-tests`.

### The defect class: an inbound handler that throws never releases its stream

Every inbound handler in `src/rpc/` has the same shape:

```ts
await node.handle(protocol, async (stream, connection) => {
    try {
        const bytes = await readAllBounded(stream, maxBytes)
        const msg = await decodeJson<T>(bytes)
        ...
        stream.send(await encodeJson(res))
        await stream.close()
    } catch (err) {
        log.error('... handler error - %e', err)   // <- logs, and that is all
    }
})
```

The `catch` logs and returns. It never calls `close()` or `abort()`, so the inbound stream stays
`open` forever. Consequences, in order of how much they matter:

- **The connection's slot for that protocol is consumed permanently.** libp2p counts inbound
  streams **per protocol per connection** (`libp2p/dist/src/connection.js` `countStreams`,
  `findIncomingStreamLimit`) and FRET passes no `maxInboundStreams` to any `node.handle`, so the
  limit is libp2p's `DEFAULT_MAX_INBOUND_STREAMS = 32`. Thirty-two messages FRET cannot parse,
  over one connection, and that peer can no longer open an inbound stream for that protocol on
  that connection — with no path back short of dropping the connection. This is *per connection*,
  so a hostile peer mostly denies service to itself; the case that bites is an honest peer sending
  something this version cannot parse (version skew, an encoder bug), which silently poisons its
  own link.
- **The sender waits out its whole budget for nothing** (5 s `RPC_TIMEOUT_MS` on the maybeAct
  path) and then, per `test/rpc.stream-errors.spec.ts`, books a contact strike against a peer that
  is perfectly healthy.
- Each leaked stream also holds its muxer state and buffers for the life of the connection.

`registerPing` is worse still: its final `stream.send(...)` / `await stream.close()` sit outside
any `try` at all, so a reset stream rejects the handler promise rather than being logged.

### Verified evidence

Measured by driving malformed bytes at a started `FretService` over two `createMemNode()` peers
and counting `connection.streams.filter(s => s.status === 'open')` on the receiver after each
message. Every row below left one more stream open, and none of them ever closed:

| Protocol | Payload | Why it throws |
|---|---|---|
| maybeAct | `{ not: json }` | `JSON.parse` |
| maybeAct | truncated JSON | `JSON.parse` |
| maybeAct | `key: "!!!bad!!!"` | `u8FromString(key,'base64url')` throws `SyntaxError: Non-base64url character` — in `routeAct`, then **again** in the `nearAnchorOnly` fallback that was supposed to answer for it |
| maybeAct | `key` absent | same decoder, `Unexpected end of data` |
| maybeAct | `breadcrumbs: 5` | `msg.breadcrumbs?.includes(...)` — runs *before* `handleMaybeAct`'s inner `try`, so not even the fallback applies |
| leave | `replacements: 5` | `sanitizeReplacements` reaches `ids.slice(...)` on a number |
| leave | non-JSON | `JSON.parse` |
| announce | the literal `null` | `decodeJson` returns `null`; `snap.from` throws |

Eight malformed messages, eight permanently-open inbound streams. Shapes that did **not** leak,
and should stay that way: `ttl: -1` and a stale `timestamp` (static reject, correct);
`from` mismatched or absent on leave/announce (identity-mismatch drop, which does close);
`successors`/`sample`/`metadata` of the wrong type on announce (swallowed inside
`mergeAnnounceSnapshot`'s own try, handler still answers `{ok:true}`).

One non-leaking wart found alongside and worth fixing here because the same validator covers it:
`want_k: "abc"` makes `inClusterWindow` return `NaN`, so `neighborDistance(...) < NaN` is always
false and the node believes it is never in-cluster for that message. A numeric field arriving as a
string silently disables the membership test rather than being rejected.

### The fix — four changes, three of them at a single site each

**(a) One registration seam that always releases the stream** — new
`registerRpcHandler(node, protocol, serve)` in `src/rpc/protocols.ts`. It wraps `serve` in
`try/catch/finally`, logs the error, and releases the stream on the way out (`abort()` on the
error path, which is synchronous and safe against a stalled remote — same reasoning as
`releaseRpcStream`; a no-op when `serve` already closed it). All five `node.handle` call sites move
onto it and delete their own `try/catch`, including ping's currently-unguarded tail. This is the
rung that matters: a handler added later cannot forget to release, because releasing is no longer
the handler's job.

This is deliberately the *narrow* version of `plan/15-rpc-shared-helper`'s `registerJsonHandler`,
which additionally owns read/decode/validate/reply. That refactor should absorb this seam rather
than reinvent it; the tradeoff accepted here is a small amount of rework in 15 in exchange for
having the regression net and the fix land now, at sequence 7, rather than behind a hard refactor
at sequence 15.

**(b) `decodeJson` rejects a non-object top level.** All five wire messages are JSON objects, so
`null`, an array, a number and a string are all malformed by definition. Rejecting once in the
decoder kills that whole class for every body-reading handler instead of asking each one to
null-check. Keep the existing empty/whitespace guards; add the object check beside them.

**(c) `sanitizeReplacements` requires `Array.isArray(ids)`** before touching `.slice`.

**(d) A per-message validator for `RouteAndMaybeAct`** — export
`validateRouteAndMaybeAct(msg: unknown): msg is RouteAndMaybeActV1` from `src/rpc/maybe-act.ts`
(pure, no libp2p), and call it from `FretService.handleMaybeAct` **immediately after the token
bucket is taken and before the breadcrumb check**. That position is load-bearing and is stated in
`docs/fret.md`: the bucket is taken before any per-message work so invalid messages are metered
too, and everything after it must be cheap. A rejection returns `staticReject()` (the existing
zero-computation empty `NearAnchor`) and increments a new `diag.rejected.malformed` counter
alongside the existing `payloadTooLarge` / `timestampBounds` / `ttlExpired` / `rateLimited` /
`identityMismatch`.

What it checks — no ring walks, no hashing, all O(size of the message):

- `key`: a string that decodes as base64url. Decode it once here and hand the bytes down, so
  `routeAct` and `nearAnchorOnly` cannot each throw on the same field (that double-throw is what
  made the fallback useless). Cap its encoded length.
- `ttl`, `want_k`, `min_sigs`, `timestamp`: `Number.isFinite`. `wants` likewise when present.
- `breadcrumbs`: absent or an array of strings, with a cap on length.
- `correlation_id`: a string with a maximum length — this closes
  `plan/15-rpc-shared-helper`'s "unbounded correlation_id becomes an unbounded cache key" arm for
  the maybeAct path. Say in a comment that 15 generalizes this validator to the other messages.
- `activity`, `digest`: strings when present.

Only the maybeAct message gets a validator here. Generalizing to all four wire types belongs to
15; doing it now would duplicate the work that refactor exists to do.

### Edge cases & interactions

- **A handler that already closed the stream.** `serve` normally closes on its own success path;
  the wrapper's release must be idempotent and must not turn a completed reply into an abort.
  Assert an ordinary valid request over every protocol still returns exactly its normal reply.
- **Release-exactly-once.** Same invariant `test/rpc.stream-errors.spec.ts` pins for senders,
  now on the receive side: count `close`/`abort` calls on a stub stream and assert one total.
- **A malformed message must not be cached.** A `staticReject()` is a guard rejection, not a
  terminal answer, and `docs/fret.md` says guard rejections are never cached. Assert the
  validator's rejection path leaves the dedup cache untouched, so a later well-formed message with
  the same `correlation_id` is not answered with the reject.
- **The token bucket is still taken first.** Assert a stream of malformed maybeAct messages
  drains `bucketMaybeAct` (visible as `diag.rejected.rateLimited` rising once it empties) — the
  validator must not become an unmetered pre-filter.
- **The rejection stays static.** Assert the malformed path performs no ring walk: an empty
  `anchors`/`cohort_hint` and zero `estimated_cluster_size`/`confidence`, exactly like the
  TTL and timestamp rejections, even on a node whose store holds plenty of members.
- **The identity-mismatch drop path** on leave and announce closes the stream today and must keep
  closing it, not start aborting it — it is a normal outcome, not a failure.
- **Recovery after a batch.** Send ≥ 32 assorted malformed messages of every shape in the table
  above over one connection, then a well-formed `maybeAct`, `neighbors`, `leave`, `ping` and
  announce; each must still succeed. Without the fix the 33rd inbound stream on that protocol is
  refused, so this is the test that would have caught the class.
- **No unhandled rejections.** Install a `process.on('unhandledRejection')` collector for the
  spec and fail if anything fires — ping's unguarded tail is exactly that shape. The repo's
  `mocha-exit-watchdog` already fails a run that leaks timers/handles; leave it doing its job.
- **Both transports.** Run the malformed matrix over `createMemNode` (memory + plaintext) and at
  least the headline leak case over `createIdentifyNode` (TCP + noise + yamux), matching how
  `rpc.stream-errors.spec.ts` splits its coverage — a muxer difference must not hide the leak.
- **Concurrency.** Fire the malformed batch concurrently as well as serially; the release path
  must not depend on messages arriving one at a time.
- **Oversized payloads and rate-limit enforcement are `7.5`'s tier**, not this one — but the
  handler wrapper is what makes those tests assertable, so land it here.

### TODO

Phase 1 — the seam
- Add `registerRpcHandler(node, protocol, serve)` to `src/rpc/protocols.ts`; release on every path,
  `abort()` on error, idempotent against a handler that already closed.
- Move all five `node.handle` sites (`neighbors` request, `neighbors/announce`, `maybeAct`,
  `leave`, `ping`) onto it and delete their per-handler `try/catch`; ping's tail comes inside.
- Tighten `decodeJson` to reject a non-plain-object top-level value.
- Guard `sanitizeReplacements` with `Array.isArray`.

Phase 2 — the maybeAct validator
- Export `validateRouteAndMaybeAct` from `src/rpc/maybe-act.ts`; decode `key` once and pass the
  bytes down so `routeAct` / `nearAnchorOnly` stop re-decoding it.
- Call it in `handleMaybeAct` right after `bucketMaybeAct.tryTake()`; reject via `staticReject()`
  plus a new `diag.rejected.malformed` counter.

Phase 3 — the spec
- Delete `test/rpc.fuzz.spec.ts` (zero assertions, and its `createMemoryNode` import is the
  misnamed TCP factory). Add `test/rpc.handler-fuzz.spec.ts` covering every bullet under
  *Edge cases & interactions*, with the evidence table above as its malformed matrix.
- Give each malformed row an assertion on the receiver's open-stream count, not merely
  "did not throw".

Phase 4 — docs and gate
- `docs/fret.md`: state the inbound-handler release contract in *Stream management* beside the
  existing sender-side rule; record the maybeAct validator and its position relative to the token
  bucket in *Cheap-guard rejections*; note the "top level must be a JSON object" decoder rule in
  *Wire formats*.
- Also in *Stream management*: the line "Max inbound: 32 (Edge) / 128 (Core) / Max outbound: 64 /
  256" describes intent that is not implemented — no `maxInboundStreams` is passed to any
  `node.handle`, so every protocol gets libp2p's default 32 regardless of profile. Correct the
  document to say what the code does and point at
  `backlog/debt-inbound-stream-caps-unimplemented` for the gap.
- `cd packages/fret && npx tsc --noEmit && yarn test` must pass.
