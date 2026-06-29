description: Identity cost mechanism (proof-of-work, stake, or similar) for Sybil resistance
dependencies: none — design exploration ticket
files: docs/fret.md
----

### Problem

Generating libp2p identities is free. An attacker can create thousands of key pairs, compute their ring coordinates, and place Sybil nodes at any desired positions. SHA-256 is fast (~10M hashes/sec on consumer hardware), so grinding a 32-bit coordinate prefix takes seconds.

Right-is-Right attrites Sybils that produce incorrect validation results (they lose disputes and get ejected), but Sybil nodes that validate correctly while controlling routing, censoring selectively, or surveilling traffic never trigger disputes. RiR cannot prevent Sybil accumulation — only penalize Sybils that misbehave in validation.

The design doc lists "Proof-based validation failures whispered" and "Gradual trust building through successful interactions" under Sybil resistance, but no identity cost mechanism is specified or implemented.

### Relationship to dual-path admission

The `3-constrained-join-neighbor-attestation` ticket introduces two admission paths: an open path with density-based friction and a credentialed path that externalizes identity cost to an application-layer authority. The credentialed path solves Sybil resistance for deployments that have an authority (e.g., voting systems), but the open path still needs FRET-native identity cost for permissionless deployments.

This ticket covers that FRET-native mechanism for the open path — the identity cost that applies when no external credential is available.

### Expected behavior

Joining via the open admission path requires some form of scarce resource expenditure. The mechanism should:

- Make bulk identity creation expensive (orders of magnitude more costly than current)
- Be verifiable by peers without trusted third parties
- Scale reasonably across Edge/Core profiles (mobile nodes shouldn't be excluded)
- Not require a blockchain or external token system (self-contained within the protocol)
- Compose with the credentialed path — credentialed peers bypass PoW since their identity cost is already covered

Candidate approaches: hashcash-style proof-of-work at join time, periodic proof-of-work renewal, stake via application-layer deposits, progressive trust accumulation with rate limits on new identities.

This is an open design question noted in the design doc.

### Threat references

- threat-analysis.md §1.1 (Critical): Sybil flood with no identity cost
- threat-analysis.md §1.2 (High): ID grinding for strategic ring placement
- threat-rir-mitigated.md §1.1: Unchanged by RiR (passive Sybils produce no dispute signal)
