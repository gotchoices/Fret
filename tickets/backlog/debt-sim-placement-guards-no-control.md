description: Three simulation tests claim to prove that different peer-layout strategies produce different ring shapes, but two of them would pass just as happily against the default layout, so they prove nothing; give them the same both-directions check a sibling test already uses.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/churn-scenarios.spec.ts, packages/fret/test/simulation/fret-sim.ts
difficulty: easy
tradeoffs: These are simulation-harness tests, not production code — a maintainer could reasonably say a weak assertion on a test-only simulator is cheap to leave alone, and rewriting them costs suite time (each case has to run twice, once per layout).
---

The simulation harness (`test/simulation/fret-sim.ts`) can hand out ring coordinates several
ways — evenly spread (`uniform`), bunched around a few centres (`clustered`), lopsided
(`skewed`). `test/message-bus.spec.ts` has a `Placement distributions` block whose job is to
show each of these actually produces the shape it claims.

Two of the three assertions there have **no separating power**: they pass identically when the
layout under test is swapped for the default even spread, so they cannot fail for the reason
they exist.

## The class, and the fix that retires it

This is the same defect as `sim-placement-test-vacuous` (now complete): a statistic was asserted
against a threshold that was never checked against a *control*, so nobody noticed the statistic
did not move when the thing it measured changed.

That ticket's fix is the general answer and is already in the tree —
`assertPlacementSeparates` in `test/churn-scenarios.spec.ts` runs each scenario twice, once
under the layout being defended and once under a deliberately-wrong one, and asserts **both**
directions: the good layout reads under threshold, the wrong one reads over it. The threshold
therefore re-proves its own separating power on every run instead of only at authoring time.

Apply that shape to the `Placement distributions` block. Prefer lifting the helper somewhere
both spec files can use it over copying it — two copies of this pattern is how the pair drifts.

## The instances

**`clustered placement: peers cluster around centers`** asserts `largestGap > medianGap`. For
any set of three or more coordinates that are not perfectly evenly spaced, the largest gap
exceeds the median gap — that is arithmetic, not evidence of clustering. An evenly-spread ring
passes it. A statistic that can distinguish the two is the one the sibling ticket landed
(most peers falling inside one even-spacing-wide arc), or an inter-centre-gap ratio.

**`clustered placement: inter-cluster routing takes more hops`** is worse: the name promises a
hop-count comparison between clustered and unclustered layouts, and the test does neither. It
builds a simulation with **no `placement` set at all** — so it runs the default even spread,
despite the local variable being called `clusterSim` — and its only assertion is that
`routingAttempts === 10`, i.e. that the ten routes it scheduled were attempted. It never reads
a hop count. Either make it the comparison its name describes (two runs, clustered vs uniform,
assert clustered is higher) or rename it to what it actually checks.

**`skewed placement: some regions are denser than others`** is the one that is already fine, and
is worth reading first — its comment explicitly reasons about why the weaker assertion it
rejected would also pass for a uniform layout. Leave it, or fold it into the shared helper for
consistency.

## Expected outcome

Each case in the block fails when the layout it defends is broken, and is shown to fail — the
control arm proves it — rather than being taken on trust.
