----
description: One unresponsive neighbour can eat the entire time budget of the background maintenance cycle, so the part of that cycle that re-checks written-off peers never gets a turn — and if the neighbour stays that way, it never gets a turn again.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/protocols.ts, packages/fret/test/stabilize-concurrency.spec.ts
difficulty: medium
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: The starving peer has to be alive enough to answer a cheap ping but stalled on the larger request, which is a narrow window; a maintainer may reasonably say the next tick picks the work up and leave the arithmetic alone.
----

## What is wrong

The background maintenance cycle (`stabilizeOnce`) now runs in two phases under one overall
5-second time limit:

1. contact the ≤ 4 nearest neighbours — a small liveness ping, then a larger request for that
   neighbour's own view of the ring;
2. contact the peers the ring currently excludes — unclassified peers, peers believed to belong to
   another network, and peers written off as gone.

Phase 2 starts only after phase 1 has finished. But a *single* phase-1 neighbour can take longer
than the whole cycle's limit: its ping is allowed 2 seconds and its follow-up request 5 seconds,
so 7 seconds against a 5-second cap. When that happens the limit expires inside phase 1 and phase
2 is skipped entirely.

That is tolerable once — the next cycle re-derives its candidates. It stops being tolerable when
the cause persists. A peer holding an open connection that answers the cheap ping but stalls the
larger request never accumulates the failures that would write it off, so it stays a nearest
neighbour and repeats the same stall on every cycle. Phase 2 is then starved indefinitely, which
matters because phase 2 is the *only* path by which a peer written off as gone is ever contacted
again, and the only path by which a newly-heard-of peer is classified.

## Why this is worth a ticket rather than a note

The old serial cycle had the same per-request limits but no overall cap, so phase 2 always ran —
very late, but it ran. Introducing the cap without checking it against the worst-case cost of one
phase-1 unit turned "late" into "never" for this case.

## Root cause, one sentence

There is no rule tying the cycle's overall time limit to the worst-case cost of one unit of work
inside it, and the second phase is gated on the first completing.

## The invariant worth having

*The sum of the per-request time limits inside one pooled unit of work must be strictly less than
the cycle's overall limit.* That is checkable — as a test over the constants, or as an assertion
where they are declared — and it retires the whole class rather than this one instance. Whoever
picks this up should decide *which* number moves, and say why:

- shrink the neighbour-snapshot request's limit for this caller (today it deliberately takes the
  larger, route-sized default because a snapshot is a real payload, not a ~50-byte ping);
- raise the cycle limit above the worst case (interacts with the note already recorded at that
  constant about active mode ticking every 300 ms);
- remove the barrier so the two phases share one pool and phase 2 cannot be starved by a phase-1
  straggler (costs one cycle of latency in classifying peers first heard of in *this* cycle's
  snapshots, which is why the phases are ordered today).

A cheap partial mitigation, worth considering alongside: skip the snapshot request for a
neighbour whose ping did not answer. It removes the common instance (an unreachable neighbour
still costing a 5-second request) but not the stalled-answerer one.

## How to confirm

`packages/fret/test/stabilize-concurrency.spec.ts` already has the harness: it gives every peer a
stub connection whose stream either answers or hangs, per protocol. A case where the near peer
answers the ping and hangs the snapshot request, with the real 5-second limits in place, should
show phase-2 peers never contacted — repeatedly, across successive cycles.
