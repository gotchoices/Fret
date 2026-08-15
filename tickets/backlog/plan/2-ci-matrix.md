description: CI matrix for simulation across parameter space
dependencies: simulation harness, churn scenarios
tradeoffs: Eighteen simulation cells is slow for continuous integration, and gating on thresholds while the simulator still routes with global knowledge it should not have (see plan/24-sim-router-realism) would lock in numbers that measure the wrong thing; a maintainer will likely want the simulator made honest before it gates anything.
----

Set up CI to run FRET simulation across a matrix of parameters and export metrics.

### Matrix

- N ∈ {5, 25, 100}
- Churn rate ∈ {0, 1, 5}% per second
- Profile ∈ {Edge, Core}

### Output

- JSON metrics artifacts per run: convergence time, coverage, path length, drop rate, routing success.
- Trend comparison against previous runs (optional, later).
- Fail CI if key metrics exceed thresholds (e.g., routing success < 95%).

See [fret.md](../docs/fret.md) — Configuration, Operating profiles.
