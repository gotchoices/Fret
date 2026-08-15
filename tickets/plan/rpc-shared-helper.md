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

Expected behavior: one request helper and one handler-registration helper own the transport boilerplate; a single discriminated result type reports success, unreachable, busy, decode-error, and foreign-protocol distinctly so callers can record failure and drive foreign classification; every decoded message passes a per-message validator; streams are always drained and closed or aborted; an AbortSignal bounds every RPC; and the round-trip clock starts after the stream opens.

Requirements:
- Introduce a shared `rpcRequest(node, peer, protocol, body, opts)` and `registerJsonHandler(node, protocol, fn, maxBytes)`.
- Adopt a single non-throwing, non-fabricating discriminated error contract across all RPC families.
- Add per-message shape validators (field types, peer-id parseability, array caps) in the style of the existing replacement sanitizer.
- Handle stream drain/backpressure; thread an AbortSignal through send and read.
- Start the ping round-trip clock after the stream opens.
- Tighten each RPC's max-bytes to the real ceiling so oversized payloads are rejected before full buffering.

References: review RPC-section findings "Handler error paths leak streams", "fetchNeighbors fabricates success on every failure", "Zero shape validation of decoded messages", and "RPC boilerplate duplicated 4-5x with three error contracts" (neighbors.ts:24/29-44/60-70, maybe-act.ts:16/19/23-25, leave.ts:32/40-42, ping.ts:28/50-51, protocols.ts:59/78-83). This consolidation deletes roughly half of the rpc directory.
