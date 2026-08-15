----
description: A peer that genuinely belongs to this network can be wrongly labelled an outsider — by one failed connection handshake or by an out-of-date notification — and is then shut out of routing and peer discovery until a slow retry rescues it. Make weak, stale evidence unable to override strong, recent evidence.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/store/digitree-store.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/test/ring-membership.spec.ts, packages/fret/test/membership-identify.spec.ts, docs/fret.md
difficulty: medium
repro: verified
----

Both arms of the source `fix/` ticket were reproduced with a throwaway spec (written, run, deleted —
its content is reproduced under *Tests to add* below so it lands as permanent coverage). A third,
closely-related arm was found while researching and is folded in: it resolves at the same site and
under the same invariant.

## Reproduction evidence

Run against `packages/fret` at HEAD, two-node harnesses from `test/helpers/libp2p.ts`:

| Arm | Setup | Observed |
|---|---|---|
| 2 — stale identify demotes a confirmed member | Two `createIdentifyNode()` peers, both `networkName: 'net-a'`; wait until A labels C `member`; stub out A's `stabilizeOnce` so nothing can re-promote; dispatch a `peer:update` on A carrying C's *pre-registration* protocol list (`['/ipfs/id/1.0.0','/ipfs/ping/1.0.0']`) | `membership` flipped `member → foreign` |
| 1 — one negotiate failure demotes a confirmed member | Two `createMemNode()` peers, both `net-a`; wait until A labels C `member`; `await svcC.stop()` (which unhandles all five protocols) | A's next ping threw `UnsupportedProtocolError`; `membership` flipped `member → foreign` within one tick |

In the arm-1 run the two-peer case then *recovered* in ~36 ms once `svcC.start()` re-registered, so
recovery latency is not the defect — the wrong label is. The recovery path is what degrades at scale;
see *Why recovery is not enough* below.

## The invariant

**Membership evidence has a strength ordering, and a weaker or staler signal never overrides a
stronger, more recent one.**

| Signal | Strength | What it actually proves | May set |
|---|---|---|---|
| Completed outbound namespaced RPC (ping / maybeAct over `/optimystic/<net>/fret/1.0.0/...`) | strong | The remote served this network's protocol just now | `member` |
| **Inbound** namespaced RPC from a transport-authenticated sender | strong | The remote dialed this network's protocol just now | `member` |
| `identify` protocol list containing one of ours | strong (positive only) | The remote advertised our protocol as of capture time | `member` |
| `identify` protocol list containing none of ours | weak | What the remote advertised *at capture time* — may predate our own handler registration | `foreign`, only from `unknown` |
| One "could not negotiate" failure | weak | The remote had no answerable handler *at that instant* | nothing on its own |
| N consecutive "could not negotiate" failures | strong | The remote persistently does not serve this network | `foreign` |

Restated as the property to hold: **`member` is only ever set by positive proof, and only ever
cleared by repeated direct proof of absence.** Promotion on strong evidence always applies;
demotion requires evidence at least as strong as what set the current label.

## Arm 1 — a single negotiate failure is treated as a durable verdict

`isUnsupportedProtocolError` (`packages/fret/src/rpc/protocols.ts:32`) is matched at three call
sites, each responding with an immediate `markForeign`:

- `fret-service.ts:1039` — `probeNeighborsLatency`. Its input is `getNeighbors(...)`, which is
  **member-gated**, so every demotion here is a *confirmed member* being demoted.
- `fret-service.ts:1375` — the maybeAct forward path. Its `next` hop comes from `assembleCohort`,
  also member-gated — likewise always a confirmed member.
- `fret-service.ts:1137` — `probeMembership`. This is the only site that legitimately sees
  `unknown` / `foreign` peers.

A peer whose FRET service has not yet run `registerRpcHandlers()`, or that restarted (`stop()`
unhandles all five protocols — `fret-service.ts:414`), produces exactly the same error as a
genuinely foreign peer. Note also that `openRpcStream` dials with `negotiateFully: false`
(`protocols.ts:228`), so negotiation outcomes surface lazily on first use; a stream opened over a
circuit-relay connection that the relay resets can surface as the same class of failure.

**Fix:** a negotiate failure is evidence, not a verdict. Count consecutive negotiate failures per
peer and demote to `foreign` only at a threshold (recommend 3). Any successful RPC in either
direction, or an identify list containing one of our protocols, resets the counter.

Delaying the `unknown → foreign` demotion costs nothing in correctness — `unknown` is already
excluded from every ring view — so the whole cost is ~2 extra pings per genuinely-foreign peer,
once, spread across the existing backoff schedule (1 s + 2 s + 4 s ≈ 7 s to a settled label).
Where `identify` is available, a genuinely foreign peer is still labelled `foreign` on first sight
by its protocol list, so the common case is unchanged.

## Arm 2 — a stale identify event demotes an RPC-confirmed member

`classifyByProtocols` (`fret-service.ts:307`) marks a peer `foreign` whenever the supplied protocol
list is non-empty and contains none of ours. It is called from the `peer:identify` and `peer:update`
listeners (`fret-service.ts:382`, `:393`) with whatever list the event carries — and that list can
predate this service registering its handlers.

`seedFromPeerStore` (`fret-service.ts:927`) already guards this correctly, classifying only entries
still labelled `unknown`. That rule is right; generalize it rather than duplicating it.

**Fix:** identify-derived evidence may **promote** (`unknown`/`foreign` → `member` when our protocol
is present) but may only **demote** from `unknown`. It never demotes a `member`.

## Arm 3 (new) — the strongest signal available is discarded

An **inbound** namespaced RPC is the strongest membership proof there is: the remote dialed a
protocol only this network's peers speak, and the sender identity is transport-authenticated. Today
no inbound handler promotes membership:

- `handleAnnounce` (`fret-service.ts:852`, `:868`) has the verified `from` and calls only
  `applyTouch`, which does not touch `membership` (`fret-service.ts:247`).
- `handleMaybeAct` receives the authenticated sender as `_from` and drops it (`fret-service.ts:468`).
- `handlePingRequest` and `handleNeighborsRequest` are invoked from handlers that already hold the
  `Connection` (`rpc/ping.ts:30`, `rpc/neighbors.ts:28` — both take `(stream, connection)` and
  currently name it `_connection`), but no sender is threaded to the service.

This matters most for exactly the field case in `gotchoices/Optimystic#11`: a NAT'd peer that
serves the network but that we struggle to dial *does* reach us. Promoting on inbound traffic
re-admits it immediately and for free, with no extra probe traffic.

**Fix:** thread the transport-authenticated `connection.remotePeer` to the service for all four
inbound RPCs and promote the sender to `member`.

## Why recovery is not enough (the reprobe budget)

`reprobeForeignPeers` (`fret-service.ts:1093`) is the only guaranteed way back from `foreign`. Its
per-tick budget is 2 (core) / 1 (edge), and a confirmed-foreign probe records a backoff that doubles
to a 32× cap (`recordBackoff`, `fret-service.ts:1414`, base 1000 ms). So with F genuinely-foreign
peers in steady state, foreign peers come off backoff at ≈ F/32 per second, while the pass can
service ≈ 2 per 1.5 s tick ≈ 1.33 per second in passive mode. Above roughly F ≈ 42 the pass is
saturated and a freshly-mislabelled peer waits behind genuinely-foreign ones.

This is arithmetic from the constants above, not a measurement — but it is the reason the fix
belongs at the labelling site rather than in the recovery budget. As a cheap mitigation, order the
reprobe candidates by ascending backoff factor so a freshly-demoted peer (factor 1) is probed before
a long-confirmed foreign one (factor 32).

## Shape of the change

Route every classification through **one** guard on `FretService` so a fourth site added later
inherits it rather than repeating the bug:

```ts
/** What produced a membership observation, ordered by how much it proves. */
type MembershipSignal =
  | 'rpc-success'        // completed outbound namespaced RPC        → member
  | 'rpc-inbound'        // authenticated inbound namespaced RPC     → member
  | 'identify-member'    // identify list contains one of ours       → member
  | 'identify-foreign'   // identify list non-empty, none of ours    → foreign, only from unknown
  | 'negotiate-failure'; // could not negotiate                      → foreign at threshold only

private applyMembershipSignal(id: string, signal: MembershipSignal): void
```

`markMember` / `markForeign` become private implementation details of this guard (or disappear);
the three `isUnsupportedProtocolError` call sites and `classifyByProtocols` all route through it.

Consecutive-failure state: add `negotiateFailures: number` to `PeerEntry`
(`store/digitree-store.ts:23`), defaulting to 0 on insert and preserved by `upsert` like the other
counters. The store must stay network-agnostic — it stores and exposes the counter, it never
branches on it, exactly as it already does for `membership`. Include it in `SerializedPeerEntry` as
optional, and have `importTable` reset it to 0 the same way it forces `state: 'disconnected'` —
handshake history cannot survive a restart. (A service-local `Map` is the alternative, but it needs
its own pruning; the store field is evicted with its entry for free.)

## Tests to add

Put the identify-driven cases in `test/membership-identify.spec.ts` (it already has the real-TCP +
identify harness and a `disableProbing` helper) and the probe/negotiate cases in
`test/ring-membership.spec.ts` (memory nodes, probe path). Both files already document why they use
the node factory they use — follow that.

- **Arm 2, verified failing today.** Two `createIdentifyNode()` peers on `net-a`; wait for
  `member`; `disableProbing(svcA)`; then dispatch on node A:
  `new CustomEvent('peer:update', { detail: { peer: { id: nodeC.peerId, protocols: ['/ipfs/id/1.0.0','/ipfs/ping/1.0.0'] } } })`.
  Assert C is still `member` after a short settle.
- **Arm 1a, verified failing today.** Two `createMemNode()` peers on `net-a`; wait for `member`;
  `await svcC.stop()`; assert C is **not** demoted to `foreign` by the first negotiate failure.
- **Arm 1b.** Same setup, then `await svcC.start()`; assert C is `member` and that the transient
  window never excluded it from `getNeighbors`. Also assert an `unknown` peer that never answers is
  still eventually labelled `foreign` (the threshold must not disable classification).
- **Arm 3.** A peer labelled `foreign` sends us an inbound namespaced RPC (ping / announce);
  assert it is promoted to `member` with no outbound probe (`getDiagnostics().pingsSent === 0`,
  the existing witness used in `membership-identify.spec.ts`).
- Keep the existing `isUnsupportedProtocolError` unit tests unchanged — that helper's contract
  (an explicit unsupported-protocol error vs a timeout) is not what changes here.

## TODO

Phase 1 — store

- Add `negotiateFailures: number` to `PeerEntry`; default 0 on insert; preserve on `upsert`
- Add it to `SerializedPeerEntry` (optional) and `exportTable`; reset to 0 in `importTable`
- Unit-test default / preserve-on-upsert / import-reset, alongside the existing membership tests

Phase 2 — the guard

- Add `MembershipSignal` and `applyMembershipSignal(id, signal)` to `FretService`
- Implement the strength rules: promotions always apply and reset `negotiateFailures`;
  `identify-foreign` demotes only from `unknown`; `negotiate-failure` increments and demotes only at
  the threshold (3)
- Route `applySuccess`, `classifyByProtocols`, and all three `isUnsupportedProtocolError` sites
  (`fret-service.ts:1039`, `:1137`, `:1375`) through it; remove the now-redundant `unknown`-only
  guard inside `seedFromPeerStore` (it becomes the general rule)

Phase 3 — inbound promotion (arm 3)

- Thread `connection.remotePeer` from `rpc/ping.ts` and `rpc/neighbors.ts` request handlers to their
  service callbacks (both already receive the `Connection` as `_connection`)
- Use the already-available sender in `handleMaybeAct` (`_from`) and `mergeAnnounceSnapshot` (`from`)
- Call `applyMembershipSignal(from, 'rpc-inbound')` from all four

Phase 4 — recovery ordering

- Order `reprobeForeignPeers` candidates by ascending backoff factor so freshly-demoted peers are
  probed before long-confirmed foreign ones

Phase 5 — tests and docs

- Add the five test cases above
- Update the *Ring membership* section of `docs/fret.md`: replace the flat list of label transitions
  with the strength table and the "member is only set by positive proof, only cleared by repeated
  proof of absence" rule; document inbound-RPC promotion and the negotiate-failure threshold
- `npx tsc --noEmit` and `yarn test` from `packages/fret`
