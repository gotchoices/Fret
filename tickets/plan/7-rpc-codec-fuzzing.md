----
description: The only fuzz test for the network-message codec asserts nothing and exercises a single malformed shape, so add real round-trip, malformed-payload, and backpressure tests that prove handlers never crash or leak and that a valid request still succeeds afterward.
files: packages/fret/test/rpc.fuzz.spec.ts, packages/fret/src/rpc/*
----
The lone codec fuzz test has zero assertions and feeds only one malformed shape, so it provides no real robustness guarantee. Replace it with a meaningful fuzzing tier over the JSON wire formats.

### Coverage

- Round-trip: encode then decode each wire type (neighbor snapshot, route-and-maybe-act, near-anchor, serialized table) and assert structural equality.
- Malformed payloads: truncated JSON, missing required fields, wrong types, extra fields, oversized strings, invalid base64url, and negative numbers where unsigned is expected. No handler may crash, leak a stream, or produce an unhandled rejection.
- Backpressure: oversized payloads are rejected before a full parse, and per-peer and global token-bucket limits are enforced.
- Recovery: after a batch of malformed and oversized inputs, a subsequent well-formed request must still succeed — proving the handler path is not left in a broken state.

### Approach

Use a property-based generator (for example fast-check) or a dedicated fuzzer to produce semi-valid and invalid payloads. Assert the absence of crashes, leaks, and unhandled rejections rather than relying on the test simply not throwing.

References: review finding on the fuzz test (zero assertions, one malformed shape). See `docs/fret.md` wire-format and rate-limiting/backpressure sections. This test tier pairs naturally with the shared-helper refactor's per-message validators and single error contract.
