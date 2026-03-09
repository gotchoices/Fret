description: Close the replay window by aligning dedup TTL with timestamp validation, strengthening correlation IDs, and adding leave dedup
dependencies: none
files: src/service/dedup-cache.ts, src/rpc/protocols.ts (validateTimestamp ~line 86-88), src/service/fret-service.ts (~line 1206 correlation ID generation), src/rpc/leave.ts
----

### Problem

Three compounding gaps create a 9.5-minute replay window:

1. **Dedup/timestamp mismatch**: The dedup cache TTL is 30 seconds but timestamp validation allows ±5 minutes. Messages pass timestamp validation for 10 minutes (if sent with +5 min future timestamp) but leave the dedup cache after 30 seconds — creating a window for ~18 replay attempts per original message.

2. **Weak correlation IDs**: Generated as `${selfId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`. `Math.random()` uses V8's xorshift128+ generator, which is predictable from observed outputs. An attacker observing a few correlation IDs can predict future ones and pre-fill the dedup cache.

3. **Leave notices have no dedup**: `LeaveNoticeV1` has no correlation ID and no dedup cache protection. A captured leave notice can be replayed repeatedly within the 5-minute timestamp window to continuously re-remove a peer that has rejoined.

### Expected behavior

1. Tighten timestamp validation to ±30 seconds (matching dedup TTL), or extend dedup TTL to match the timestamp window. The narrower window is preferred — ±30s is sufficient for reasonable clock skew.
2. Replace `Math.random()` with `crypto.randomUUID()` or `crypto.getRandomValues()` for correlation ID generation.
3. Add dedup protection to `LeaveNoticeV1` via either a correlation ID field or a per-`from`+timestamp dedup cache.
4. Dedup cache capacity (1024) should be evaluated against expected message rates to ensure it's not trivially exhaustible.

### Threat references

- threat-analysis.md §3.3 (High): Replay attacks with 9.5-minute window
- threat-analysis.md §5.4 (Medium): Weak correlation ID generation
- threat-analysis.md §5.6 (Medium): Timestamp replay window
- threat-analysis.md §3.6 (Medium): Dedup cache poisoning
