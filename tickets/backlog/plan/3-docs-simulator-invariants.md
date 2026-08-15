description: Document simulator design, invariants, and test methodology in fret.md
dependencies: simulation harness, property-based tests
tradeoffs: Documenting the simulator before the sim-router-realism ticket fixes its known shortcuts would enshrine behavior that is about to change; low value until the simulator is trustworthy.
----

Expand docs/fret.md with:

- Simulator architecture: event scheduler, deterministic RNG, message bus, metrics collection.
- Formal invariants being tested (ring symmetry, cohort correctness, convergence bounds).
- Test methodology: property-based testing approach, fuzzing strategy, CI matrix design.
- How to run simulations locally and interpret results.
