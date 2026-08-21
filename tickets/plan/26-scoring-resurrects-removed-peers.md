----
description: Deleting a peer from the routing table does not reliably stick — the very next piece of bookkeeping about that peer silently recreates its entry from scratch, so a peer that told us it was leaving comes straight back as an unrecognised stranger.
files: packages/fret/src/service/fret-service.ts
repro: static
severity: edge-case
likelihood: normal-use
tradeoffs: The recreated entry is harmless in isolation — it is excluded from every ring view until classified, carries no relevance, and is a preferred eviction victim — so a maintainer may reasonably judge the churn (a handful of wasted probes per graceful departure) cheaper than auditing every scoring call site for the create-on-miss behaviour it currently relies on.
----

### What happens

Three scoring helpers on `FretService` — `applyTouch`, `applySuccess`, and `applyFailure` — all
begin with the same line:

```ts
const entry = this.store.getById(id) ?? this.store.upsert(id, coord);
```

That is "score this peer, creating it if I have never heard of it". It reads as a convenience, but
it means **any** bookkeeping about a peer re-admits it to the routing table, including bookkeeping
that fires *because the peer went away*.

The clearest instance is a graceful departure:

1. The departing peer sends a leave notice; `handleLeave` calls `store.remove(from)`.
2. Its transport connection closes a moment later.
3. The `peer:disconnect` listener calls `applyFailure(id, coord)`, whose `?? upsert` recreates the
   entry — now with default values: `membership: 'unknown'`, `relevance: 0`, no health history.

So the removal in step 1 is undone by step 3, every time, and the node spends the next few
stabilization ticks classification-probing a peer it was explicitly told had left. The existing
tests already work around this: `test/churn.leave.spec.ts` comments that the departed peer "may be
re-added" and asserts on service health rather than store contents.

### Why this is filed as a class, not a single fix

The one-line fix at the `peer:disconnect` site would be to skip scoring for a peer that is not in
the store. But the same create-on-miss appears in three helpers used from a dozen call sites, and
which of those callers *wants* creation is not obvious from any of them — some genuinely do (a
snapshot merge scoring a newly-learned id), some clearly do not (anything on a teardown path). The
useful change is to make the two intents distinguishable at the seam rather than implicit in each
caller: scoring a peer should not be able to create it, and callers that want creation should say
so.

### Expected behaviour

- Recording success, failure, or access for a peer that is *not* in the routing table is a no-op,
  not an insertion.
- Call sites that legitimately learn a new peer (peerStore seeding, bootstrap seeding, snapshot and
  announce merges, inbound RPC) insert it explicitly first, as they largely already do.
- A peer removed by `handleLeave` stays removed until it is genuinely rediscovered — a fresh
  connection, an identify, an inbound RPC, or another peer's snapshot naming it.
- No change to what an *existing* entry's score does; this is only about the create-on-miss arm.

### Notes

- Not verified by running anything — read from the code path (`applyFailure` at
  `fret-service.ts:401`, the `peer:disconnect` listener at `fret-service.ts:679-694`,
  `handleLeave`'s `store.remove` at `fret-service.ts:1245`). What would confirm it: assert the
  departed peer is absent from `getStore()` after a graceful leave plus disconnect, and watch it
  fail.
- Related but distinct from `tickets/implement/4-leave-amplification-cap`, which bounds the
  outbound work a leave triggers and deliberately leaves this behaviour alone.
