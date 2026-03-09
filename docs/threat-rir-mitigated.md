## FRET Threat Assessment — With Right-is-Right

Companion to [threat-analysis.md](threat-analysis.md). This document re-evaluates each threat vector assuming the [Right-is-Right](../../optimystic/docs/right-is-right.md) dispute and cascading consensus mechanism is fully implemented on top of FRET. The goal is to distinguish which threats RiR addresses, which it partially mitigates, and which remain fully exposed — informing remediation priority at the FRET layer.

**RiR provides**: cascading validity disputes, deterministic dissent coordinator selection, client transaction signatures, reputation penalties with ejection, engine health monitoring, and geometric escalation cost.

**RiR assumes**: FRET can deliver messages reliably, assemble representative cohorts, and route dispute escalation to honest peers.

**Residual severity scale**: the effective severity of each threat *after* RiR is applied. Where RiR shifts severity, the original is shown for comparison.

---

### 1. Sybil & Identity Attacks

#### 1.1 Sybil Flood — Ring Region Domination
**Original: Critical | Residual: Critical**

RiR catches Sybil nodes that produce **incorrect validation results** — they lose disputes and get ejected. But Sybil nodes that validate correctly while **controlling routing and censoring selectively** never trigger a validity disagreement. RiR only fires on observable disputes; silent routing dominance produces no signal.

Additionally, Sybil nodes can participate in escalation as enlistees, diluting the "wider honest audience" that RiR depends on. If an attacker dominates a ring region, both the original cluster and the enlistee ring may be attacker-controlled.

**RiR contribution**: Attrition of misbehaving Sybils via reputation/ejection. Does not prevent Sybil accumulation or passive routing control.

#### 1.2 ID Grinding for Strategic Ring Placement
**Original: High | Residual: High**

RiR does not interact with ring coordinate computation. Ground peers with chosen positions operate below the dispute layer entirely.

#### 1.3 Routing Table Pollution via Snapshot Injection
**Original: High | Residual: High**

Snapshot injection corrupts routing state silently — no transaction validity is in play. Polluted routing tables degrade RiR's own ability to reach honest enlistees during escalation.

#### 1.4 Cohort/Coordinator Manipulation
**Original: High | Residual: High → Medium**

Partial mitigation. If an attacker-controlled cohort produces incorrect results, honest members (if any) trigger disputes. The cascading escalation to peers beyond the manipulated cluster corrects the outcome. However:

- If the attacker controls **all** cohort members (no honest dissenters), there is no disagreement to trigger RiR.
- The client's transaction signature enables direct member contact as a backup, but only if the client is honest and can reach honest peers.

**RiR contribution**: Post-hoc correction when at least one honest cohort member is present. Does not prevent cohort capture.

---

### 2. Eclipse Attacks

#### 2.1 Full Eclipse via S/P Set Control
**Original: Critical | Residual: Critical**

RiR's escalation depends on routing to reach enlistees. A fully eclipsed node's dispute messages route through the attacker, who can suppress, modify, or redirect them. The eclipsed node cannot independently discover honest enlistees.

This is the most significant dependency: **RiR's defense mechanism is routed through the same layer the attacker controls**.

#### 2.2 Route Hijacking for Specific Keys
**Original: High | Residual: High → Medium**

If a hijacking node intercepts an activity and returns a forged commit certificate, the originating peer may detect inconsistency (e.g., hash mismatch) and trigger re-lookup. If the activity reaches even one honest cluster member, validity disagreement triggers RiR.

But if the hijacker simply **drops** the request or returns plausible-looking but subtly wrong results that the requester can't immediately verify, RiR has no trigger point.

**RiR contribution**: Catches forged results when honest peers see the transaction. Does not address silent interception or censorship.

#### 2.3 Route Blackholing
**Original: Medium | Residual: Medium**

No validity disagreement occurs — messages are simply lost. RiR does not address availability attacks.

#### 2.4 Network Size Estimate Manipulation
**Original: High | Residual: High**

Operates entirely at the FRET routing layer. No application-layer validity is involved. Manipulated estimates degrade routing quality, which in turn degrades RiR's ability to reach correct enlistees.

#### 2.5 Backoff Exploitation
**Original: Medium | Residual: Medium**

Resource-level attack below the dispute layer.

---

### 3. Protocol & Message Attacks

#### 3.1 Message Forgery — Unsigned Messages
**Original: Critical | Residual: Critical**

RiR introduces **client transaction signatures**, which protect transaction authenticity at the application layer. A cluster member can verify that a transaction was actually submitted by the claimed client.

However, FRET-layer messages (snapshots, leave notices, routing messages) remain completely unsigned. Forged FRET messages can manipulate routing state, erase honest peers, and corrupt topology — none of which trigger validity disputes.

**RiR contribution**: Transaction-level authenticity only. FRET message forgery unchanged.

#### 3.2 Leave Notice Spoofing
**Original: Critical | Residual: Critical**

Spoofed leave notices operate entirely at the FRET layer. An honest peer removed from others' routing tables via a spoofed leave notice has no validity disagreement to dispute — it was simply erased from the network's view.

Worse: RiR's **ejection mechanism** propagates removal of losing peers. If the ejection propagation uses the same unauthenticated leave/removal path, an attacker could forge ejection-like signals to remove honest peers under the guise of dispute resolution.

#### 3.3 Replay Attacks with Future Timestamps
**Original: High | Residual: High**

FRET's replay window remains open. RiR's own dispute protocol (`/{prefix}/dispute/1.0.0`) adds another message type that is subject to the same FRET-layer replay issues.

Replayed `RouteAndMaybeAct` messages can trigger duplicate activity execution. Replayed dispute challenges could re-trigger escalation rounds, wasting network resources.

#### 3.4 Announcement Flooding — No Inbound Rate Limit
**Original: High | Residual: High**

Resource exhaustion attack below the dispute layer. A node overwhelmed by announcement floods cannot participate in disputes effectively.

#### 3.5 JSON Parsing Attacks
**Original: Low | Residual: Low**

Unchanged. Dispute messages add another JSON parsing surface but the risk profile is the same.

#### 3.6 Dedup Cache Poisoning
**Original: Medium | Residual: Medium**

Unchanged. Could additionally be used to bypass dedup on dispute-related routing messages.

#### 3.7 Stream Resource Exhaustion
**Original: Medium | Residual: Medium**

Unchanged. Slow-read attacks on dispute protocol streams add to the exhaustion surface.

---

### 4. Denial of Service & Resource Exhaustion

#### 4.1 Global Rate Limit Exhaustion
**Original: High | Residual: High**

Unchanged. A node whose rate limits are exhausted cannot process dispute messages either.

#### 4.2 Leave Storm Amplification
**Original: High | Residual: High**

Unchanged. RiR's ejection mechanism could amplify this — each dispute resolution that ejects peers triggers leave-like removal and replacement warming.

#### 4.3 Unbounded Map Growth
**Original: Medium | Residual: Medium**

Unchanged. Dispute state (evidence, challenges, votes) adds additional per-transaction memory pressure, though this is managed at the Optimystic layer.

#### 4.4 CPU Exhaustion via Hash Computation
**Original: Medium | Residual: Medium**

Unchanged at the FRET layer. Dispute escalation adds CPU cost (re-execution of transactions by enlistees), but this is bounded by the escalation protocol and operates at the application layer.

#### 4.5 Stabilization Amplification
**Original: Medium | Residual: Medium**

Unchanged.

#### 4.6 Forwarding Loop via Distinct Sybils
**Original: Low | Residual: Low**

Unchanged. TTL bounds still apply. Dispute escalation messages are subject to the same forwarding risks.

---

### 5. Cryptographic & Data Integrity

#### 5.1 Complete Absence of Message Signatures
**Original: Critical | Residual: Critical → High**

Marginal improvement. RiR adds client transaction signatures, so transactions themselves have authentication. Cluster members can verify that a transaction is genuine when the client contacts them directly.

But FRET protocol messages (snapshots, leave notices, routing messages) remain unsigned. The threat analysis's core finding — "any message can be forged" — still applies to all FRET-layer communication. The improvement is narrow: one message type (client transactions) gains signatures while all FRET messages remain unprotected.

**RiR contribution**: Transaction authentication. FRET message authentication gap remains the top priority.

#### 5.2 No `from` Field Verification Against Transport Identity
**Original: Critical | Residual: Critical**

Unchanged. RiR operates above the transport layer and does not modify FRET's RPC handlers. `remotePeer` is still discarded in all handlers.

#### 5.3 Coordinate Spoofing in Sample Entries
**Original: High | Residual: High**

Unchanged. Ring coordinate integrity is a FRET-layer concern with no application-layer visibility.

#### 5.4 Weak Correlation ID Generation
**Original: Medium | Residual: Medium**

Unchanged. Dispute messages use their own identifiers but FRET's `Math.random()` correlation IDs remain predictable.

#### 5.5 Serialized Routing Table Tampering
**Original: Medium | Residual: Medium**

Unchanged.

#### 5.6 Timestamp Replay Window
**Original: Medium | Residual: Medium**

Unchanged. The dedup/timestamp gap affects dispute routing messages equally.

---

### 6. Information Leakage & Surveillance

#### 6.1 Network Topology Inference
**Original: Medium | Residual: Medium**

Unchanged. Dispute escalation may reveal additional topology information — enlistee selection by ring distance exposes which peers are in which ring segments.

#### 6.2 Traffic Analysis via Breadcrumbs
**Original: Medium | Residual: Medium**

Unchanged. Dispute routing adds another observable traffic pattern (escalation messages are distinctive).

#### 6.3 Activity Payload Interception/Modification
**Original: Critical | Residual: Critical → High**

Partial mitigation. RiR provides **detection** of payload modification: if a forwarding node alters the activity payload, cluster members independently re-execute the transaction. If the tampered payload produces different results, the disagreement triggers a dispute.

However:
- **Interception** (reading payloads) is unaffected — payloads remain plaintext at every hop.
- **Modification** is only detected if it causes a validity difference. Subtle modifications that don't change validity (e.g., metadata injection, timing manipulation) go undetected.
- Client transaction signatures protect against forgery of the original transaction, but the activity payload in `RouteAndMaybeActV1` is a separate encoding that isn't covered by the client signature.

**RiR contribution**: Detects validity-altering tampering post-hoc. Does not prevent interception or subtle modification.

#### 6.4 Key Interest Surveillance
**Original: Medium | Residual: Medium**

Unchanged. Dispute escalation adds signal — observers learn which keys produce disputes, revealing contentious or high-value transactions.

#### 6.5 Metadata Injection
**Original: Medium | Residual: Medium**

Unchanged. FRET-layer concern.

#### 6.6 Timing Side Channels
**Original: Low | Residual: Low**

Unchanged. Dispute timing is an additional side channel — observers can detect dispute-mode behavior.

---

### 7. Partition & Churn Attacks

#### 7.1 Forced Peer Removal via Leave Spoofing
**Original: Critical | Residual: Critical**

Unchanged. Leave spoofing operates below the dispute layer. Additionally, RiR's ejection mechanism creates a new variant: an attacker could forge signals that mimic dispute-resolution ejections, leveraging the same unauthenticated removal path.

#### 7.2 Leave Replacement Poisoning
**Original: High | Residual: High**

Unchanged. Replacement poisoning corrupts routing state without any validity dispute.

#### 7.3 Join Flooding
**Original: Medium | Residual: Medium**

Unchanged.

#### 7.4 Churn Amplification
**Original: Medium | Residual: Medium**

Potentially worsened. RiR ejections add to churn — each dispute resolution that ejects peers triggers replacement warming, snapshot exchanges, and announcement fanout. An attacker who can provoke disputes (e.g., by submitting borderline transactions) generates additional churn.

#### 7.5 Bootstrap Poisoning
**Original: High | Residual: High**

Unchanged. A node bootstrapped into an attacker-controlled view cannot reach honest dispute participants.

#### 7.6 Missing Dead State Transition
**Original: Medium | Residual: Medium**

Unchanged. FRET implementation gap.

#### 7.7 Byzantine Routing — Failure Detection Bypass
**Original: High | Residual: High → Medium**

The strongest RiR mitigation in this category. A Byzantine router that forges commit certificates or produces incorrect validation results is caught when honest peers disagree. Cascading escalation outvotes the attacker. Reputation penalties and ejection remove the Byzantine node from future routing.

However, Byzantine routing that **silently misroutes** (drops messages, returns bogus `NearAnchorV1` hints, delays forwarding) without producing incorrect validation results remains undetectable. RiR only catches Byzantine behavior that manifests as a validity disagreement.

**RiR contribution**: Catches result-forging Byzantine behavior. Silent misrouting remains undetectable.

#### 7.8 Partition Detection Manipulation
**Original: Low | Residual: Low**

Unchanged.

---

### 8. Implementation-Specific Vulnerabilities

#### 8.1 Metadata Prototype Pollution
**Original: Medium | Residual: Medium**

Unchanged.

#### 8.2 Event Listener Accumulation
**Original: Low | Residual: Low**

Unchanged.

#### 8.3 Unhandled Promise Rejections
**Original: Low | Residual: Low**

Unchanged.

#### 8.4 `readAllBounded` Timing Sensitivity
**Original: Low | Residual: Low**

Unchanged.

---

### 9. Summary: Residual Threat Posture

#### Mitigated or reduced by RiR

| # | Finding | Original | Residual | Mechanism |
|---|---|---|---|---|
| 4 | Activity payload modification | Critical | High | Independent re-execution detects validity-altering tampering |
| 1 | No message signatures | Critical | High | Client tx signatures add one layer of authentication (narrow) |
| 17 | Byzantine routing (forged results) | High | Medium | Disputes catch incorrect validation; ejection removes bad actors |
| 20 | Cohort manipulation | High | Medium | Post-hoc correction when honest members trigger disputes |
| 16 | Route hijacking (forged certs) | High | Medium | Forged commit certificates detected via re-execution disagreement |

#### Unchanged by RiR

| # | Finding | Severity | Why RiR doesn't help |
|---|---|---|---|
| 2 | No `from` verification | Critical | FRET transport layer; RiR operates above |
| 3 | Leave notice spoofing | Critical | No validity dispute involved |
| 5 | Sybil flood | Critical | Passive routing control produces no dispute signal |
| 6 | Full eclipse | Critical | Eclipsed nodes can't reach honest dispute participants |
| 7 | Forced peer removal | Critical | FRET-layer erasure, not a validation disagreement |
| 8 | Coordinate spoofing | High | Ring topology corruption below dispute layer |
| 9 | Routing table pollution | High | Silent routing state corruption |
| 10 | Global rate limiting | High | Resource exhaustion prevents dispute participation |
| 11 | No inbound announce rate limit | High | Resource exhaustion below dispute layer |
| 12 | Replay attacks | High | FRET dedup gap; also affects dispute messages |
| 13 | Leave storm amplification | High | DoS amplification; ejections may worsen this |
| 14 | Size estimate manipulation | High | Routing-layer metric corruption |
| 15 | Bootstrap poisoning | High | Poisoned bootstrap prevents reaching honest peers |
| 18 | Leave replacement poisoning | High | Routing state corruption without validity dispute |
| 19 | ID grinding | High | Below dispute layer entirely |

#### New risks introduced by RiR

| Risk | Severity | Description |
|---|---|---|
| Dispute as DoS amplifier | Medium | Borderline or adversarial transactions provoke escalation rounds, each enlisting K additional peers for re-execution. Geometric cost falls on the network. |
| Ejection path abuse | Medium | If ejection propagation uses unauthenticated FRET removal mechanisms, attackers can forge ejection signals to remove honest peers. |
| Escalation routing subversion | High | Dispute escalation routes through FRET. An attacker controlling the routing layer can suppress, redirect, or intercept escalation messages, preventing disputes from reaching honest enlistees. |
| Dispute information leakage | Low | Escalation traffic reveals which transactions are contentious, which ring segments have disputes, and dispute outcomes — useful intelligence for targeted attacks. |

---

### 10. Adjusted Remediation Priority

RiR shifts the calculus: application-layer validation integrity is now defended, making FRET transport-layer hardening the clear bottleneck. The original remediation phases remain valid but with sharpened rationale.

**Phase 1 — Immediate (now also protects RiR's own escalation path)**
1. **Verify `from` against transport identity** — without this, dispute messages can be forged, undermining RiR itself.
2. **Implement FRET message signatures** — dispute routing must be tamper-proof for RiR escalation to be trustworthy.
3. **Verify coordinates in sample entries** — corrupted ring topology misdirects escalation enlistee selection.

**Phase 2 — High Priority (prevents attackers from disabling RiR)**
4. **Authenticate leave notices** — unauthenticated removal is now also an ejection-forgery vector.
5. **Per-peer rate limiting** — prevents single-peer DoS that would block dispute participation.
6. **Inbound announce rate limiting** — prevents resource exhaustion that degrades dispute responsiveness.
7. **Align dedup TTL with timestamp window** — dispute messages are also vulnerable to the replay gap.

**Phase 3 — Medium Priority (hardens escalation reliability)**
8. **Admission control** — dual-path: density-constrained open path for permissionless peers; application-controlled path with `AdmissionPolicy` hook (receives peer ID, credentials via metadata, connection origin with IP/relay status/multiaddr). Enables credentialed flash-join use cases (voting) while resisting open-path Sybil accumulation.
9. **Bounded gossip size consensus** — peers exchange signed size observations; weighted median resists Sybil ballot-stuffing. Enables density anomaly detection in ring regions.
10. Diversity requirements in cohort assembly — reduces probability of all-attacker cohorts that RiR can't detect.
11. Dead state transition — stale peers in enlistee selection waste escalation rounds.
12. Stabilization jitter — synchronized stabilization can interfere with time-sensitive dispute deadlines.

**Phase 4 — Long-term (defense in depth, partially addressed by RiR)**
13. End-to-end payload encryption — RiR detects tampering but not interception; encryption closes the gap.
14. Identity cost (PoW/stake) for open-path admission — RiR attrites misbehaving Sybils but doesn't prevent accumulation. Credentialed path externalizes this cost for deployments with an authority.
15. Random walk discovery — reduces eclipse probability, improving escalation reachability.

### 11. Conclusion

Right-is-Right provides a strong defense for **what happens after routing succeeds** — it ensures that cluster validation results are honest even when some peers are not. Five of the twenty top findings see meaningful severity reduction.

But fifteen of twenty remain unchanged because they target the routing, identity, and messaging layers that RiR depends on. The critical dependency is circular: RiR needs FRET to deliver dispute messages honestly, but the threat analysis shows FRET cannot currently guarantee honest delivery. Until FRET's Phase 1 remediations (transport identity verification, message signatures, coordinate verification) are in place, an attacker can subvert RiR's escalation mechanism by attacking the layer beneath it.

**Net posture**: application-layer integrity defended; transport-layer integrity remains the critical gap.
