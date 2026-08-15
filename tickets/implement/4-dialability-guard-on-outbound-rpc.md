----
description: The check for "do we know how to reach this peer?" calls a libp2p method that does not exist, so it always answers no — which silently switched off one whole announce path and narrowed several maintenance passes. Meanwhile a handful of other paths never ask the question at all and dial peers that cannot possibly be reached.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/maybe-act.ts, docs/fret.md
difficulty: medium
repro: verified
----

Every FRET outbound RPC funnels through `openRpcStream` (`packages/fret/src/rpc/protocols.ts:217-232`): reuse an open connection if one exists, else `node.dialProtocol(pid, ...)` with a **bare peer id** (`:231`). FRET never learns or stores multiaddrs — its wire messages carry peer-id strings only — so that dial only succeeds if libp2p's own peerStore happens to hold an address for the peer. For a peer known only through FRET gossip it never does, and the dial throws `NoValidAddressesError`.

The service has one helper meant to answer "can we reach this peer without a connection?" — `FretService.hasAddresses(id)` (`fret-service.ts:682-690`). It is broken, and separately several dial sites never consult it. Both arms resolve at that helper and its call sites, so they are one ticket.

### Arm 1 — `hasAddresses()` is unconditionally `false` (root cause)

```ts
private hasAddresses(id: string): boolean {
    try {
        // libp2p >=2 exposes getMultiaddrsForPeer
        const addrs = (this.node as any).getMultiaddrsForPeer?.(peerIdFromString(id)) ?? [];
        return Array.isArray(addrs) && addrs.length > 0;
    } catch {
        return false;
    }
}
```

`getMultiaddrsForPeer` **does not exist on libp2p v3's `Libp2p` interface**, and does not appear anywhere in the installed dependency tree:

```
$ grep -rl "getMultiaddrsForPeer" node_modules packages/fret/node_modules
(no matches)
```

`@libp2p/interface@3` exposes `getMultiaddrs()` (this node's *own* listen addresses), `getConnections()`, and `peerStore`. There is no per-peer address accessor on `Libp2p` — a peer's known addresses live at `peerStore.get(peerId).addresses`. The optional-call `?.` means the missing method is not an error; it yields `undefined`, the `?? []` turns it into an empty array, and the helper returns `false` for **every** peer, always.

Verified by a throwaway spec (written, run green, then deleted — the permanent version belongs in this ticket's test task):

- `(node as any).getMultiaddrsForPeer` is `undefined` on a `createMemNode()` node.
- After `peerStore.merge(b.peerId, { multiaddrs: b.getMultiaddrs() })`, `peerStore.get(b.peerId).addresses.length > 0` while `hasAddresses(b.peerId.toString())` still returns `false`.

This is not "silent behavior change keyed on host capability" as originally filed — it is broken for every host. Consequences at each of the six call sites:

| Site | Expression | Effective behavior today |
|---|---|---|
| `announceToNewPeers` (`:931`) | `!isConnected && hasAddresses` | **always empty — the whole method is a no-op** |
| `announceNeighborsBounded` (`:724`) | `nonConnected` list | always empty; "prefer non-connected targets" is dead, announce is connected-only |
| `announceOnDeparture` (`:910`) | `nonConnected` list | same — connected-only |
| `stabilizeOnce` near-peer filter (`:1128`) | `isConnected \|\| hasAddresses` | connected-only |
| `preconnectNeighbors` (`:741`) / active preconnect (`:767`) | `isConnected \|\| hasAddresses` | connected-only |
| `classifyUnknownPeers` (`:1189`) / `reprobeForeignPeers` (`:1227`) | `reachable` list | always empty; an unconnected `unknown` peer whose address *is* in the peerStore is never classified |

The last row matters most for correctness: `docs/fret.md` states the classification probe pass "prefers connected / has-addresses ones". It cannot reach a has-addresses peer at all, so a same-network peer that is in the peerStore but not currently connected stays `unknown` — and `unknown` is excluded from every ring view.

**Fix direction.** The authoritative source is `peerStore`, but `peerStore.get` is `async` while `hasAddresses` is called from seven *synchronous* `.filter()` callbacks. Making it async would ripple through all of them. Recommended: keep a service-local `Set<string>` of address-known peer ids, rebuilt from the poll that already enumerates the peerStore — `seedFromPeerStore` (`:1026-1066`) iterates `peerStore.all()` every stabilization tick and already holds each `Peer` object, whose `.addresses` array is exactly the datum needed. Rebuilding the set wholesale each tick keeps it bounded by peerStore size and self-pruning, with no store-schema change. Opportunistically refresh it in the `peer:identify` / `peer:update` handlers (`:479-500`) so a newly-learned address is usable before the next tick. Weigh against the alternative of an `addressCount` field on `PeerEntry` — that survives eviction semantics for free but touches the store, which is deliberately network-agnostic.

Whatever the mechanism, `hasAddresses` must be honest: a peer with peerStore addresses reads `true`.

**Expect a traffic increase, deliberately.** Fixing the helper *re-enables* dial attempts at the five sites above that have been quietly connected-only. That is the documented intent, but it is a behavior change landing alongside the guard work — cover it in tests rather than letting it surface in the field.

**This does not improve connectivity by itself.** A relay-only peer's `/p2p-circuit` address reaches our peerStore only if we learned it directly (identify over a direct connection, or a bootstrap entry). Fixing `hasAddresses` makes the *skip decision* correct; making more peers dialable is `backlog/feat-address-hints-in-neighbor-exchange`.

### Arm 2 — dial sites that never ask

These reach `openRpcStream` with no `requireExisting` and no reachability filter, so each dials a bare peer id:

- **`handleLeave` warm loop (`:863-865`)** — `sendPing` to the departing peer's suggested replacements, ids taken straight off the wire. Near-guaranteed addressless. (The announce two lines later at `:868` is already safe: `announceNeighbors` passes `requireExisting: true`.) Note `tickets/plan/4-leave-amplification-cap` redesigns this same loop to bound its fan-out; the guard belongs inside whatever loop that work leaves behind, and the two are compatible.
- **`sendLeaveToNeighbors` S/P loop (`:807-808`)** — `sendLeave` dials unconditionally. Runs during `stop()`, so a stack of failed dials also delays shutdown. The fan-out arm three lines down (`:813`) is already `isConnected`-filtered; the primary loop is not.
- **`routeAct` forward (`:1478-1491`)** — `chooseNextHop` takes `isConnected` as a *scoring* input only (`:1480`), never a hard filter, then `sendMaybeAct(next, ...)` dials.
- **`iterativeLookup` probe (`:1751-1778`)** — same selector, same dial.
- **`iterativeLookup` anchor send (`:1796-1808`)** — `anchor.anchors[0]` is a remote-supplied id sent to `sendMaybeAct` with no local check at all.

The sites the original fix ticket listed as unguarded preconnect loops are already guarded (`:741`, `:767`) — that part of the filing is stale. Their guard is nonetheless dead until Arm 1 lands.

**Skipping is right for maintenance, wrong for routing.** For the leave/warm paths, skipping an unreachable peer is the whole point. For `routeAct` and `iterativeLookup`, skipping the chosen hop dead-ends a route that may still have usable hops behind it. Apply dialability as a **hard filter on the candidate list before `chooseNextHop`**, not as a post-hoc skip of the winner: the selector then picks the best *reachable* hop, and only genuinely-empty candidate sets fall through to the existing `NearAnchor` / `exhausted` paths. This mirrors the rule already stated in `docs/fret.md` for cohort exclusions — filter into the walk, never out of the result.

`{ requireExisting: true }` (already used by `neighbors.ts:75` and `:105`) is the existing mechanism for "connection-only, never dial". It is the right tool where the answer is a flat "don't dial"; where a dial *is* wanted for a peer we have an address for, the gate is the fixed `hasAddresses`.

### Architecture note (not this ticket)

The durable fix for the class is that no call site should have to remember the dial policy — every FRET RPC already passes through one seam (`openRpcStream`), and the policy belongs there or in a thin service-level send wrapper. `tickets/plan/8-rpc-shared-helper` is that consolidation; an arm has been appended to it. This ticket lands the correct behavior at the existing sites so the bug is fixed now rather than waiting on a large refactor.

## TODO

### Phase 1 — make `hasAddresses` honest

- Replace the `getMultiaddrsForPeer` probe in `FretService.hasAddresses` (`fret-service.ts:682-690`) with a real peerStore-backed answer.
- Maintain the address-known set from `seedFromPeerStore` (`:1026-1066`), which already walks `peerStore.all()` and holds each `Peer.addresses`; rebuild wholesale per tick so it stays bounded and prunes itself.
- Refresh opportunistically from the `peer:identify` and `peer:update` handlers (`:479-500`) so a freshly-learned address does not wait a full tick.
- Do not swallow an unexpected failure silently — if the peerStore read throws for a reason other than "peer not found", log it once.
- Add a spec asserting `hasAddresses` is `true` for a peer whose addresses are in the peerStore and `false` for one that is absent. Assert against the helper's contract, not against libp2p internals.
- Add a spec for `announceToNewPeers` actually sending to an address-known, non-connected peer — the regression test for the path this bug switched off entirely.

### Phase 2 — guard the unguarded dial sites

- `handleLeave` warm loop (`:863-865`): skip peers that are neither connected nor address-known before `sendPing`.
- `sendLeaveToNeighbors` primary S/P loop (`:807-808`): same guard; keep the existing `isConnected` filter on the fan-out arm.
- `routeAct` (`:1474-1481`): apply dialability as a hard filter on `candidates` before `chooseNextHop`, so an unreachable peer is never selected; fall through to the existing `buildNearAnchor` when nothing remains.
- `iterativeLookup` (`:1740-1754`): same hard filter on `candidates`; keep the existing `exhausted` yield as the empty-set outcome.
- `iterativeLookup` anchor send (`:1796`): check the remote-supplied anchor id is connected or address-known before `sendMaybeAct`; fall through to the existing `bestAnchors` update when it is not.
- Confirm `routeAct`'s membership-signal handling still behaves: a hop skipped for unreachability must **not** count as a negotiate-failure strike (`:1505`) — an unreachable peer is not evidence of a foreign one.

### Phase 3 — tests and docs

- Spec: driving `handleLeave` with a replacement peer id that has neither a connection nor peerStore addresses issues **zero** `dialProtocol` calls. (Instrumenting `node.dialProtocol` and counting is sufficient — that is how the repro was verified.)
- Spec: `iterativeLookup` with an addressless anchor in the `NearAnchor` reply does not dial it and still progresses or yields `exhausted`.
- Spec: routing still forwards when *some* candidates are unreachable and at least one is not — the hard filter must not dead-end a viable route.
- Update `docs/fret.md`: the classification-probe paragraph in *Ring membership* says the pass "prefers connected / has-addresses ones"; state plainly that "has addresses" means the peerStore holds a multiaddr for the peer, and note that FRET's own wire format contributes none.
- Run `npx tsc --noEmit` and `yarn test` from `packages/fret/`.
