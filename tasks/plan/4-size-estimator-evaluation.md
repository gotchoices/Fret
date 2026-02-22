description: Size estimator accuracy evaluation on synthetic rings
dependencies: FRET core (size estimation, Digitree)
----

Validate that the network size estimator produces accurate results across diverse topologies.

### Test scenarios

- Synthetic rings with uniform, gapped, and skewed peer distributions.
- Assert n_est within configurable tolerance of actual n.
- Verify confidence is monotonic with sample size (more samples = higher confidence).
- Edge cases: very small networks (n=1..5), very large (n=10000+), highly non-uniform distributions.

### Metrics

- Relative error |n_est - n| / n across topologies.
- Confidence calibration: does stated confidence correlate with actual accuracy?
- Convergence speed: how many samples until confidence exceeds threshold?

See [fret.md](../docs/fret.md) — Network size estimation.
