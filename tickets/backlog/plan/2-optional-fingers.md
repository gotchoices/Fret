description: Optional long-range finger set with probabilistic refresh
dependencies: FRET core (Digitree, relevance scoring, stabilization)
----

Maintain a small set of long-range finger peers for O(log n) routing, refreshed probabilistically.

### Design

- Emergent via the existing sparsity-weighted relevance scoring — no explicit finger table needed.
- During stabilization, probabilistically probe peers at logarithmically spaced distances.
- Sparsity bonus in relevance scoring naturally retains useful long-range peers.
- Probe budget per stabilization cycle is bounded and profile-tuned.

### Considerations

- This is largely emergent from the existing "fuzzy routing intervals" design.
- The main work is ensuring stabilization probes cover the right distance bands.
- Low priority since the sparsity model already provides finger-like behavior.

See [fret.md](../docs/fret.md) — Fuzzy routing intervals, Relevance scoring and table management.
