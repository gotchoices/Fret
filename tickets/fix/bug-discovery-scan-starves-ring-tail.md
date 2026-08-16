----
description: When a node knows more peers than its discovery bookkeeping can remember, roughly half of them are never announced to libp2p at all — and it is always the same half, permanently.
files: packages/fret/src/service/peer-discovery.ts (the `scan` loop and the `emitted` map), packages/fret/src/service/libp2p-fret-service.ts (the profile sizing of `maxTracked`), packages/fret/test/peer-discovery.spec.ts, docs/fret.md (libp2p integration → Discovery)
difficulty: medium
repro: verified
----

## What goes wrong

`FretPeerDiscovery` is the only path by which FRET tells libp2p that a peer exists. Every few
seconds it walks its peer table in ring-coordinate order, announces up to `batchSize` peers it has
not announced recently, and stops. "Announced recently" is remembered in a fixed-size map
(`emitted`, sized by `maxTracked`); when that map is full, adding a new entry drops the oldest one.

The walk **always restarts at the beginning of the table**. There is no cursor that remembers where
the previous tick stopped.

While the peer table is smaller than `maxTracked`, that is fine — every peer ends up remembered, so
the walk runs off the end and everyone gets announced. Once the table is *larger* than `maxTracked`,
the two mechanisms fight each other: the walk keeps re-reaching peers near the start of the table
whose entries were just evicted, re-announcing them, and evicting still more early entries to do it.
The system settles into a stable cycle that never advances far enough down the table to reach the
rest. Peers past roughly position `maxTracked + batchSize` are announced **never** — not late, not
rarely, never.

Because a peer's position in the table is its ring coordinate, and that is a stable hash of its peer
id, the starved set is fixed. The same peers are invisible for the lifetime of the node.

## Why this is reachable today, not hypothetical

The peer table's default capacity is 2048 on both operating profiles. The discovery map is sized per
profile: 4096 on Core (above the table capacity, so it never binds) and **1024 on Edge** (below it).
An Edge node in a network large enough to fill its table therefore hits this with stock settings.

The site currently carries comments asserting the opposite — that a premature eviction "costs one
extra emission of that peer, which is idempotent in libp2p's peerStore". That is the reasoning the
`maxTracked` sizing was chosen from, and it is wrong in exactly the regime the sizing creates. Those
comments have been corrected in place to point here (review pass of `map-capacity-bounds-tests`);
the decision they justified still needs revisiting, which is this ticket.

## How it was measured

- **Observed in the real code, small case.** During `map-capacity-bounds-tests`, the new spec
  `peer-discovery.spec.ts` → "debounce map caps at maxTracked and evicts…" was first written with
  5 members, `maxTracked: 3`, `batchSize: 2`. It failed with "must eventually be emitted" for the
  ring-order-last member, and kept failing regardless of how long the test ran. Raising `maxTracked`
  to 4 made it pass. That spec ships at 4 with a comment explaining why.
- **Scaled by simulation.** Transcribing the `scan` loop and `ExpiringMap`'s oldest-first eviction
  into a standalone simulation reproduces that observation exactly (5/3/2 starves one member; 5/4/2
  does not), and then predicts the shipped-Edge case: population 2048, `maxTracked` 1024,
  `batchSize` 20 reaches 1040 distinct members and stalls there permanently. Including the
  `debounceMs` lifetime (600 s, i.e. 120 ticks at the 5 s emission interval) changes nothing,
  because capacity binds at ~256 s — well before any entry can expire.
- The magnitude "roughly `maxTracked + batchSize`" is the simulation's observed plateau across
  populations of 1045, 1100 and 2048, all of which stalled at exactly 1040.

## Expected behavior

Every live member of the peer table is announced to libp2p within a bounded number of ticks, for
**any** combination of population size, `maxTracked` and `batchSize` — including populations far
larger than `maxTracked`. No peer's ring coordinate should determine whether it is ever announced.

The rate limit itself is not in question: emitting at most `batchSize` peers per tick is deliberate
and should stay. What must change is that the scan resumes where it left off rather than restarting,
so the batch limit costs *latency* (the whole table drains in `population / batchSize` ticks)
instead of costing *coverage*.

Worth deciding while here: with a cursor in place, `maxTracked` becomes a pure memory bound rather
than something that can silently affect coverage, so the Edge/Core split may want re-justifying or
collapsing.

## Verification this needs

The regression guard should be a property over the parameter space, not a single tuned case — a
single case is what let this through. Something of the form "for a population of N live members with
capacity C and batch B, every member is emitted within a bounded number of ticks", exercised across
combinations where N exceeds C. That test fails on today's code and passes with a cursor, and it
retires the whole class rather than the one instance.

The existing spec at `maxTracked: 4` should lose its explanatory comment once this lands, and can be
re-pointed at a capacity below the population to prove the fix directly.
