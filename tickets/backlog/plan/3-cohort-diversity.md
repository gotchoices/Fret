description: Add diversity requirements to cohort assembly (IP range, AS number diversity)
dependencies: none — design needed for what diversity signals are available in a libp2p context
files: src/service/fret-service.ts (assembleCohort ~line 850-870), src/store/digitree-store.ts
----

### Problem

`assembleCohort` performs a two-sided walk selecting peers purely by ring distance. It has no diversity requirements — if all nearby peers share the same IP range, AS number, or other network locality, the cohort is easily dominated by a single operator.

The design doc mentions "Diversity requirements in cohort selection (IP ranges, AS numbers)" under security considerations but this is not implemented.

With Right-is-Right, cohort diversity becomes even more important: if an attacker controls all cohort members, there is no honest dissenter to trigger a dispute. Diversity requirements make all-attacker cohorts harder to construct.

### Expected behavior

Cohort assembly considers diversity signals when building the cohort. If adding a candidate would violate a diversity constraint (e.g., too many peers from the same /16 IP range or AS), the candidate is skipped and the walk continues to the next peer. The specific diversity signals available depend on what libp2p exposes — at minimum, the connected multiaddr provides IP information.

This is a design-heavy ticket: the main question is what diversity signals are reliably available cross-platform (browser, Node, React Native) and how to weight them against ring-distance optimality.

### Threat references

- threat-analysis.md §1.1 (Critical): Sybil flood — diversity requirements make region domination harder
- threat-analysis.md §1.4 (High): Cohort manipulation — diversity reduces attacker cohort capture probability
- threat-rir-mitigated.md §1.4: Partially mitigated by RiR post-hoc; diversity prevents the scenario RiR can't catch (all-attacker cohort)
