----
description: A peer we have successfully talked to hundreds of times can be ranked below a peer we have never contacted but that other peers keep mentioning, so the routing table can drop a proven-good peer and keep a rumoured one.
files: packages/fret/src/store/relevance.ts, packages/fret/src/service/fret-service.ts
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: The two components arguably measure different things on purpose — "how often we routed through this peer" versus "did the last call work" — and the peer being over-credited is one that real peers keep naming, which is weak but genuine evidence of usefulness; a maintainer may reasonably decide the ranking is good enough and that changing it risks re-tuning every weight in the model.
----

### What the score is built from

Each routing-table entry carries a relevance score. It is the product of a sparsity bonus (a
ring-position term, not at issue here) and a base made of three parts, per
`docs/fret.md` — "Relevance score calculation":

- **recency** — how long ago we last did anything with this peer,
- **frequency** — how many times we have accessed it, log-slowed so it saturates,
- **health** — its success/failure ratio and measured latency.

Three functions write that score: `touch` (we accessed the peer), `recordSuccess` (an RPC to it
completed), and `recordFailure` (an RPC to it failed).

### The problem

The **frequency** part is fed by a counter that only `touch` increments. `recordSuccess` and
`recordFailure` leave it alone. And the **health** part is a *ratio*, so it saturates on the
first success — the second success and the five-hundredth add nothing.

Put together, a completed round trip to a peer earns that peer no lasting credit at all, while
being *named* by somebody else's neighbour snapshot does, every time, because the snapshot-merge
path calls `touch`.

Measured directly against the scoring functions, at a fixed clock and a fixed ring position so
only the counters differ:

| entry | relevance |
|---|---|
| 1 successful RPC recorded | 1.4292 |
| 500 successful RPCs recorded | 1.4292 |
| named in 500 snapshots, never contacted | 1.6968 |

Repeating `recordSuccess` ten times on the same entry produces the identical value 1.4220 every
time — the score is flat in success count, not rising.

### Why it matters

The score is what picks the victim when the routing table is full: the lowest-scoring
unprotected entry is dropped. So under the numbers above, a peer we have proven reachable
hundreds of times is a *preferred* eviction victim relative to a peer we have never reached but
that gossip keeps mentioning. The same score also biases next-hop preference.

It is not a crash or a corruption — the table stays valid and the mis-ranked peer is
rediscoverable — but it inverts the ranking exactly where the ranking is supposed to reward
proven-good peers.

### What "fixed" would look like (not designed here)

Some combination of: a completed RPC counting as an access for the frequency term; a health
term that distinguishes 1 success from 500 rather than saturating; or an explicit decision that
frequency means "routing use" only, in which case the snapshot-merge path should stop feeding
it. Which of those is right depends on what the weights are meant to express, which is why this
is filed as a specification question rather than a patch.

### How this was found

Measured by running the exported functions from `packages/fret/src/store/relevance.ts` directly
under `node --import ./register.mjs` — the numbers above are that run's output, at a pinned
clock so the recency term is constant. Not observed end-to-end through a live service; what
would confirm the user-visible half is an eviction test where a heavily-used peer loses its slot
to a never-contacted one.

`implement/3-relevance-scoring-tests` deliberately does **not** assert a direction on either
behaviour and leaves a `NOTE:` at `recordSuccess` pointing here, so the tests it adds do not
have to be rewritten whichever way this is decided.
