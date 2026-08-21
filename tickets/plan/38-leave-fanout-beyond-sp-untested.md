----
description: When a peer shuts down it also tries to say goodbye to a few peers outside its immediate ring neighborhood. Nothing tests that step, and the one test named after it cannot actually see it happen — every test rig gives the departing peer only one reachable connection.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/churn.leave.spec.ts, packages/fret/test/helpers/libp2p.ts
difficulty: medium
tradeoffs: The untested arm is a best-effort courtesy notice — an un-notified peer still drops the departed one on its own timers — so a maintainer may reasonably rank this below coverage for paths where a bug loses state rather than costing latency.
----

### What is untested

`sendLeaveToNeighbors` has two fan-out arms. The first sends the notice to the departing node's
ring neighbors; that arm is covered. The second (`fret-service.ts:1502-1511`) reaches *past* those
neighbors:

```ts
const fanOut = this.cfg.profile === 'core' ? 4 : 2;
const expanded = this.expandCohort(ids, selfCoord, fanOut, new Set([selfStr]));
const extra = expanded.filter((id) => !spSet.has(id) && this.isConnected(id)).slice(0, fanOut);
```

No test exercises it. Every leave test in the suite leaves `extra` empty, and for the same
structural reason each time: the arm admits only peers that are **connected and outside the ring
window**, and no rig produces one.

- `Leave notice replacements (sender side)` seeds one real node; it is a ring neighbor, so it is
  already in `spSet`.
- `Leave amplification cap` tests the *receiving* half and never calls the sender.
- The deleted six-node mesh test could not reach it either — at `k: 7` all five remote peers fell
  inside the departing node's own window, so `spSet` covered every connection.

### The test named for it does not observe it

`churn.leave.spec.ts`'s `fan-out notifies peers beyond immediate S/P` uses a star topology in which
the departing node holds exactly one connection (to the hub). Its own in-file comment already
concedes this — it asserts only that the survivors kept running. The name promises coverage the
rig cannot deliver, which is worse than no test, because a grep for fan-out coverage finds it and
stops.

### Why it has stayed uncovered, and what unblocks it

The arm needs a departing node with several *dialable* connections that are not all ring
neighbors. Memory-transport nodes run no `identify`, so a peer learned through gossip has no
peerStore address and is undialable (`docs/fret.md`, *Dialability*) — which is why every existing
rig collapses to one reachable peer.

`createIdentifyNode` already exists in `test/helpers/libp2p.ts` and is what makes several
connections mutually dialable. So the missing piece is a spec, not a helper: a departing node
directly connected to more peers than its window admits, at a small `k` so the window is narrow
enough for some connections to fall outside it.

### What the spec should pin

- A connected peer outside the ring window **does** receive a notice (the arm runs at all).
- The number of such extras is capped at `fanOut` — 4 for core, 2 for edge — when more are
  eligible, so the profile bound is a clamp rather than an accident of how many peers exist.
- A ring neighbor is not notified twice; `spSet` exclusion holds.

### Related

The same rig would let `fan-out notifies peers beyond immediate S/P` assert what its name claims,
so fixing that test is part of this ticket rather than a separate one. Note that the target list
this arm's `spSet` is derived from is itself defective at the shipped default `k` — see the second
new arm on (a) in `plan/23-fret-service-decomposition`. The two interact: whichever lands second
should re-check the other's expectations, since correcting `spSet` changes which peers are
"outside the window" and therefore eligible here.
