## FRET Threat Analysis

Comprehensive security analysis of the FRET (Finger Ring Ensemble Topology) protocol implementation. Each vector includes severity, attack description, preconditions, impact, and current mitigations.

**Severity scale**: Critical (system compromise / consensus break), High (targeted disruption / data integrity), Medium (degraded service / partial information leakage), Low (minor nuisance / theoretical).

---

### 1. Sybil & Identity Attacks

#### 1.1 Sybil Flood — Ring Region Domination
**Severity: Critical**

An attacker generates many libp2p identities whose SHA-256 ring coordinates cluster around a target key region. Since peer IDs are public-key-based and free to generate, there is no cost to creating thousands of identities. By placing enough Sybil nodes in a ring arc, the attacker dominates the successor/predecessor sets around target keys.

- **Preconditions**: Ability to generate libp2p key pairs and connect to the network.
- **Impact**: Attacker controls the cohort for targeted keys. Can intercept, censor, or forge activity results (commit certificates). Undermines the entire cluster-based consensus model since `assembleCohort` draws from the two-sided walk which Sybil nodes dominate.
- **Current mitigations**: Capacity limit (C=2048) bounds total stored peers. Relevance-based eviction may eventually remove inactive Sybils. Protected S/P neighbors cannot be evicted (`protectedIdsAround`). But none of these prevent a determined Sybil attacker with enough identities.
- **Missing**: No proof-of-work, stake, or identity-cost mechanism. No diversity requirements (IP/AS) despite being mentioned in the design doc. The `report()` method is a no-op.

#### 1.2 ID Grinding for Strategic Ring Placement
**Severity: High**

An attacker pre-computes key pairs until finding peer IDs whose `SHA-256(peerId.toMultihash().bytes)` lands at desired ring coordinates. SHA-256 is fast (~10M hashes/sec on consumer hardware), so targeting a 32-bit prefix takes seconds, and a 48-bit prefix takes hours.

- **Preconditions**: Offline computation, knowledge of target key coordinates.
- **Impact**: Strategic placement near any key coordinate of interest. Combined with Sybil attacks, enables precise targeting of specific clusters.
- **Current mitigations**: None. The hash function is standard SHA-256 with no computational puzzle or verifiable delay.

#### 1.3 Routing Table Pollution via Snapshot Injection
**Severity: High**

`mergeAnnounceSnapshot` (`fret-service.ts:590-630`) and `mergeNeighborSnapshots` (`fret-service.ts:750-786`) accept peer IDs from remote snapshots and upsert them directly into the Digitree with no verification beyond timestamp freshness. An attacker who connects to a target can:

1. Send an announcement containing Sybil peer IDs in `successors`, `predecessors`, and `sample` arrays.
2. Each ID is hashed and upserted: `this.store.upsert(pid, coord)` with `applyTouch`.
3. The target's routing table fills with attacker-controlled entries.

The `sample` field is particularly dangerous: it includes pre-computed `coord` values that are decoded with `u8FromString(s.coord, 'base64url')` and used directly — **without verifying that the coord matches `SHA-256(peerId.toMultihash().bytes)`**. This means an attacker can place entries at arbitrary ring positions without even needing to grind IDs.

- **Preconditions**: One connection to the target peer.
- **Impact**: Corrupts routing decisions, enables eclipse attacks, poisons network size estimates.
- **Current mitigations**: Capacity enforcement (2048 entries), relevance-based eviction, profile-bounded snapshot sizes (capSucc/capPred/capSample). But a steady stream of announcements with varied Sybil IDs eventually dominates the table.

#### 1.4 Cohort/Coordinator Manipulation
**Severity: High**

`assembleCohort` (`fret-service.ts:850-870`) performs an alternating two-sided walk from successor/predecessor lists. If an attacker controls enough entries near a key coordinate, they control which peers appear in the cohort. Since `inCluster` is determined by `neighborDistance(selfId, coord, k) <= 1`, an attacker's Sybil nodes can:

- Claim to be in-cluster for any key
- Be selected as activity handlers
- Forge commit certificates if the `activityHandler` callback trusts the cohort composition

- **Preconditions**: Sybil nodes in the target key's ring neighborhood.
- **Impact**: Consensus subversion, forged commit certificates, censorship of legitimate cohort members.
- **Current mitigations**: None beyond the cohort size k. No diversity or reputation checks on cohort membership.

---

### 2. Eclipse Attacks

#### 2.1 Full Eclipse via S/P Set Control
**Severity: Critical**

An attacker places Sybil nodes at ring coordinates immediately clockwise and counterclockwise of a target node. Since `stabilizeOnce` (`fret-service.ts:715-722`) only probes up to 4 near neighbors and merges their snapshots, if all near neighbors are attacker-controlled, the target receives only attacker-curated view of the network.

The attack proceeds:
1. Generate IDs near the target's ring coordinate (both sides).
2. Connect to target; appear in its S/P sets via stabilization merges.
3. Serve manipulated neighbor snapshots that exclude honest peers.
4. Target's routing table gradually fills with attacker nodes.

- **Preconditions**: ~2m Sybil IDs near the target (where m=8), plus connectivity to the target.
- **Impact**: Total control over target's network view. All routing, cluster membership, and activity forwarding go through the attacker. Target cannot discover honest peers.
- **Current mitigations**: S/P entries are protected from eviction (`protectedIdsAround`). Multiple bootstrap peers provide initial diversity. `seedFromPeerStore` pulls from libp2p's peer store each stabilization tick. But if the attacker controls all near positions, these mitigations are insufficient.
- **Missing**: Mandatory multi-path bootstrap verification. Random walk discovery. Alert on sudden S/P set changes (mentioned in design doc but not implemented).

#### 2.2 Route Hijacking for Specific Keys
**Severity: High**

An attacker positions nodes between the requesting peer and the target key's cluster. When a `RouteAndMaybeAct` message arrives, the attacker's node can:

1. Claim `inCluster` (since `neighborDistance` depends on the attacker's local store, which they control).
2. Return a forged `NearAnchorV1` redirecting to more attacker nodes.
3. Consume the activity payload and return a forged commit certificate.

Since `routeAct` (`fret-service.ts:939-1001`) forwards to `chooseNextHop` which selects from locally known candidates, an eclipsed node always routes through the attacker.

- **Preconditions**: Sybil nodes on the routing path between requester and target cluster.
- **Impact**: Interception of activities, forged responses, censorship.
- **Current mitigations**: Breadcrumb loop detection prevents re-visiting the same node. TTL limits total hops. But neither prevents the attacker from presenting a chain of distinct Sybil nodes.

#### 2.3 Route Blackholing
**Severity: Medium**

An attacker node accepts forwarded `RouteAndMaybeAct` messages but silently drops them or returns unhelpful `NearAnchorV1` responses with bogus peer hints.

- **Preconditions**: Attacker node on the routing path.
- **Impact**: Lookup failures, activity timeouts. The requesting `iterativeLookup` generator retries with different candidates but may keep selecting attacker nodes.
- **Current mitigations**: `iterativeLookup` retries up to `maxAttempts`. `recordBackoff` penalizes unresponsive peers. Backoff penalty is included in cost function. But there's no reputation propagation — only the direct requester learns about the blackhole.

#### 2.4 Network Size Estimate Manipulation
**Severity: High**

`estimateSizeAndConfidence` (`size-estimator.ts:18-48`) computes `n_est = 2^256 / median_gap` from known peers. An attacker who controls entries in the store can skew the estimate:

- **Inflate**: Insert entries with small gaps (clustered coordinates) to make the network appear larger.
- **Deflate**: Remove entries (via leave notices) or insert with large gaps to make the network appear smaller.

This is amplified by `reportNetworkSize` (`fret-service.ts:1061-1078`) which accepts external estimates with no authentication. Any code path calling `reportNetworkSize` can inject arbitrary estimates that influence `getNetworkSizeEstimate`.

A deflated estimate increases `nearRadius` (from `computeNearRadius`), causing the routing cost function to stay in "far mode" (preferring connected peers over distance), reducing routing accuracy. An inflated estimate shrinks `nearRadius`, potentially causing premature "near mode" switching.

- **Preconditions**: Ability to influence the target's Digitree entries (via snapshot injection) or access to `reportNetworkSize`.
- **Impact**: Routing performance degradation, incorrect payload inclusion decisions, false partition detection.
- **Current mitigations**: Median gap (not mean) provides some resistance to outliers. Confidence weighting in `getNetworkSizeEstimate`. But the median is still easily manipulable if the attacker controls enough entries.

#### 2.5 Backoff Exploitation
**Severity: Medium**

The backoff mechanism (`recordBackoff`/`getBackoffPenalty`, `fret-service.ts:1033-1052`) exponentially penalizes peers that return busy or fail. An attacker who can trigger busy responses from honest peers (e.g., by consuming their rate limit tokens with spam) effectively removes them from routing consideration.

- **Preconditions**: Ability to cause target peers to return `BusyResponseV1`.
- **Impact**: Good peers penalized in routing decisions, traffic shifted to attacker-controlled nodes.
- **Current mitigations**: Backoff has a max factor of 32. `clearBackoff` resets on success. But the penalty persists until the next successful interaction.

---

### 3. Protocol & Message Attacks

#### 3.1 Message Forgery — Unsigned Messages
**Severity: Critical**

Despite the design doc specifying "All messages signed with sender's private key" and the wire formats including `sig`/`signature` fields, **no signatures are ever generated or verified**:

- `NeighborSnapshotV1.sig` is always `''` (`fret-service.ts:814`)
- `RouteAndMaybeActV1.signature` is always `''` (`fret-service.ts:1257`)
- `LeaveNoticeV1` has no signature field at all (`leave.ts:9-14`)

Any peer on the network can craft messages with arbitrary `from` fields. The `from` field in `NeighborSnapshotV1` is trusted by `mergeAnnounceSnapshot` to hash and insert the supposed sender. `handleLeave` trusts `notice.from` to remove the specified peer from the store.

- **Preconditions**: Any network connection.
- **Impact**: Complete message forgery. Impersonate any peer. Inject false routing state. Remove honest peers via spoofed leave notices.
- **Current mitigations**: libp2p's transport-level authentication (Noise protocol) authenticates the connection, but FRET does not verify that message-level `from` fields match the authenticated connection peer ID.

#### 3.2 Leave Notice Spoofing
**Severity: Critical**

`handleLeave` (`fret-service.ts:473-534`) accepts a leave notice, removes the specified peer from the store, and then:
1. Warms up to 6 replacement peers (pings + announces)
2. Fetches neighbor snapshots from up to 4 replacements
3. Announces replacement info to neighbors

An attacker sends `LeaveNoticeV1` with `from: <honest_peer_id>` to all of the honest peer's neighbors. Each recipient removes the honest peer from their routing table and starts expensive replacement warming. The honest peer is effectively erased from the network's view without actually leaving.

The `replacements` field in the spoofed notice can point to attacker-controlled nodes, which recipients will then ping and merge into their routing tables.

- **Preconditions**: Knowledge of target peer's ID and its neighbors.
- **Impact**: Targeted peer removal from the network. Replacement poisoning. Amplified resource consumption (each recipient does 6 pings + 4 snapshot fetches).
- **Current mitigations**: Rate limiting via `bucketLeave` (20 tokens, 10/s refill for core). Timestamp validation (±5 min). `sanitizeReplacements` validates peer ID format. But no authentication of the sender.

#### 3.3 Replay Attacks with Future Timestamps
**Severity: High**

The dedup cache (`DedupCache`) has a 30-second TTL and 1024-entry capacity. After 30 seconds, a previously seen `correlation_id` can be replayed. The timestamp validation window is ±5 minutes, so messages remain valid for replay for up to 5 minutes.

Worse: an attacker can craft messages with timestamps up to +5 minutes in the future. Such a message remains within the ±5 minute window for up to 10 minutes total. Combined with the 30-second dedup TTL, this creates a **9.5-minute replay window** during which the same message can be replayed every 31 seconds — approximately 18 replay attempts per original message.

`correlation_id` format is `${selfId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` — the random component uses `Math.random()` which is not cryptographically secure and is predictable in some environments.

Leave notices are particularly vulnerable: `LeaveNoticeV1` has no correlation ID and no dedup cache protection, so a captured leave notice can be replayed repeatedly within the 5-minute window to continuously re-remove a peer that has rejoined.

- **Preconditions**: Observation of valid messages (on-path attacker or compromised relay). Every forwarding hop sees the full message in cleartext, so any routing participant qualifies.
- **Impact**: Duplicate activity execution (double pend/commit). Repeated leave-forced removal of honest peers. Stale routing decisions.
- **Current mitigations**: 30s dedup window (maybeAct only). Timestamp freshness check. Breadcrumb loop detection.
- **Gap**: 30s dedup is too short for the 5-minute (or 10-minute with future timestamps) validity. Leave notices have no dedup at all.

#### 3.4 Announcement Flooding — No Inbound Rate Limit
**Severity: High**

The `/fret/1.0.0/neighbors/announce` handler (`neighbors.ts:34-45`) accepts up to 128KB of JSON, parses it, and triggers `mergeAnnounceSnapshot` which performs multiple async operations: hashing peer IDs, upserting into the store, touching relevance scores, enforcing capacity, emitting discovery events, and potentially sending outbound announcements to newly discovered peers.

Critically, **the inbound announce handler has zero rate limiting**. The `registerNeighbors` function at `neighbors.ts:34` calls `onAnnounce(snap.from, snap)` directly with no token bucket check. The `bucketNeighbors` only guards the outbound `handleNeighborsRequest` (snapshot response), not the inbound announce path. The `bucketAnnounce` only limits outbound announcements sent by the victim, not announcements received.

Additionally, `mergeAnnounceSnapshot` does not apply the profile-bounded caps (capSucc/capPred) that `mergeNeighborSnapshots` does — it processes all successor/predecessor entries in the snapshot without slicing.

- **Preconditions**: Connection to target.
- **Impact**: CPU/memory pressure from hash computations (each peer ID = SHA-256 + relevance scoring with KDE). Outbound announcement amplification (discovered peers trigger `announceToNewPeers`, each cascading to `announceFanout` peers). At sustained rate, can overwhelm the event loop, especially on Edge devices.
- **Current mitigations**: `readAllBounded` limits payload to 128KB. `enforceCapacity` bounds store. `bucketAnnounce` limits outbound cascade. But the inbound announce path itself is completely unrated.
- **Missing**: Rate limit on inbound announce processing. Array length caps matching `mergeNeighborSnapshots`.

#### 3.5 JSON Parsing Attacks
**Severity: Low**

`decodeJson` (`protocols.ts:24-35`) strips whitespace and calls `JSON.parse`. Potential concerns:

- **Prototype pollution**: `JSON.parse` is safe from prototype pollution by default, but if parsed objects are later spread into other objects with `...`, attacker-controlled keys like `__proto__` could cause issues. The `metadata` field (`Record<string, any>`) is spread into store updates.
- **Deep nesting**: Deeply nested JSON can cause stack overflow in `JSON.parse`.
- **Large strings**: A 512KB JSON string with many keys could cause memory pressure during parsing.

- **Preconditions**: Ability to send messages.
- **Impact**: Potential prototype pollution via metadata. Parsing-related memory spikes.
- **Current mitigations**: `readAllBounded` limits total bytes. `maxBytes` per protocol.

#### 3.6 Dedup Cache Poisoning
**Severity: Medium**

The dedup cache (`DedupCache`) has max 1024 entries. An attacker can pre-fill the cache by sending 1024 `RouteAndMaybeAct` messages with unique `correlation_id` values. Once full, `evictExpired` runs first, then `evictOldest` — the oldest entry is removed. This means the attacker can evict legitimate cached results, allowing:

1. Repeated processing of the same request (bypass dedup protection).
2. Race conditions where the same activity is processed multiple times.

- **Preconditions**: Ability to send maybeAct messages (rate limited to 32/16 for core).
- **Impact**: Dedup protection bypassed for legitimate requests. Potential double-execution of activities.
- **Current mitigations**: Rate limiting on maybeAct. Cache size of 1024 provides some buffer.

#### 3.7 Stream Resource Exhaustion
**Severity: Medium**

`readAllBounded` (`protocols.ts:42-84`) reads from a stream with a 5-second timeout and 100ms idle timeout after first data. An attacker can:

1. **Slow-read attack**: Send data very slowly (one byte at a time, each within the 100ms idle window), tying up the handler for up to 5 seconds per connection.
2. **Half-open streams**: Open streams but never send data, consuming the 5-second timeout before the handler can proceed.

With multiple connections, this ties up handler threads and exhausts the in-flight limits.

- **Preconditions**: Multiple connections to target.
- **Impact**: Handler exhaustion, effective DoS.
- **Current mitigations**: 5-second absolute timeout. `readAllBounded` byte limit. In-flight concurrency cap on maybeAct (16 core). libp2p connection limits.

---

### 4. Denial of Service & Resource Exhaustion

#### 4.1 Global Rate Limit Exhaustion
**Severity: High**

All token buckets are **global per-node, not per-peer**. A single attacker with one connection can consume all tokens:

| Bucket | Core capacity/refill | Time to exhaust |
|---|---|---|
| `bucketNeighbors` | 20 / 10/s | 2 seconds |
| `bucketMaybeAct` | 32 / 16/s | 2 seconds |
| `bucketPing` | 30 / 15/s | 2 seconds |
| `bucketLeave` | 20 / 10/s | 2 seconds |
| `bucketAnnounce` | 16 / 8/s | 2 seconds |

Once exhausted, all legitimate peers receive `BusyResponseV1` or have their requests dropped. The attacker effectively denies service to the entire node.

- **Preconditions**: One connection, ability to send rapid requests.
- **Impact**: Complete service denial for all peers interacting with the target node.
- **Current mitigations**: Token bucket refill provides recovery. libp2p connection limits.
- **Missing**: Per-peer rate limiting. Per-peer token buckets. Connection-level backpressure.

#### 4.2 Leave Storm Amplification
**Severity: High**

Each `handleLeave` invocation (`fret-service.ts:473-534`) triggers:
1. Store removal of the departed peer
2. Up to 6 replacement pings (outbound network I/O)
3. Up to 4 neighbor snapshot fetches (outbound network I/O + parsing)
4. Announcement to up to 4 neighbors (outbound network I/O)

An attacker sending N leave notices (with different `from` values) triggers ~14N outbound operations. The `bucketLeave` rate limits leave *handling* to 20/10 per second, but each accepted leave generates far more outbound traffic.

If the attacker's leave notices include `replacements` pointing to slow/unresponsive hosts, each replacement warming operation blocks waiting for timeouts, compounding the amplification.

- **Preconditions**: One connection, crafted leave notices.
- **Impact**: Bandwidth and CPU amplification. Target node spends resources chasing phantom departures. Outbound connection exhaustion.
- **Current mitigations**: `bucketLeave` rate limiting. `departureDebounce` (2s per coordinate region). Maximum 6 replacements per leave. But the amplification factor is still ~7x per accepted leave.

#### 4.3 Unbounded Map Growth
**Severity: Medium**

Several internal maps have no hard capacity limits:

- `backoffMap: Map<string, {until, factor}>` — grows with every peer that returns busy or fails. Never pruned except by `clearBackoff` on success or `getBackoffPenalty` on expiry (lazy pruning). An attacker sending messages from many peer IDs creates entries that persist until their backoff expires.
- `announcedIds: Map<string, number>` — pruned at 4096 entries, but only when emitting new discoveries. Between prunes, can grow unbounded.
- `departureDebounce: Map<string, number>` — pruned at 256, but only on departure events.
- `networkObservations: Array` — capped at 100 entries. Adequately bounded.

- **Preconditions**: Sustained attack from varied peer IDs or connection patterns.
- **Impact**: Gradual memory growth. In extreme cases, GC pressure or OOM.
- **Current mitigations**: Lazy pruning thresholds exist for some maps. `networkObservations` is properly bounded.

#### 4.4 CPU Exhaustion via Hash Computation
**Severity: Medium**

Every peer ID received in a snapshot must be hashed: `hashPeerId(peerIdFromString(pid))` calls `SHA-256`. In `mergeAnnounceSnapshot`, processing a single announcement with 12 successors + 12 predecessors + 8 sample entries = 32 SHA-256 hashes plus 32 store upserts. At 128KB max, a single announcement can contain hundreds of peer IDs.

- **Preconditions**: One connection, crafted announcements.
- **Impact**: CPU-bound processing delays stabilization and routing. Event loop blocking if SHA-256 is synchronous (it's async via multiformats but still CPU-intensive).
- **Current mitigations**: Profile-bounded caps on processed entries (capSucc/capPred/capSample). `readAllBounded` payload limit.

#### 4.5 Stabilization Amplification
**Severity: Medium**

`startStabilizationLoop` (`fret-service.ts:662-684`) runs every 300ms (active) or 1500ms (passive) and calls:
1. `seedFromPeerStore` — iterates all known peers
2. `seedFromBootstraps` — up to 8 bootstrap peers
3. `stabilizeOnce` — pings 4 neighbors + fetches 4 snapshots

An attacker who manipulates the peer store (via snapshot injection) to contain many entries makes `seedFromPeerStore` expensive. The stabilization loop has **no jitter**, making all nodes synchronized and creating thundering-herd patterns.

- **Preconditions**: Ability to inflate the target's peer store.
- **Impact**: Periodic CPU/network spikes. Thundering-herd effects in dense networks.
- **Current mitigations**: Bounded probe counts (4 neighbors). Profile-tuned cadence.
- **Missing**: Stabilization jitter (mentioned in design doc but not implemented).

#### 4.6 Forwarding Loop via Distinct Sybils
**Severity: Low**

Breadcrumb protection prevents revisiting the same node, but an attacker with N distinct Sybil nodes can create a forwarding chain of length min(N, TTL). Each hop consumes resources on the forwarding node. With default TTL=8, this is bounded.

- **Preconditions**: Multiple Sybil nodes on the routing path.
- **Impact**: Wasted resources on forwarding chain, delayed responses.
- **Current mitigations**: TTL limit (default 8). `maxAttempts` in iterative lookup. Breadcrumb loop detection.

---

### 5. Cryptographic & Data Integrity

#### 5.1 Complete Absence of Message Signatures
**Severity: Critical**

The single most significant security gap. The design doc requires signed messages, but the implementation sets all signature fields to empty strings:

- `snapshot()` returns `sig: ''` (line 814)
- `iterativeLookup` creates messages with `signature: ''` (line 1257)
- `LeaveNoticeV1` has no signature field at all

Without signatures:
- Any message can be forged
- The `from` field is unverified
- Leave notices can target any peer
- Neighbor snapshots can claim any identity
- RouteAndMaybeAct messages can be tampered with in transit

This undermines every trust assumption in the protocol.

- **Impact**: Enables nearly every other attack in this document at lower cost.
- **Remediation priority**: Immediate. This is a prerequisite for all other security measures.

#### 5.2 No `from` Field Verification Against Transport Identity
**Severity: Critical**

Even without per-message signatures, FRET could verify that the `from` field in messages matches the authenticated peer ID from the libp2p transport (Noise protocol). This is not done anywhere:

- `registerNeighbors` (`neighbors.ts:34-45`) — the announce handler reads `snap.from` but never checks it against `stream.remotePeer`.
- `registerMaybeAct` (`maybe-act.ts:16`) — the handler receives `msg` but has no access to the stream's remote peer.
- `registerLeave` (`leave.ts:32`) — the handler receives `msg.from` with no verification.

libp2p's `node.handle()` callback actually receives `IncomingStreamData` which contains `connection.remotePeer` — the transport-authenticated identity of the sender. However, all FRET handlers destructure this to just `stream: Stream`, discarding the `connection` object entirely. A grep for `remotePeer` across the entire `src/` directory returns zero matches.

- **Preconditions**: Any connection. Forged `from` field in any message.
- **Impact**: Trivial impersonation. Leave spoofing. Snapshot impersonation.
- **Remediation**: Accept the full `IncomingStreamData` in each handler and verify `connection.remotePeer.toString() === message.from`.

#### 5.3 Coordinate Spoofing in Sample Entries
**Severity: High**

In `mergeAnnounceSnapshot` (`fret-service.ts:616-623`), sample entries contain pre-computed coordinates:

```typescript
const coord = u8FromString(s.coord, 'base64url');
this.store.upsert(s.id, coord);
```

The `coord` is used directly without verifying `coord === SHA-256(peerId.toMultihash().bytes)`. An attacker can place a peer ID at any ring position by providing a spoofed coordinate. This breaks the fundamental assumption that ring positions are deterministic from peer IDs.

In contrast, successors/predecessors in the same snapshot are re-hashed from the peer ID:
```typescript
const coord = await hashPeerId(peerIdFromString(pid));
```

This inconsistency means sample entries are the easiest vector for ring position spoofing.

- **Impact**: Arbitrary ring position placement without ID grinding. Corrupts routing topology.
- **Remediation**: Always compute `coord = hashPeerId(peerIdFromString(s.id))` for sample entries.

#### 5.4 Weak Correlation ID Generation
**Severity: Medium**

`correlation_id` is generated as `${selfId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` (line 1206). `Math.random()` is not cryptographically secure — its output is predictable from prior values in V8 (xorshift128+ generator). An attacker observing a few correlation IDs can predict future ones.

Predictable correlation IDs enable:
- Pre-filling the dedup cache with future IDs to block legitimate requests
- Crafting collision IDs to hijack cached results

- **Preconditions**: Observation of several correlation IDs from a target.
- **Impact**: Dedup cache manipulation. Potential result hijacking.
- **Remediation**: Use `crypto.randomUUID()` or `crypto.getRandomValues()`.

#### 5.5 Serialized Routing Table Tampering
**Severity: Medium**

`exportTable`/`importTable` (`fret-service.ts:1347-1360`) produce/consume JSON with no integrity protection. If the serialized table is stored on disk or transmitted, it can be tampered with:

- Modify relevance scores to promote attacker-controlled peers
- Insert fabricated peer entries with chosen coordinates
- Modify `state` fields (though `importEntries` forces `'disconnected'`)
- Corrupt entries to cause parsing errors on import

The design doc notes "The caller decides where and how to store the JSON" but provides no integrity mechanism.

- **Preconditions**: Access to stored table file (filesystem access or MITM on transmission).
- **Impact**: Corrupted routing state on startup. Pre-positioned attacker entries.
- **Remediation**: Sign or HMAC the serialized table. Verify coordinates on import.

#### 5.6 Timestamp Replay Window
**Severity: Medium**

`validateTimestamp` (`protocols.ts:86-88`) allows ±5 minutes (300,000ms). The dedup cache TTL is only 30 seconds. This creates a 4.5-minute window where messages pass timestamp validation but are no longer in the dedup cache — enabling replay.

- **Impact**: Activity replay. Stale routing information injection.
- **Remediation**: Align dedup TTL with timestamp window, or use monotonic sequence numbers per-peer.

---

### 6. Information Leakage & Surveillance

#### 6.1 Network Topology Inference
**Severity: Medium**

Neighbor snapshots reveal complete successor/predecessor sets (up to 12 each) and sample peers with coordinates and relevance scores. An attacker querying multiple nodes can reconstruct the full ring topology, including:

- Every peer's position on the ring
- Which peers are neighbors (revealing trust relationships)
- Relevance scores (revealing usage patterns)
- Network size estimates from multiple vantage points

The `/fret/1.0.0/neighbors` protocol serves this data to any connected peer — there's no authentication requirement for who can request snapshots.

- **Preconditions**: Connections to multiple nodes.
- **Impact**: Full network map. Identification of high-value targets (high-relevance nodes). Input for planning targeted attacks.
- **Current mitigations**: Rate limiting on snapshot responses (`bucketNeighbors`). But any peer can query any other peer.

#### 6.2 Traffic Analysis via Breadcrumbs
**Severity: Medium**

`RouteAndMaybeActV1.breadcrumbs` contains the full ordered list of peer IDs visited during routing. Every forwarding node sees:

- Who originated the request (first breadcrumb)
- The full routing path so far
- The target key being looked up
- Whether activity is included (interest level)

An attacker positioned as a forwarding node can correlate requests to specific originators and target keys over time, building interest profiles.

- **Preconditions**: Position on routing paths (as relay or Sybil node).
- **Impact**: Privacy violation. Interest correlation. De-anonymization of key lookups.
- **Current mitigations**: None. Breadcrumbs are necessary for loop prevention but expose the full path.

#### 6.3 Activity Payload Interception
**Severity: Critical**

When the payload heuristic includes the `activity` payload, every forwarding hop receives the full plaintext activity data. The `activity` field is a base64url-encoded string carried in `RouteAndMaybeActV1`. There is no end-to-end encryption — the payload is readable by every intermediate peer. Critically, since `signature` is always `''`, a forwarding peer can also **modify** the payload before forwarding without detection.

In the Optimystic context, this exposes transaction contents, validator signatures, and block data to any routing intermediary. The two-phase NearAnchor pattern (digest probe, then activity resend to anchor) also makes the recipient of the payload predictable.

- **Preconditions**: Position on routing paths. Strategic positioning near popular key ranges maximizes coverage.
- **Impact**: Full confidentiality breach of activity payloads. Modification of payloads in transit. In conjunction with the originator identity leak via correlation IDs (6.2), enables complete surveillance of who is transacting what.
- **Current mitigations**: Payload heuristic delays inclusion until near-cluster, reducing the number of hops that see it. Payload size cap (128KB). Rate limiting.
- **Missing**: End-to-end encryption of payloads. Signature verification to detect tampering.

#### 6.4 Key Interest Surveillance
**Severity: Medium**

Every `RouteAndMaybeAct` message contains the target `key` in cleartext. Forwarding nodes learn which keys are being looked up. Combined with activity payload presence and the `want_k`, `min_sigs`, and `digest` fields, this reveals:

- Which keys/blocks/transactions are hot
- Which originator peers are interested in which keys (via correlation ID prefix)
- Temporal patterns of key access
- Quorum requirements and application-level parameters

- **Preconditions**: Position on routing paths.
- **Impact**: Surveillance of network activity patterns. Economic intelligence.
- **Current mitigations**: None.

#### 6.5 Metadata Injection
**Severity: Medium**

The `metadata` field (`Record<string, any>`) is set via `setMetadata`, included in snapshots, and stored in the Digitree. It is:

- Not sanitized or validated
- Not size-limited
- Propagated to all peers who receive snapshots
- Stored indefinitely in peer entries

An attacker can inject arbitrary data including oversized payloads, prototype-pollution keys (`__proto__`, `constructor`), or data designed to cause issues in higher-layer code that reads metadata.

- **Preconditions**: Ability to send announcements with metadata.
- **Impact**: Storage bloat. Potential prototype pollution if metadata is naively consumed. Cross-layer injection if metadata is rendered in UIs.
- **Current mitigations**: None.

#### 6.6 Timing Side Channels
**Severity: Low**

Ping RTT measurements reveal:
- Network topology distances
- Processing load (high RTT suggests overloaded nodes)
- Connection quality between specific peers

Stabilization cadence (300ms/1500ms) is predictable and reveals whether a node is in active or passive mode, indicating whether operations are in progress.

- **Preconditions**: Ability to send pings and measure timing.
- **Impact**: Fingerprinting. Mode inference. Load monitoring.
- **Current mitigations**: None.

---

### 7. Partition & Churn Attacks

#### 7.1 Forced Peer Removal via Leave Spoofing
**Severity: Critical**

As detailed in 3.2, spoofed leave notices remove honest peers from others' routing tables. At scale, an attacker can:

1. Send leave notices for all peers in a ring region to all their neighbors.
2. Each recipient removes the "departed" peer and warms attacker-suggested replacements.
3. The attacker's replacements fill the vacated positions.
4. Honest peers are isolated — they're still running but nobody routes to them.

This achieves a network-wide eclipse without needing to control the target's own connections.

- **Preconditions**: Knowledge of the network topology (obtainable via 6.1).
- **Impact**: Ring partitioning. Mass peer isolation. Attacker control of ring regions.
- **Current mitigations**: `bucketLeave` rate limiting. Timestamp validation. Departure debounce (2s).
- **Missing**: Verification that leave notices come from the departing peer. Liveness check before removing peers (e.g., ping the allegedly departed peer).

#### 7.2 Leave Replacement Poisoning
**Severity: High**

When `handleLeave` processes a leave notice, it merges `notice.replacements` with locally computed candidates, with **suggested replacements taking priority** ("Suggested first (departing peer vouched for them), then locally discovered", line 504-509).

An attacker sends leave notices with `replacements` pointing to Sybil nodes. Recipients trust these replacements, warm them (ping + announce), and merge their snapshots.

- **Preconditions**: Ability to send leave notices.
- **Impact**: Attacker-controlled nodes inserted as trusted replacements.
- **Current mitigations**: `sanitizeReplacements` validates peer ID format. Max 12 replacements. But no validation of replacement quality or authenticity.

#### 7.3 Join Flooding
**Severity: Medium**

Mass simultaneous joins trigger:
1. Each new node connects to bootstrap peers and requests neighbor snapshots.
2. Existing nodes process connection events, hash peer IDs, upsert entries.
3. Stabilization cycles intensify as new peers appear.
4. Announcement fanout amplifies as discoveries cascade.

A flood of 1000+ joins in a short window can overwhelm bootstrap nodes and destabilize the ring.

- **Preconditions**: Many identities, ability to connect rapidly.
- **Impact**: Bootstrap node overload. Stabilization storms. Routing instability during convergence.
- **Current mitigations**: Token bucket rate limiting. Capacity enforcement. Profile-bounded processing.

#### 7.4 Churn Amplification
**Severity: Medium**

An attacker rapidly joins and leaves with different identities:
1. Join: triggers discovery events, snapshot exchanges, announcement fanout.
2. Leave: triggers leave handling, replacement warming, re-announcement.
3. Each cycle generates 10-20+ outbound operations on affected peers.

At scale, this creates continuous stabilization pressure that degrades routing accuracy and consumes bandwidth.

- **Preconditions**: Ability to rapidly create and connect identities.
- **Impact**: Sustained network instability. Resource exhaustion on neighbors.
- **Current mitigations**: Departure debounce (2s). Rate limiting.

#### 7.5 Bootstrap Poisoning
**Severity: High**

`seedFromBootstraps` (`fret-service.ts:686-713`) trusts bootstrap peer IDs from config. If bootstrap peers are compromised or an attacker controls the bootstrap list (e.g., via DNS hijacking or config manipulation):

1. New nodes receive only attacker-curated neighbors.
2. The attacker controls the new node's initial ring view.
3. Subsequent stabilization merges only attacker-provided snapshots.

The design doc mentions "Mandatory bootstrap verification through multiple paths" but this is not implemented.

- **Preconditions**: Compromised bootstrap infrastructure.
- **Impact**: Complete control over new nodes' network view. Network-wide eclipse for all new joiners.
- **Current mitigations**: Multiple bootstrap peers can be configured (up to 8 processed). But if they're all compromised, there's no fallback.

#### 7.6 Missing Dead State Transition
**Severity: Medium**

The `PeerState` type includes `'dead'` but it is never set programmatically. The design doc specifies "Hard failure (3+ consecutive timeouts or explicit error): remove from S/P; mark as dead in Digitree" but the implementation only decays relevance via `applyFailure` (0.7 factor).

Dead peers accumulate in the store with low-but-nonzero relevance, consuming capacity slots and potentially appearing in cohort walks. They're only removed by explicit `store.remove` (leave handling) or capacity eviction.

- **Impact**: Stale entries persist. Routing may attempt to contact unreachable peers. Capacity wasted on dead entries.
- **Remediation**: Implement consecutive failure tracking and dead state transition.

#### 7.7 Byzantine Routing — Failure Detection Bypass
**Severity: High**

An attacker-controlled peer maintains connections, responds to pings, and participates in stabilization, but silently misroutes `RouteAndMaybeAct` messages. Since ping success and neighbor exchange are the only health signals, the attacker's relevance score remains high. The `linkQuality` function (`fret-service.ts:1025`) measures only success/failure ratio — a peer that responds with valid-format but wrong-content responses maintains 100% link quality.

The attacker can:
- Return `NearAnchorV1` responses pointing to more attacker peers
- Forward messages to dead-ends (exhausting TTL)
- Claim to be in-cluster and invoke the activity handler with an attacker-controlled cohort, producing fraudulent commit certificates

- **Preconditions**: Attacker controls one or more peers on routing paths.
- **Impact**: Silent routing degradation. Activity interception. Fraudulent commit certificates. Undetectable by current health metrics.
- **Current mitigations**: Breadcrumb loop detection. Correlation-ID dedup. TTL limit.
- **Missing**: Content validation of routing responses. Verification that forwarded messages made distance progress. Reputation system (`report()` is a no-op). No threshold signature verification at the routing layer.

#### 7.8 Partition Detection Manipulation
**Severity: Low**

`detectPartition` (`fret-service.ts:1163-1194`) is advisory-only and easily manipulated:
- Requires 10+ observations and 0.3+ confidence — attacker can prevent detection by keeping observations low.
- Detects >50% size drop over 30s — attacker can partition gradually to stay under threshold.
- Uses `getNetworkChurn()` which is influenced by `reportNetworkSize` — attacker can inject false observations.

- **Preconditions**: Ability to influence size estimates.
- **Impact**: Partitions go undetected. False partition alerts cause unnecessary conservative behavior.
- **Current mitigations**: Threshold-based detection with multiple signals.

---

### 8. Implementation-Specific Vulnerabilities

#### 8.1 Metadata Prototype Pollution
**Severity: Medium**

In `mergeAnnounceSnapshot` (`fret-service.ts:600-603`):
```typescript
if (snap.metadata) {
    this.store.update(from, { metadata: snap.metadata });
}
```

The `metadata` is an arbitrary `Record<string, any>` received from the network. If higher-layer code destructures or spreads this metadata without sanitization, keys like `__proto__`, `constructor`, or `toString` could cause prototype pollution.

Similarly, `PeerEntry.metadata` is spread via `{ ...cur, ...patch }` in `DigitreeStore.update` (`digitree-store.ts:93-98`).

- **Preconditions**: Ability to send announcements with crafted metadata.
- **Impact**: Prototype pollution if metadata flows to unsafe code paths.
- **Remediation**: Validate or sanitize metadata keys. Use `Object.create(null)` for metadata storage.

#### 8.2 Event Listener Accumulation
**Severity: Low**

In `start()` (`fret-service.ts:220-250`), event listeners are added for `peer:connect` and `peer:disconnect` with anonymous async functions. If `start()` is called multiple times (defensive restart), listeners accumulate without removal.

- **Impact**: Memory leak. Duplicate processing of events.
- **Current mitigations**: None. `stop()` does not remove event listeners.

#### 8.3 Unhandled Promise Rejections in Fire-and-Forget
**Severity: Low**

Several fire-and-forget patterns use `void` prefix but some async errors may not be caught:
- `void this.announceOnDeparture(id, coord)` (line 248)
- `void this.announceToNewPeers(discovered)` (line 626)
- `void this.proactiveAnnounceOnStart()` (line 674)

While these functions have try/catch internally, any uncaught rejection in nested async calls could crash the process in strict environments.

#### 8.4 `readAllBounded` Timing Sensitivity
**Severity: Low**

The 100ms idle timeout after first data (`protocols.ts:53`) is fragile:
- In high-latency networks, legitimate responses may arrive in chunks >100ms apart.
- Muxer implementations may buffer differently.
- This could cause truncated reads of legitimate messages, interpreted as protocol errors.

---

### 9. Summary: Critical Findings

| # | Finding | Severity | Category |
|---|---|---|---|
| 1 | **No message signatures implemented** | Critical | Crypto (5.1) |
| 2 | **No `from` field verification against transport identity** | Critical | Crypto (5.2) |
| 3 | **Leave notice spoofing removes honest peers** | Critical | Protocol (3.2) |
| 4 | **Activity payload interception/modification in transit** | Critical | Info Leak (6.3) |
| 5 | **Sybil flood with no identity cost** | Critical | Identity (1.1) |
| 6 | **Full eclipse via S/P set control** | Critical | Eclipse (2.1) |
| 7 | **Forced peer removal at scale** | Critical | Partition (7.1) |
| 8 | **Coordinate spoofing in sample entries** | High | Crypto (5.3) |
| 9 | **Routing table pollution via snapshots** | High | Identity (1.3) |
| 10 | **Global (not per-peer) rate limiting** | High | DoS (4.1) |
| 11 | **No rate limit on inbound announcements** | High | Protocol (3.4) |
| 12 | **Replay attacks with 9.5-minute window** | High | Protocol (3.3) |
| 13 | **Leave storm amplification** | High | DoS (4.2) |
| 14 | **Network size estimate manipulation** | High | Eclipse (2.4) |
| 15 | **Bootstrap poisoning** | High | Partition (7.5) |
| 16 | **Route hijacking** | High | Eclipse (2.2) |
| 17 | **Byzantine routing — undetectable misrouting** | High | Partition (7.7) |
| 18 | **Leave replacement poisoning** | High | Partition (7.2) |
| 19 | **ID grinding** | High | Identity (1.2) |
| 20 | **Cohort manipulation** | High | Identity (1.4) |

### 10. Recommended Remediation Priority

**Phase 1 — Immediate (blocks all trust)**
1. **Verify `from` against transport identity**: Accept full `IncomingStreamData` in all RPC handlers; reject messages where `from !== connection.remotePeer.toString()`. This single change eliminates impersonation, leave spoofing, and snapshot forgery for direct connections.
2. **Implement message signatures** using libp2p peer keys. Verify `sig`/`signature` fields on all inbound messages.
3. **Verify coordinates in sample entries**: re-hash peer IDs (`hashPeerId(peerIdFromString(s.id))`) instead of trusting provided `s.coord`. Apply to both `mergeAnnounceSnapshot` and `mergeNeighborSnapshots`.

**Phase 2 — High Priority (prevents targeted attacks)**
4. **Authenticate leave notices**: require signature from the departing peer. Before removing a peer, ping it to confirm departure.
5. **Add rate limiting to inbound announce handler** (`neighbors/announce`). Apply profile-bounded array caps (`capSucc`/`capPred`/`capSample`) matching `mergeNeighborSnapshots`.
6. **Implement per-peer rate limiting** alongside the existing global buckets. A lightweight per-peer sliding window or token bucket on inbound handlers prevents single-peer monopolization.
7. **Add dedup protection to `LeaveNoticeV1`**: either a correlation ID or per-peer+timestamp dedup cache.
8. **Strengthen correlation ID generation**: use `crypto.randomUUID()` or `crypto.getRandomValues()`.
9. **Align dedup cache TTL with timestamp validation window** (or tighten the timestamp window). Restrict future timestamps more aggressively (e.g., allow +30s, not +5min).

**Phase 3 — Medium Priority (hardens operations)**
10. Implement the dead state transition (consecutive failure tracking per design doc).
11. Add stabilization jitter to prevent thundering-herd patterns.
12. Bound all internal maps (`backoffMap`, etc.) with explicit capacity limits and periodic sweeps.
13. Sanitize metadata keys to prevent prototype pollution. Consider `Object.create(null)` for metadata storage and size limits.
14. Add diversity requirements to cohort assembly (IP range, AS number diversity).
15. Cap `handleLeave` outbound work (share tokens with outbound budgets to limit amplification factor).

**Phase 4 — Long-term (defense in depth)**
16. End-to-end encryption of activity payloads (only the target cluster can decrypt).
17. Implement proof-of-work or stake-based identity cost for Sybil resistance.
18. Add random walk discovery to resist eclipse attacks.
19. Implement alert-on-change for S/P set mutations.
20. Encrypt and sign routing table exports.
21. Evaluate path obfuscation for breadcrumb privacy (e.g., onion-style layered encryption of routing hints).
