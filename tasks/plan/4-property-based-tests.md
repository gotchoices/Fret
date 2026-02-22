description: Property-based tests (fast-check) for FRET invariants
dependencies: FRET core (Digitree, cohort assembly, ring arithmetic)
----

Use fast-check to verify core FRET invariants hold across randomized inputs.

### Properties to verify

- **Ring invariants**: symmetric m predecessors/successors, correct wrap-around at ring boundaries, no duplicates in S/P sets.
- **Cohort assembly**: two-sided alternation correctness (alternates succ/pred), monotonic expansion (adding wants never shrinks cohort), deterministic ordering given same inputs.
- **Anchor selection**: connected-first preference within tolerance; behavior depends on size estimate and confidence level.

### Approach

- Generators for ring coordinates (256-bit), peer sets of varying sizes, and routing table states.
- Shrinking should produce minimal failing cases for debugging.
- Cover edge cases: n < k, n = 1, wrap-around at 0/2^B boundary, all peers equidistant.

See [fret.md](../docs/fret.md) — Cohort assembly algorithm, Identifier space, Configuration.
