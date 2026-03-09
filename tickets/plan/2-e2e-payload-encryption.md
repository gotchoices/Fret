description: End-to-end encryption of activity payloads so only the target cluster can decrypt
dependencies: 5-message-signatures (signatures needed alongside encryption for full protection)
files: src/service/fret-service.ts (iterativeLookup, routeAct), src/service/payload-heuristic.ts, docs/fret.md
----

### Problem

libp2p's Noise protocol encrypts data **on the wire** between directly connected peers (link encryption). But FRET forwards activity payloads hop-by-hop: each forwarding node Noise-decrypts the inbound stream, reads the plaintext `RouteAndMaybeActV1` (including the `activity` field) in memory, then Noise-encrypts it onto a new stream to the next hop. Every intermediate node sees the full plaintext payload — Noise protects the links but not the content across multiple hops.

Since signatures are also absent, forwarding peers can both **read** and **modify** payloads without detection.

Right-is-Right detects validity-altering tampering (modified payload produces different validation results, triggering a dispute), but interception (reading) is completely unaddressed. In the Optimystic context, this exposes transaction contents, validator signatures, and block data to any routing intermediary.

The two-phase NearAnchor pattern (digest probe, then activity resend to anchor) also makes the recipient predictable, enabling targeted interception.

### Expected behavior

Activity payloads are encrypted end-to-end so only the target cluster members can decrypt them. The encryption scheme should work with the routing model — since the final cluster membership isn't known until routing converges, this likely requires either:

- Encryption to a cluster-derived key (requires cluster key agreement)
- Onion-style layered encryption toward the anchor
- Encryption to the coordinator's public key with re-encryption on NearAnchor redirect

Design exploration is needed to determine the right approach given FRET's progressive routing model.

### Threat references

- threat-analysis.md §6.3 (Critical): Activity payload interception/modification in transit
- threat-analysis.md §6.4 (Medium): Key interest surveillance
- threat-rir-mitigated.md §6.3: Reduced to High by RiR (tampering detected); interception unchanged
