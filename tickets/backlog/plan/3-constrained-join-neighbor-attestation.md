description: Dual-path admission control — density-constrained open path and credential-verified fast path
dependencies: 3-size-consensus-bounded-gossip (open path needs agreed size estimate for density checks)
files: src/service/fret-service.ts (mergeAnnounceSnapshot, mergeNeighborSnapshots, stabilizeOnce), src/store/digitree-store.ts, docs/fret.md
----

### Problem

Any peer can join the network and be accepted into neighbors' routing tables with no admission check. An attacker grinding IDs to cluster around a target ring region faces no resistance — each new Sybil is upserted into the Digitree on first contact via snapshot merges or announcements. The only constraint is the store's capacity limit (C=2048), which is global and doesn't protect individual regions.

At the same time, some use cases (e.g., voting) require massive flash joins where thousands of legitimate peers come online in minutes and need to participate in routing immediately. A single admission policy cannot serve both scenarios — rate-limiting joins to resist Sybils directly conflicts with legitimate rapid scaling.

### Approach: dual admission paths

Two paths into the FRET ring, same topology, different admission gates:

**Open path** — no external credential. Subject to FRET-layer friction:

- Density check: compute expected peers in a window around the new coordinate using the consensus size estimate (`expected = N_est * arc_length / 2^256`). Count actual peers via Digitree ordered iteration.
- If the region is over-populated, apply graduated resistance:
  - **Mild (2-3x expected)**: Accept but flag the region. Increase probing.
  - **Significant (4x+)**: Require challenge ping before insertion. Prefer evicting newer, lower-reputation entries in the dense region.
  - **Extreme (8x+)**: Reject unless direct connection verified via transport identity. Alert higher layers. Cautious mode for cohorts in that region.
- Threshold factor and window size tunable per profile.

**Application-controlled path** — application provides an `AdmissionPolicy` that receives full connection context and makes its own decisions (credential verification, IP/geo rules, relay policy, etc.). Bypasses density friction when the application approves:

- Application provides an `AdmissionPolicy` implementation:
  ```typescript
  export interface PeerOrigin {
  	ip: string | undefined;         // parsed from connection multiaddr (undefined if unavailable)
  	direct: boolean;                // false if relayed (circuit relay)
  	multiaddr: Multiaddr;           // full remoteAddr for application inspection
  }

  export interface AdmissionPolicy {
  	/**
  	 * Called when a new peer is discovered. Return:
  	 *   'admit'   — bypass density checks (credential/IP validated by app)
  	 *   'deny'    — reject regardless of density
  	 *   'default' — fall through to open-path density checks
  	 */
  	evaluate(peerId: PeerId, origin: PeerOrigin | undefined, metadata: Record<string, unknown> | undefined): Promise<'admit' | 'deny' | 'default'>;
  }
  ```
- FRET extracts `ip` from `connection.remoteAddr` and `direct` from `connection.direct`, bundles them as `PeerOrigin`, and passes them alongside `metadata` (which carries credentials via snapshot gossip). `origin` is undefined when the peer was discovered indirectly (via a third party's snapshot rather than a direct connection).
- If no policy is configured, all peers take the open path — FRET works the same as today.
- Ring coordinates remain `SHA-256(peerId)` for both paths. The policy affects only the admission gate, not the topology.
- The application owns all policy decisions — credential verification, IP range rules, relay restrictions, geo-fencing — FRET just passes the information through.

**Credential transport**: The credential travels in the `metadata` field already present in snapshots and peer entries. Peers gossip it naturally through existing snapshot exchanges. No wire format changes needed.

### Expected behavior

**Open-path peers** in over-populated regions experience graduated friction. Honest early-arriving peers are protected. Sybils face increasing difficulty as density grows.

**Application-admitted peers** join and participate in routing immediately regardless of regional density. The application controls what constitutes valid admission — credentials, IP provenance, relay policy, or any combination. In a voting scenario: the voter's phone registers with the voting authority, gets a signed `(publicKey, electionId, registrationProof)`, joins the ring, the application policy verifies the credential and checks that the connection is from a residential IP range (not a hosting provider), and the peer is admitted immediately.

**Mixed networks** work naturally. Application-admitted and open-path peers coexist on the same ring. Density detection only gates open-path admissions (peers where the policy returns `'default'`), so legitimate flash joins don't trigger false alarms.

**Indirect discovery** (peers learned from third-party snapshots rather than direct connections) has no `PeerOrigin` since there's no connection to inspect. The policy can choose how to handle this — return `'default'` to use density checks, or `'admit'` if the metadata credential alone is sufficient.

### Interaction with existing mechanisms

- **Relevance scoring**: The sparsity bonus `S(x)` already depresses scores in over-represented distance bands. The open path adds an explicit density check at insertion time rather than relying solely on eventual eviction.
- **Capacity eviction**: When over capacity, prefer evicting from dense regions (peers with low `S(x)` bonus) over sparse regions. Partially in place via relevance-based eviction but could be made region-aware.
- **S/P protection**: Neighbors in S/P sets remain protected from eviction regardless of regional density or admission path.
- **Metadata field**: Already defined as `Record<string, any>` in peer entries and snapshots. Credentials are stored and propagated via this mechanism.

### Threat references

- threat-analysis.md §1.1 (Critical): Sybil flood — open path adds density friction; credentialed path externalizes identity cost
- threat-analysis.md §1.2 (High): ID grinding — open-path ground IDs face density resistance; credentialed IDs can't be ground
- threat-analysis.md §1.3 (High): Routing table pollution — density check at insertion time for open path
- threat-rir-mitigated.md §1.1: Unchanged by RiR; dual admission addresses the gap RiR can't reach
