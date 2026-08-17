----
description: The code that sends and receives every network message is copy-pasted four or five times with three inconsistent ways of reporting failure, which leaks connections on bad input, hides unreachable and foreign peers behind fake successful responses, and skips all validation of incoming data — a single shared helper fixes all of these at once.
files: packages/fret/src/rpc/*
difficulty: hard
----
Today every RPC sender repeats the same open, send, close, read, decode, and finally-double-close sequence, and every handler repeats read, decode, handle, send, close, and catch-log. The three families disagree on how they report failure: maybe-act throws, neighbors swallows the error and fabricates a fake empty snapshot, and ping returns an ok-false object. This duplication is the root of several distinct review findings, so one refactor resolves them together.

Consequences to fix as part of this work:

- Handler error paths leak streams. Every handler catch only logs; none aborts or closes the stream, so a malformed request leaves the inbound stream open until the muxer times out while the remote burns its full read window. Ping's fallback send/close also sits outside any try/catch and can reject the handler promise on a reset stream.
- `fetchNeighbors` fabricates success on every failure. Unreachable, busy, decode-error, and foreign-protocol outcomes all return a synthetic empty snapshot indistinguishable from a real one, so the fetched-snapshot counter books garbage, failure and backoff are never recorded, and swallowing the unsupported-protocol error means foreign classification can never happen on this path. The busy-detection check also throws on a null decode, using an exception as control flow into the same fake snapshot.
- No shape validation of decoded messages. The decoder blindly casts to the target type; the `from` field is never parsed as a peer id, snapshot arrays are unbounded within the byte cap (thousands of ids), and breadcrumbs are unbounded and grow every hop. Only the leave-notice replacement sanitizer does this correctly.
- Backpressure and cancellation are ignored. Stream sends that return false or throw when the buffer fills at 128-512 KiB are not handled, no AbortSignal is threaded anywhere, and ping starts its round-trip clock before dialing, inflating first-contact latency. The maybe-act RPC also accepts 512 KiB at the wire layer while the service rejects payloads over 128 KiB only after fully buffering.

Additional arm (added by the `idle-read-timeout` review): **the requester subscribes to the reply stream too late, so end-of-stream is routinely missed.** libp2p's async-iterator adaptor subscribes to the one-shot remote-close event only when iteration *starts*. Every sender here opens the stream, writes, closes, and only *then* begins reading — so a responder that replies quickly (the norm for a small reply) closes before the subscription exists, the event is lost, and the read has no end-of-stream to observe. Measured on both this repo's transports (memory+plaintext and TCP+noise+yamux): a ping reply arrives in under a millisecond and the read then never ends on its own.

Additional arm (added by the `replay-dedup-hardening` review): **an unbounded `correlation_id` becomes an unbounded cache key.** `handleMaybeAct` uses the sender-supplied `correlation_id` verbatim as the duplicate-request cache key, and nothing checks its length — the only bound is the 512 KB whole-message cap the RPC layer applies. The cache bounds the *number* of entries (2048 on Core), not their size, so a sender can inflate the memory a full cache holds for its 30 s lifetime by roughly six orders of magnitude over a normal ~100-character id. The rate limit caps the insertion rate, not the size of each insertion. Same root as the other arms here: no per-message field validation. A maximum length for `correlation_id` (and the same treatment for `key`, `digest`, and the breadcrumb array) belongs in the per-message validator, not in the service handler.

Two durable fixes, either of which retires the whole class rather than this one instance:
- **Begin reading before writing.** The shared request helper owns the whole open/write/read sequence, so it can start iterating the reply stream before it sends the request; the subscription then always predates the response and no event can be missed.
- **Frame the messages.** `docs/fret.md` already specifies "length-prefixed UTF-8 JSON" for all four protocols, but the implementation ships bare JSON and infers message end from stream close. A length prefix makes the reader authoritative about where a message ends, so neither a missed close event nor a timeout guess can truncate or stall it.

Until then `readAllBounded` polls the stream's own read state (`readBufferLength` / `remoteWriteStatus`) every 20ms as a backstop — correct, but it consults properties the shared helper should not need to know about, and it puts a ~20ms floor under every measured RPC round-trip time (which feeds peer health scoring).

Additional arm (added by the `unguarded-bare-peerid-dials` fix): **no single place decides whether a peer may be dialed at all.** `openRpcStream` dials a bare peer id whenever no connection exists, and each of the ~15 outbound call sites is separately responsible for remembering to check first. Some pass `requireExisting: true`, some filter on connection state, several do neither — and the one helper meant to answer "do we have an address for this peer?" was broken for the whole life of the code (it called a libp2p method that does not exist), which nobody noticed precisely because the decision is scattered. Sites dialing peers no address can exist for produce a steady stream of `NoValidAddressesError`. The shared request helper is the natural home for that policy: it already owns open/write/read, so it can own "connection-only", "dial if we have an address", or "dial unconditionally" as one explicit per-call mode rather than a convention each caller re-implements. `tickets/implement/4-dialability-guard-on-outbound-rpc` lands the correct behavior at the existing call sites now; this consolidation is what stops the class from returning.

Additional arm (added by the `dead-state-liveness-seam` review): **the liveness seam now has to guess whether a peer was reached, and the guess is wrong for a peer that answered badly.** `FretService.noteRpcFailure` decides between "this peer refuses our network's protocol" (membership evidence) and "we could not reach this peer at all" (a strike toward marking it `dead`) purely by string/name-matching the thrown error for unsupported-protocol; *every other* thrown error is treated as unreachability. But `decodeJson` throws a plain `Error('empty response')` / `Error('whitespace response')` / a `SyntaxError` (`protocols.ts:49-60`), and `sendMaybeAct` lets those propagate (`maybe-act.ts:44`) — so a peer that accepted the stream, replied, and merely replied *badly* is counted as unreachable, and three such replies mark it dead. The same evidence on the ping path is deliberately classified the other way: `sendPing` collapses empty and undecodable replies into `ok: false` (`ping.ts:68,71,80`), which records relevance decay and no strike. The two RPCs therefore disagree about identical evidence, and the seam cannot tell them apart because the error types do not carry the distinction. The discriminated result type below is the fix: `unreachable` and `decode-error` become different outcomes, and `noteRpcFailure` branches on the outcome instead of sniffing an error message. Verified by reading, not by running: confirming it needs a peer whose maybeAct reply is empty or non-JSON while its stream still opens.

Expected behavior: one request helper and one handler-registration helper own the transport boilerplate; a single discriminated result type reports success, unreachable, busy, decode-error, and foreign-protocol distinctly so callers can record failure and drive foreign classification; every decoded message passes a per-message validator; streams are always drained and closed or aborted; an AbortSignal bounds every RPC; and the round-trip clock starts after the stream opens.

Requirements:
- Introduce a shared `rpcRequest(node, peer, protocol, body, opts)` and `registerJsonHandler(node, protocol, fn, maxBytes)`.
- Adopt a single non-throwing, non-fabricating discriminated error contract across all RPC families.
- Add per-message shape validators (field types, peer-id parseability, array caps) in the style of the existing replacement sanitizer.
- Handle stream drain/backpressure; thread an AbortSignal through send and read.
- Subscribe to the reply stream before writing the request (and/or add length-prefix framing per `docs/fret.md`), then drop `readAllBounded`'s stream-state poll.
- Start the ping round-trip clock after the stream opens.
- Tighten each RPC's max-bytes to the real ceiling so oversized payloads are rejected before full buffering.

Additional arm (added by the `7.1-rpc-deadline-tests` review): **closing the stream is the one step
of an outbound call that the call's own time limit does not cover.** `7-rpc-abort-deadlines` gave
every outbound RPC a whole-call budget and threaded its cancellation signal into the dial, the
stream open and the read — but not into `close()`, which is also a waiting operation. libp2p's
`close()` accepts a cancellation signal (`Stream.close(options?: AbortOptions)`,
`@libp2p/interface` `message-stream.d.ts:139`) and is documented as resolving only "when any unsent
data has been written into the underlying resource" — so a peer that accepts a stream and then stops
reading holds the close open, and neither FRET site passes a signal:

- `protocols.ts:317` — `releaseRpcStream`'s non-cancelled arm does a bare `await stream.close()`.
  Every sender runs this from a `finally` *before* cancelling its deadline, so a call that already
  has its answer can still sit here past its budget. The cancelled arm is fine: it uses the
  synchronous `abort()`, which is exactly why that arm was written.
- `maybe-act.ts:64` — the half-close that flushes the request sits inside the `try`, so if it
  stalls the deadline fires with nothing listening, the `finally` is never reached, and the stream
  is held as well as the caller.

Worst case is the shutdown path: `sendLeave` and `announceNeighbors` run from `stop()`'s leave
fan-out, whose stated reason for having a budget is to keep shutdown bounded. Whether anything
bounds the tail at all depends on the muxer's `inactivityTimeout`; no default for it was found in
this repo's installed dependencies, so no magnitude is claimed here beyond "not FRET's budget".
Established by reading the code and libp2p's type declarations, not by running it — confirming it
needs a remote that accepts a stream and then stops reading, which no current test stub does.

This belongs here rather than as a point fix because the shared `rpcRequest` helper is what makes
the class unrepresentable: when one helper owns every await in the open/write/read/close sequence,
no call site can perform an unsignalled one. Threading the signal into both sites above is the
interim fix if this consolidation is deferred.

Arm resolved elsewhere (added while planning `7-stabilization-concurrency`): two of the
requirements above — **thread an AbortSignal through send and read**, and **start the ping
round-trip clock after the stream opens** — are landed by
`tickets/implement/7-rpc-abort-deadlines`, which adds a `deadline()` helper
(`src/utils/deadline.ts`), gives `openRpcStream` / `readAllBounded` / all five senders a
`{ signal, timeoutMs }` contract with a shared `RPC_TIMEOUT_MS`, and adds a run-scoped
`AbortController` on `FretService`. This consolidation should **absorb** that contract into
the shared `rpcRequest` helper rather than re-designing it — the cancellation rule it
establishes ("our own abort is not evidence about the peer", so it never scores a contact
failure) is a correctness rule the shared helper must preserve, and it is the natural place
for the `unreachable` / `decode-error` / `timeout` distinction this ticket already wants.

References: review RPC-section findings "Handler error paths leak streams", "fetchNeighbors fabricates success on every failure", "Zero shape validation of decoded messages", and "RPC boilerplate duplicated 4-5x with three error contracts" (neighbors.ts:24/29-44/60-70, maybe-act.ts:16/19/23-25, leave.ts:32/40-42, ping.ts:28/50-51, protocols.ts:59/78-83). This consolidation deletes roughly half of the rpc directory.

Arm resolved elsewhere (added while planning `test-coverage-gaps`): the two arms above about
inconsistent failure reporting — *"fetchNeighbors fabricates success on every failure"* and *"the
liveness seam now has to guess whether a peer was reached"* — are about to acquire a regression net
in `implement/6.1-rpc-stream-error-tests`, a new `test/rpc.stream-errors.spec.ts` that drives each
sender against a reply that resets mid-stream, that ends cleanly mid-JSON, and that stalls after a
partial payload. That spec deliberately **pins today's inconsistent contract** (ping collapses an
undecodable reply into `ok: false` and records no strike; maybeAct throws on the same evidence and
the service books a contact failure; fetchNeighbors fabricates an empty snapshot), with each such
assertion commented as belonging to this ticket. So expect to *update* those assertions here rather
than discover them as failures: when the discriminated result type lands, the decode-error cases
become `decode-error` outcomes and the contact strike on the maybeAct path goes away. The
invariants in that spec — a partial payload is never parsed as a whole message, the stream is
released exactly once, no unhandled rejection escapes, our own cancellation scores nothing — must
survive the refactor unchanged.
