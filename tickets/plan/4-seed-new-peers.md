description: Seed new peers with bounded snapshot samples and size/confidence
dependencies: FRET core (neighbor snapshots, size estimation, bootstrap)
----

Accelerate new peer onboarding by including routing table samples in first contact.

### Behavior

- On first contact with a new peer, include a bounded snapshot sample alongside neighbor exchange.
- Sample includes: peer IDs, ring coordinates, relevance scores, size estimate, and confidence.
- Bounded by profile caps (Edge/Core) to avoid overwhelming lightweight peers.
- Receiving peer merges sample into its Digitree, applying normal relevance/capacity rules.

### Design

- Extend the existing neighbor snapshot exchange to optionally include the `sample` field.
- Sample selection: bias toward diverse ring positions (use sparsity-aware sampling).
- Size estimate and confidence help the new peer calibrate its own estimator immediately.

See [fret.md](../docs/fret.md) — Join and bootstrap, NeighborSnapshotV1 wire format.
