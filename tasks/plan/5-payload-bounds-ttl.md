description: Enforce payload bounds and TTL checks in all RPCs
dependencies: FRET core (RPC handlers, rate limiting)
----

Harden all RPC handlers with strict payload size limits and TTL validation. This is a security and stability requirement for production.

### Requirements

- **Payload bounds**: reject messages exceeding profile-specific size limits before full deserialization.
- **TTL checks**: validate TTL > 0 on receipt; decrement before forwarding; drop expired messages.
- **Timestamp bounds**: reject messages with timestamps outside ±5 min window.
- **Explicit backpressure**: when at capacity, respond with Busy/Retry-After rather than silently dropping.
- Apply consistently to all protocol handlers: neighbors, maybeAct, leave, ping.

### Validation

- Each handler checks bounds before processing.
- Metrics for rejected messages (by reason) for diagnostics.

See [fret.md](../docs/fret.md) — Security and abuse considerations, Rate limiting & backpressure.
