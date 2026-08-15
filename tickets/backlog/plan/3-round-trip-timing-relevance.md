description: Incorporate round-trip timing into peer relevance scoring
dependencies: FRET core (peer cache, relevance scoring)
tradeoffs: Biasing relevance toward low-latency peers pulls the routing table toward topologically near ones, working directly against the sparsity model whose purpose is a distance-balanced spine; it also depends on latency measurements that are known to be wrong today (see fix/13-zero-latency-health-skew), which must land first for any timing input to be trustworthy.
----

Add RTT measurement into the peer cache and use it to bias toward "nearer" (lower latency) peers.

### Design

- Record round-trip times on each successful RPC exchange.
- Incrementally maintain a distribution of RTT values (e.g., EMA mean and variance).
- Score peers relative to the population: a Gaussian z-score or percentile rank gives a relative "nearness" bonus.
- Integrate into the existing relevance score as an additional weighted component alongside recency, frequency, health, and sparsity.

### Considerations

- Avoid over-penalizing peers with occasional high latency (use EMA smoothing).
- RTT distribution should be maintained cheaply — no full histogram needed.
- Weight should be tunable per profile (Edge may care more about latency).

See [fret.md](../docs/fret.md) — Relevance score calculation, Relevance scoring and table management.
