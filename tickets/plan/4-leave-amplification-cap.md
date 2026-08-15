----
description: When a peer announces it is leaving, the node fires off a large burst of outbound network work driven by unverified data in that message, so an attacker can send one small message and trigger roughly ten to fourteen outbound requests plus a peer eviction.
prereq: transport-identity-verification
files: packages/fret/src/service/fret-service.ts
difficulty: medium
----
Each accepted `handleLeave` removes the peer named in the notice, then acts on the attacker-supplied replacement list: it dials up to six replacements (a ping plus a snapshot-announce each) and additionally runs four `fetchNeighbors` — roughly ten to fourteen outbound RPCs plus one peer removal per inbound leave message. It also rebuilds the full neighbor snapshot inside the replacement loop, up to six times. An attacker sending N leave notices with varied `from`/replacement fields multiplies this by N.

This covers review finding M-core-5 (leave handler is an amplification lever).

### Expected behavior
- Outbound work triggered by a single leave notice is bounded to a small, configurable ceiling — the amplification factor per accepted leave should be a handful of operations, not ten-plus.
- Suggested replacements are treated as untrusted hints, not commands to warm. Per the design doc's "untrusted hints" guidance, replacements are inserted into the routing table as `unknown` and left for the normal classification pass to vet and probe, rather than being pinged/announced directly inside the handler.
- The neighbor snapshot is built once per leave, not rebuilt per replacement.

### Notes
- **Overlapping arm at the same site.** `tickets/implement/4-dialability-guard-on-outbound-rpc` adds a reachability guard to this handler's warm loop (`sendPing` on replacement ids currently dials bare peer ids with no check, and those ids are near-guaranteed to have no known address). The two changes are compatible and complementary — the guard belongs inside whatever bounded loop this ticket's redesign leaves behind, and if replacements end up inserted as `unknown` and handed to the classification pass as proposed above, the guard's job moves there with them. Whichever lands second should keep the other's behavior rather than reverting it.
- Transport-level authentication of the leave (verifying the notice's `from` against the authenticated `connection.remotePeer`) is handled separately by the `transport-identity-verification` ticket; assume it lands. This ticket is about bounding amplification even for an authenticated leave.
- The existing leave token bucket rate-limits inbound acceptance but not the per-leave outbound fan-out, which is the gap here.

The plan agent should settle the outbound ceiling (and whether it is profile-tuned), confirm inserting replacements as `unknown` integrates cleanly with the classification/re-probe passes, and settle whether the four `fetchNeighbors` are kept, reduced, or deferred to normal stabilization.

References: fret-service.ts `handleLeave` (~615-676). Review "Core service" major finding (leave handler is an amplification lever); threat-analysis.md §4.2.
