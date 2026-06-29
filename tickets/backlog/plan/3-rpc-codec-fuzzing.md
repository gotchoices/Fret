description: RPC codec fuzzing for JSON wire formats
dependencies: FRET RPC codec layer
----

Fuzz the JSON codec layer to ensure robustness against malformed input.

### Coverage

- **Round-trip**: encode then decode all wire types (NeighborSnapshotV1, RouteAndMaybeActV1, NearAnchorV1, SerializedTable); assert equality.
- **Malformed payloads**: truncated JSON, missing required fields, wrong types, extra fields, oversized strings, invalid base64url, negative numbers where unsigned expected.
- **Backpressure**: verify that token-bucket limits are enforced per-peer and globally; oversized payloads rejected before full parse.

### Approach

- Use fast-check or a dedicated fuzzer to generate semi-valid and invalid payloads.
- No handler should crash, leak memory, or produce unhandled promise rejections.

See [fret.md](../docs/fret.md) — Wire formats, Rate limiting & backpressure.
