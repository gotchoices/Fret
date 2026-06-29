----
description: The routine that's supposed to learn about already-known peers from libp2p on every maintenance tick calls a method that doesn't exist, so it silently does nothing — peers only get discovered and classified through other channels.
prereq:
files:
  - packages/fret/src/service/fret-service.ts (seedFromPeerStore ~804-838; WithPeerStore type ~51-53)
  - packages/fret/test/membership-identify.spec.ts (skipped regression test "classifies from the peerStore poll path at start")
difficulty: medium
----

# `seedFromPeerStore` enumerates peers via a non-existent `peerStore.getPeers()` — the loop is a no-op

## What's wrong

`seedFromPeerStore` (fret-service.ts ~806) reads:

```ts
const peers = (this.node as unknown as WithPeerStore).peerStore?.getPeers?.() ?? [];
```

There is **no `getPeers()` on the libp2p `PeerStore`**. `getPeers(): PeerId[]` is a
method on the libp2p **node** (it returns currently-connected peers); the peerStore's
enumerator is `all(): Promise<Peer[]>`. So `peerStore.getPeers` is `undefined`, the
optional call short-circuits to `undefined`, `?? []` yields an empty array, and the
entire per-peer loop body — upsert, `setState`, and the `classifyFromPeerStore` poll —
**never runs**. The only part of `seedFromPeerStore` that does anything with real libp2p
is the trailing self-upsert block (~823-832).

The bug is masked by a defensive typing seam: `WithPeerStore` (~51-53) declares
`peerStore?: { getPeers?: () => Array<{ id: PeerId }> }`, so the compiler accepts the
optional call and never flags that the method is absent at runtime.

Runtime confirmation (TCP + identify nodes, one connection open):

```
node.getPeers:           function  -> count 1
node.peerStore.getPeers: undefined
node.peerStore.all:      function  -> count 1
```

## Why it went unnoticed

Membership classification and peer discovery still work, because three *other* paths
cover them:

- `peer:connect` listener upserts + sets state (~324-335),
- `peer:identify` / `peer:update` listeners classify via identify (~357-378),
- the stabilization probe pass (`classifyUnknownPeers` / `reprobeForeignPeers`) pings
  unknown/foreign peers.

So the documented "opportunistic classify from the peerStore's negotiated-protocol list
on each tick" (`classifyFromPeerStore`, fret.md *Ring membership* → "Classification probe
pass" sibling) simply never fires from the seed loop. Note `classifyFromPeerStore` itself
is fine — it uses `peerStore.get(id)` (which exists). Only the *enumeration* that feeds it
is broken.

This was surfaced by the `debt-membership-identify-integration-test` review: a new test
(`membership-identify.spec.ts`, currently `it.skip`) connects two identify nodes, lets
libp2p populate A's peerStore, then starts A's FretService and asserts the poll path
classifies the peer at start (before any event listener attaches). It fails today because
the seed loop sees `[]`. **Un-skip that test as the regression guard once this is fixed.**

## Fix sketch

Enumerate with a real API and adapt the shape:

- `await this.node.peerStore.all()` → `Peer[]`, each with `.id` **and `.protocols`**
  (so classification can read protocols off the same record instead of a second
  `peerStore.get`); this includes known-but-not-connected peers, or
- `this.node.getPeers()` → `PeerId[]` of connected peers only (map to `{ id }`).

Pick per intent — `classifyFromPeerStore`'s docstring ("opportunistic classification via
the peerStore") and the bootstrap-seeding goal both point to `peerStore.all()`. Update the
`WithPeerStore` type to match the chosen API (and drop the misleading `getPeers` shape).

## Interaction with `bug-upsert-resets-peer-stats-each-tick` (read before fixing)

That sibling ticket's premise — "`seedFromPeerStore` upserts every peerStore peer every
tick, clobbering relevance/health" — is **not currently true**, precisely because this
loop is dead. Fixing *this* bug (making the loop actually enumerate every known peer each
tick) is what would **activate** that per-tick clobbering for real. Land the upsert-stats
preservation fix together with / before this, or the re-enabled loop will zero every
peer's relevance and health once per stabilization tick. Sequence accordingly.

## Severity

Reachable now (the loop executes every tick and silently no-ops), but no user-visible
breakage today because the event + probe paths compensate — so it reads as a latent
defect / dead code rather than an outage. The cost is a missed acceleration: peers that
identify has already described in the peerStore wait for an event or a probe to be
classified/seeded instead of being picked up at the next tick.
