description: Operating profile enforcement (Edge vs Core rate limits)
dependencies: FRET core (rate limiting, profile configuration)
----

Verify that Edge and Core profiles correctly enforce their respective limits.

### Coverage

- Token bucket rate limits: per-peer and global byte/message rates honored for each profile.
- Queue depths: bounded queues reject or backpressure at profile-specified limits.
- Concurrent act limits: Edge allows fewer concurrent operations than Core.
- Snapshot caps: Edge ≤ 6/6/6 (succ/pred/sample), Core ≤ 12/12/8.
- Stream limits: Edge max inbound 32 / outbound 64, Core max inbound 128 / outbound 256.
- Busy/Retry-After responses emitted when limits reached.

See [fret.md](../docs/fret.md) — Operating profiles, Rate limiting & backpressure, Stream management.
