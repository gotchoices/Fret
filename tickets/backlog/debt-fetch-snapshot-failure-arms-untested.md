description: When we ask a peer for its neighbour list and the request fails, the code reacts differently depending on how it failed — but only one of those reactions is covered by a test, so the rest could break silently.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/dead-state.spec.ts
difficulty: easy
tradeoffs: These reactions are only bookkeeping — nothing a user sees breaks if one is wrong — and the code is short and readable, so a maintainer may reasonably decide reading it is cheaper than writing seven tests for it.

When this node asks a peer for its neighbour list, the request can end seven different ways:
it succeeded, we cancelled it ourselves, there was no connection to try, the peer said it was too
busy, the peer answered with something we could not read, the peer turned out to belong to a
different network, we could not reach it at all, or it never answered in time.

The code deliberately reacts differently to each, because each says something different about the
peer. Some of them count a strike against the peer, some lower its score, some record that it is
alive after all, and some deliberately do nothing — reacting to our own cancellation as if the peer
had misbehaved is precisely the mistake the distinctions exist to prevent.

Only the success case is directly tested.

## Where this is

`packages/fret/src/service/fret-service.ts`, `fetchAndMergeSnapshot` — the block that decides what
to do with the result before any merging happens.

## What is and is not covered today

- **Covered.** The success case, thoroughly: `packages/fret/test/rpc.handler-fuzz.spec.ts` drives a
  real reply through this method and checks exactly which peers get stored. Cancellation and
  "nothing was attempted" are covered indirectly by `packages/fret/test/dead-state.spec.ts`, which
  asserts the broader rule that our own cancellation never counts against a peer.
- **Not covered.** The remaining arms — most notably the one for a peer that answers with something
  unreadable. That case is meant to record the peer as alive (it did answer us, on a protocol only
  this network's peers speak) while lowering its score and *not* counting a strike against it. If
  that arm were changed to count a strike, nothing would fail.

## Why it is worth closing

The rule these arms implement is written down and argued for at length in `docs/fret.md` — under
"Evidence strength" and "Our own cancellation is not evidence about the peer" — and it is subtle
enough that it has been got wrong before. A rule that is documented but not tested is a rule that
drifts.

The useful shape is probably one test per outcome rather than seven separate ones: drive the method
against a stubbed result of each kind and assert the peer's resulting bookkeeping. The existing
fetch-path test already builds most of the scaffolding needed (a stub reply and a stubbed
connection), so the incremental cost is small.

## Expected behaviour after the change

Each of the ways a neighbour-list request can fail has a test showing which bookkeeping it does and,
just as importantly, which it does not — in particular that our own cancellation and a missing
connection score nothing at all, and that a peer answering badly is still treated as alive.
