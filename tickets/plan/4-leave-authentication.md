description: Authenticate leave notices and add liveness verification before peer removal
dependencies: 5-message-signatures (leave notices need a sig field), 5-transport-identity-verification
files: src/rpc/leave.ts, src/service/fret-service.ts (handleLeave ~line 473-534), docs/fret.md
----

### Problem

`handleLeave` accepts a leave notice with a `from` field and immediately removes the specified peer from the store, then triggers expensive replacement warming (up to 6 pings + 4 snapshot fetches + announcements to 4 neighbors). There is no verification that the leave notice actually came from the departing peer.

An attacker sends `LeaveNoticeV1` with `from: <honest_peer_id>` to all of the honest peer's neighbors. Each recipient removes the honest peer and starts replacement warming. The honest peer is erased from the network's view without actually leaving.

The `replacements` field compounds this — suggested replacements from the spoofed notice take priority ("Suggested first, departing peer vouched for them"), so the attacker can inject Sybil nodes as trusted replacements.

With Right-is-Right in place, this also becomes an ejection-forgery vector: an attacker could mimic dispute-resolution removal signals using the same unauthenticated leave path.

### Expected behavior

1. Leave notices require a valid signature from the departing peer (depends on message signatures ticket).
2. Before removing a peer based on a leave notice, the recipient pings the allegedly departing peer to confirm departure. Only remove if the peer is unreachable or confirms it is leaving.
3. Suggested replacements are treated as untrusted hints — verify them (ping + coord check) before inserting into routing state with any priority.
4. Leave notices gain dedup protection (correlation ID or per-sender+timestamp dedup) to prevent replay.

### Threat references

- threat-analysis.md §3.2 (Critical): Leave notice spoofing removes honest peers
- threat-analysis.md §7.1 (Critical): Forced peer removal at scale
- threat-analysis.md §7.2 (High): Leave replacement poisoning
- threat-rir-mitigated.md §3.2, §7.1: Unchanged by RiR
