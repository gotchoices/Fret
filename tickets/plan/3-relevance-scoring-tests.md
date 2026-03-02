description: Relevance scoring and eviction validation
dependencies: FRET core (relevance scoring, Digitree)
----

Verify the relevance scoring system and eviction behavior.

### Properties

- Failures and timeouts decrease relevance score (down-rank).
- Neighbors (S/P members) have effectively infinite eviction score — never evicted unless explicitly dead.
- Decay is bounded: scores don't go negative or overflow.
- Sparsity bonus correctly favors underrepresented distance bands.
- Eviction selects lowest-relevance entry when capacity exceeded.

### Approach

- Unit tests for score calculation given various input combinations.
- Property tests: score monotonicity under consistent access patterns.
- Integration: fill table to capacity, verify correct victim selection.

See [fret.md](../docs/fret.md) — Relevance score calculation, Routing store.
