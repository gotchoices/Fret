description: The check for "do we know how to reach this peer?" was calling a libp2p method that does not exist, so it always answered no; it now answers from libp2p's own address book, and the outbound calls that never asked the question now skip peers they could not possibly reach.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/test/dialability.spec.ts, docs/fret.md

Complete. `npx tsc --noEmit` clean, `yarn build` clean, `yarn test` from `packages/fret/` — **322 passing, 0 failing** (~4 min).

## What shipped

**`hasAddresses` answers honestly.** It used to probe `node.getMultiaddrsForPeer`, which does not exist on libp2p v3 — the optional call yielded `undefined`, `?? []` made it empty, and the helper returned `false` for every peer, always. It is now backed by a service-local `addressKnown: Set<string>`, rebuilt wholesale from the `peerStore.all()` walk `seedFromPeerStore` already performs each stabilization tick, and refreshed per-peer on `peer:identify` / `peer:update`. A synchronous set was chosen over reading the peerStore per call because all seven callers are synchronous `.filter()` predicates while `peerStore.get` is async.

**Dial sites that never asked now ask.** `isDialable(id) = hasAddresses(id) || isConnected(id)` guards the leave fan-out, the leave-replacement warm-up, the announce fan-out, and both routing candidate walks (`routeAct`, `iterativeLookup`).

**Announces now dial on purpose.** `announceNeighbors` gained `opts.dial`; it stays connection-only by default. The service's announce choke point passes `dial: true`, because every announce target list deliberately *prefers* non-connected peers — previously those paths selected peers they then silently refused to contact while still spending an announce token.

**Docs.** `docs/fret.md` gains a *Dialability* section defining "has addresses" concretely and stating the maintenance-skips vs routing-filters-into-the-walk split and the announce dial policy.

## Review findings

### Major — found and fixed in this pass

- **The routing cohort was post-filtered, which is the exact failure the surrounding comment claimed to prevent.** `routeAct` and `iterativeLookup` called `assembleCohort(coord, max(4, m), exclude).filter(isDialable)`. `assembleCohort` already accepts a predicate that the ring walk applies *while walking* (that is how the member gate works), so filtering its sized result shrinks the cohort below the requested width — to empty whenever the peers nearest the key happen to be unreachable — and dead-ends a route while reachable hops sit just past them. Fixed by composing the predicate: a new private `dialableCohort` passes `e => isMember(e) && isDialable(e.id)` into the walk, and both call sites use it. A new spec (`routeAct still finds a hop when unreachable peers fill the whole cohort width`) pins it; it was **verified to fail against the post-filter version** before the fix was restored. The anchor-id list in `iterativeLookup` is deliberately still filtered directly — it is a remote-supplied list, not a sized walk.

### Minor — fixed in this pass

- **Announces now dial confirmed-foreign peers.** Announce target lists walk the store unfiltered (deliberately, so a freshly-connected `unknown` peer is not stalled). Making announces dial extended that to peers already proved to serve another network, where the dial can only end in `UnsupportedProtocolError`. The choke point now skips `membership === 'foreign'`; `unknown` is still announced to. Covered by the new choke-point spec.
- **`handleLeave` restated the announce policy inline** — its own `tryTake` / `announceNeighbors(dial: true)` / counter increment — right next to a comment calling the other site the "single choke point". It now calls `sendAnnouncementsRateLimited`, so the dial flag, token accounting, `stopped` check and counters live in one place.
- **`isDialable` argument order.** Was `isConnected(id) || hasAddresses(id)`; `isConnected` parses the peer id and walks the connection list while `hasAddresses` is a `Set.has`. Reordered so the cheap arm short-circuits — it now runs once per visited entry inside the ring walk.

### Tripwires — parked in code, not filed

- **`isDialable`**: "no address" implies "undialable" only while no peer-routing module is configured. libp2p's dialer falls back to `peerRouting.findPeer` for a bare-id dial with no known addresses, so a deployment running FRET alongside delegated routing or a DHT would find the routing guard over-restrictive. `NOTE:` at the helper.
- **`dialableCohort`**: the predicate runs `isDialable` per visited entry, and a walk that matches nothing is capped at one full traversal (C = 2048). `NOTE:` names the fix (a connected-id set) if capacity grows.
- **`seedFromPeerStore`**: the wholesale set swap clobbers an identify-driven `setAddressKnown` that lands mid-walk, losing that address until the next tick. Harmless — such a peer is connected, so `isConnected` covers it. `NOTE:` at the assignment.
- **`iterativeLookup`**: no visited set, so an all-unreachable anchor list can send the next iteration back to the same local hop until `maxAttempts`. Bounded, and the repeat is a real RPC rather than a failed dial. `NOTE:` at the fallback.
- **`stabilizeOnce`** (carried over from implement): `fetchNeighbors` is connection-only, so an address-known non-connected peer yields an empty snapshot while `snapshotsFetched` counts it — a diagnostics overcount. `NOTE:` already at the call site.

### Checked and clean — nothing found

- **Lifecycle / resource cleanup.** `addressKnown` is bounded by peerStore size and pruned by the wholesale rebuild; nothing to release on `stop()`, and `start()` reseeds it. No new timers, listeners or streams.
- **Error handling.** `refreshAddressKnown` treats `NotFoundError` as the ordinary negative answer and logs anything else rather than swallowing it — matches the project rule. `announceNeighbors`'s new `opts` argument is additive and defaults to the old behavior.
- **Type safety.** No new `any` in source; the test file's `as any` private-method access matches `announce-rate-limit.spec.ts`.
- **Maintenance-path skips.** `stabilizeOnce`'s near filter and `handleLeave`'s warm filter post-filter their lists, but neither is a sized ring walk with a fill requirement — skipping there is the intended semantics, not the cohort bug above.
- **Membership interaction.** A hop skipped for unreachability never reaches `sendMaybeAct`, so it cannot take a negotiate-failure strike; asserted directly in the `routeAct` spec.
- **Docs.** Every file the change touches was re-read against `docs/fret.md`; the *Dialability* section's routing bullet was rewritten to describe the composed predicate (it described the post-filter, which was both the code and the bug) and the announce bullet now states the foreign skip.

### Not filed, deliberately

- **Address-hint propagation** — fixing dialability makes the *skip decision* correct; it does not make more peers reachable, because FRET's wire format carries no multiaddrs. Already tracked as `tickets/backlog/feat-address-hints-in-neighbor-exchange`.
- **Per-site dial policy consolidation** — the `dial` flag added here is one more knob for the `openRpcStream` seam to absorb. Already an arm on `tickets/plan/8-rpc-shared-helper`.
- **`handleLeave` warm-loop redesign** — the guard added here sits inside the loop `tickets/plan/4-leave-amplification-cap` redesigns, and should move with it.

## Remaining gaps

- **The five previously-dead guard sites** (`preconnectNeighbors`, active preconnect, `stabilizeOnce`'s near filter, `classifyUnknownPeers`, `reprobeForeignPeers`) still have no dedicated spec. Fixing `hasAddresses` re-enables real dial attempts at all of them — the intended traffic increase — and nobody has measured the delta on a live ring. Covered only indirectly by the suite staying green.
- **The anchor-guard spec depends on `shouldIncludePayload` returning false**, which holds because the test node sits half a ring from the key. That is arithmetic on the payload heuristic, not a stated invariant; if its thresholds change, the spec could silently start exercising the include-payload path.
- **`refreshAddressKnown` does one `peerStore.get` per `peer:identify`** — fine at expected identify rates, not measured.

## Tests

`packages/fret/test/dialability.spec.ts` — 11 specs (8 from implement, 3 added in review):

| Spec | What it pins |
|---|---|
| `hasAddresses` true/false | peerStore-known vs absent peer |
| wholesale-rebuild prune | `peerStore.delete` → next rebuild reports `false` |
| `announceToNewPeers` | announce reaches an address-known, non-connected peer; receiver merged it |
| `handleLeave` negative / positive | addressless replacement → zero dials; address-known → dial happens |
| `routeAct` reachable hop | two ghosts nearest the key + one connected peer farther → forwards to the connected one; zero dials; ghosts keep `negotiateFailures === 0` and `membership === 'member'` |
| **`routeAct` crowded cohort** *(new)* | ghosts fill the entire cohort width on both sides → still forwards past them; regression for the post-filter defect |
| **`sendLeaveToNeighbors`** *(new)* | exactly one dial — the address-known neighbor, none of the ghosts |
| **announce choke point** *(new)* | an undialable target and a `foreign` target are both skipped; zero announces, zero dials |
| `iterativeLookup` empty | all candidates undialable → exactly `['exhausted']`, zero dials |
| `iterativeLookup` anchor | addressless anchor → no `activity_sent`, zero dials, walk terminates `exhausted` |
