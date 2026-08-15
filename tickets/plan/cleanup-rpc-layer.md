----
description: A set of small, low-risk tidy-ups in the network-message code: dropping needless async, deriving duplicated constants, removing unsafe non-null assertions and unread acknowledgements, and turning a silent data-cleanup step into one that surfaces framing bugs.
files: packages/fret/src/rpc/*
difficulty: easy
----
Mechanical cleanups in the rpc directory that carry no behavior risk on their own:

- The JSON encode and decode helpers are marked async but do no async work; make them synchronous.
- The back-compat protocol-id constants hand-duplicate what the default-network protocol builder already produces; derive them from it instead of restating the strings.
- The stream non-null assertions can be removed by overloading the stream-open helper on its require-existing flag so the type reflects when a stream is guaranteed.
- The ok-true acknowledgements written by the leave and announce paths are never read by the sender; either read them or stop sending the wasted bytes.
- The decoder silently strips NUL bytes, which hides a framing bug; log when a non-whitespace byte is stripped so real framing errors are visible.

Expected behavior: the same wire behavior with less duplication, safer types, no wasted acknowledgement bytes, and a visible signal when the decoder has to strip unexpected bytes.

References: review RPC-section "Mechanical cleanups" (rpc/* various).
