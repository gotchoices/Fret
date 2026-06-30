----
description: A maintenance routine that's supposed to learn about already-known peers from the network on every tick calls a method that doesn't exist, so it silently does nothing; fix it to enumerate peers correctly and un-skip the regression test.
prereq:
files:
  - packages/fret/src/service/fret-service.ts (seedFromPeerStore ~804-838; WithPeerStore type ~51-53; classifyFromPeerStore ~298-309; classifyByProtocols ~291-296)
  - packages/fret/test/membership-identify.spec.ts (skipped regression test "classifies from the peerStore poll path at start" ~140-177)
difficulty: medium
----

# Fix `seedFromPeerStore`: enumerate peers via `peerStore.all()`, not the non-existent `peerStore.getPeers()`

## Confirmed cause

`seedFromPeerStore` (fret-service.ts ~806) enumerates with:

```ts
const peers = (this.node as unknown as WithPeerStore).peerStore?.getPeers?.() ?? [];
```

`PeerStore` has no `getPeers()`. Confirmed against the installed libp2p interface:

- `@libp2p/interface/src/peer-store.ts:191` — `all(query?: PeerQuery): Promise<Peer[]>` is the peerStore enumerator.
- `getPeers(): PeerId[]` is a method on the libp2p **node** (connected peers), not the peerStore.
- `Peer` (peer-store.ts:35) carries `id: PeerId` (line 39) **and** `protocols: string[]` (line 50).

So `peerStore.getPeers` is `undefined`, the optional call short-circuits, `?? []` yields `[]`, and the entire per-peer loop body (upsert / `setState` / `classifyFromPeerStore`) never runs. Only the trailing self-upsert block (~823-832) does anything with real libp2p.

The bug is masked by `WithPeerStore` (~51-53), which declares `peerStore?: { getPeers?: () => Array<{ id: PeerId }> }` — so the compiler accepts the optional call against a method that is absent at runtime. Note `this.node` is already typed `Libp2p` (fret-service.ts:104), whose `peerStore.all()` / `peerStore.get()` are properly typed; the `WithPeerStore` cast (and the similar inline cast in `classifyFromPeerStore` ~301) are unnecessary defensive over-typing.

## Sequencing: sibling already landed (no clobbering risk)

`bug-upsert-resets-peer-stats-each-tick` is already committed (`0075e2a` implement, `b97f773` review). `DigitreeStore.upsert` (digitree-store.ts:83-122) now preserves all mutable stats on a hit (relevance, health counters, state, membership, metadata), refreshing only coord/lastAccess. So re-activating this loop — which makes it enumerate every known peer each tick — will **not** zero relevance/health. The interaction warning in the original ticket is resolved; proceed without a prereq.

## Fix

Enumerate with the real API and classify off the same record:

- Replace the enumeration with `const peers = await this.node.peerStore.all();` (returns known peers, including not-currently-connected ones — the right set for opportunistic seeding/classification, matching `classifyFromPeerStore`'s "opportunistic classification via the peerStore" intent and the bootstrap-seeding goal).
- Each `Peer` exposes `.id` and `.protocols`. Classify directly via the existing `classifyByProtocols(pidStr, p.protocols)` (~291-296) on a still-`unknown` entry, instead of a second `peerStore.get` round-trip through `classifyFromPeerStore`. (Keep the `membership === 'unknown'` guard so an already-classified peer is left alone.)
- Drop the `WithPeerStore` interface (~51-53). If `classifyFromPeerStore` (~298-309) becomes unused after switching to the protocol list from `all()`, remove it too; if any other caller remains, leave it but it can also drop its inline `peerStore?.get` cast since `this.node: Libp2p` already types `peerStore.get`.
- Leave the self-upsert block (~823-832), `enforceCapacity`, and `emitDiscovered(discovered)` as-is. Keep the `discovered` accumulation (push ids not already in the store).

`seedFromPeerStore` is `async` and runs inside the awaited stabilization tick and at `start()`, so the added `await` on `all()` is fine.

## Regression guard

Un-skip `it.skip('classifies from the peerStore poll path at start, before any event listener fires (no probe)')` in `membership-identify.spec.ts` (~140) — change `it.skip` to `it` and delete the `SKIPPED:` paragraph (~133-139) of the comment that explains why it was skipped. The test is already written to pass against the fixed enumeration: it populates A's peerStore via identify before A has a FretService, starts A (which awaits `seedFromPeerStore` before attaching listeners), and asserts C is classified `member` synchronously with `pingsSent === 0`.

## Validation

Run from `packages/fret/`:

- `npx tsc --noEmit` (confirms the type changes compile; `peerStore.all()` is typed on `Libp2p`).
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/membership-identify.spec.ts" --timeout 30000 2>&1 | tee /tmp/membership-identify.log` — the un-skipped test must pass alongside the two existing ones.
- `yarn test 2>&1 | tee /tmp/fret-test.log` — full suite green (stream output; don't silently redirect).

## TODO

- Replace `seedFromPeerStore`'s enumeration with `await this.node.peerStore.all()` and classify each still-`unknown` peer via `classifyByProtocols(id, peer.protocols)`.
- Remove the `WithPeerStore` interface; remove or de-cast `classifyFromPeerStore` depending on whether it still has a caller.
- Un-skip the `peerStore poll path at start` regression test and trim its `SKIPPED:` comment.
- Run typecheck + targeted spec + full `yarn test`; confirm green.
- If anything in fret.md's *Ring membership* → "peerStore protocols" / seeding description needs to match the new enumeration wording, update it (keep the design doc accurate).
