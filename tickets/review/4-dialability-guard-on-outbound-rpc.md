description: The check for "do we know how to reach this peer?" was calling a libp2p method that does not exist, so it always answered no; it now answers from libp2p's own address book, and the outbound calls that never asked the question now skip peers they could not possibly reach.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/test/dialability.spec.ts, docs/fret.md
difficulty: medium

Implemented. `npx tsc --noEmit` clean; `yarn test` from `packages/fret/` — **319 passing, 0 failing** (~4 min).

## What changed

### Arm 1 — `hasAddresses` now answers honestly

`FretService.hasAddresses` probed `node.getMultiaddrsForPeer`, which does not exist on libp2p v3 and is nowhere in the dependency tree — the optional call yielded `undefined`, `?? []` made it empty, and the helper returned `false` for every peer, always.

It is now backed by a service-local `addressKnown: Set<string>`:

- **Rebuilt wholesale** in `seedFromPeerStore` from the `peerStore.all()` walk it already performs (start + every stabilization tick). Wholesale replacement, not a merge, so it prunes itself and stays bounded by peerStore size.
- **Refreshed per-peer on identify**: `peer:update` reads addresses straight off the event's `Peer` record (no round-trip); `peer:identify` calls `refreshAddressKnown`, which does one `peerStore.get`. A `NotFoundError` there is the ordinary negative answer and clears the id; any *other* error is logged, not swallowed.
- Reading the peerStore directly per call was rejected because all seven callers are synchronous `.filter()` predicates and `peerStore.get` is async.

New helper `isDialable(id) = isConnected(id) || hasAddresses(id)` replaces the three open-coded copies of that expression.

### Arm 2 — dial sites that never asked

- `sendLeaveToNeighbors` primary S/P loop — skips undialable neighbors (`ids` itself stays unfiltered: it defines the S/P set the replacement computation excludes). Runs inside `stop()`, so this also removes a stack of doomed dials from the shutdown path.
- `handleLeave` warm loop — replacement ids come straight off the wire; filtered for dialability *before* the 6-peer budget is applied, so warm slots are not spent on ids that can only fail.
- `routeAct` — dialability is a **hard filter on the candidate list** before `chooseNextHop`, so the selector picks the best *reachable* hop. Empty set falls through to the existing `buildNearAnchor`, exactly as "no next hop" already did. Because the filter runs before selection, an unreachable peer can never take a negotiate-failure strike.
- `iterativeLookup` — same hard filter on both candidate sources.
- `iterativeLookup` anchor resend — takes the first *dialable* anchor; when none is, falls through to the existing `bestAnchors` update.

### Third defect found mid-implementation (scope call — please weigh this)

The ticket asked for a regression spec proving `announceToNewPeers` actually sends to an address-known, non-connected peer. That test **could not pass even with `hasAddresses` fixed**: `announceNeighbors` passed `requireExisting: true`, i.e. connection-only. So every announce path that deliberately *prefers non-connected* targets (`announceToNewPeers`, `announceNeighborsBounded`, `announceOnDeparture`) was selecting peers it then silently refused to contact — while still spending an announce token and incrementing `announcementsSent`.

Fixed in line with the ticket's declared intent ("expect a traffic increase, deliberately"):

- `announceNeighbors` takes `opts: { dial?: boolean }`, still connection-only by default.
- `FretService.sendAnnouncementsRateLimited` — the single choke point for outbound announces — passes `dial: true`, and applies `isDialable` **before** taking a token.
- The inline announce inside `handleLeave`'s warm loop passes `dial: true` too (that loop is already dialability-filtered).

This is a real behavior change beyond the ticket's literal TODO list. **If the reviewer disagrees, the revert is small and local** (drop the `dial` flag; the guard and the specs stay valid, but `announceToNewPeers` returns to being a no-op and its spec must be deleted).

### Two deliberate deviations from the ticket text

- Ticket said `iterativeLookup`'s anchor path should "keep the existing `exhausted` yield as the empty-set outcome" for the candidate filter. Implemented instead: when the *anchor* list filters empty, fall back to the local cohort (also filtered), and yield `exhausted` only when both are empty. Rationale — today's code drains failed anchors one dial at a time and eventually falls back to the local cohort; a naive filter would have turned that into an immediate `exhausted`, a regression. This preserves the fallback while removing the wasted dials.
- Ticket said to check `anchor.anchors[0]`. Implemented as "first dialable anchor" — same rule ("filter into the walk, never out of the result").

### Docs

`docs/fret.md` gains a **Dialability** section defining "has addresses" concretely (the libp2p peerStore holds ≥1 multiaddr; FRET's own wire format contributes none), the maintenance-skips vs routing-filters-into-the-walk split, and the announce dial policy. The classification-probe paragraph in *Ring membership* now points at it.

## Tests

New: `packages/fret/test/dialability.spec.ts` — 8 specs, all passing. They drive private methods via `as any` (consistent with `announce-rate-limit.spec.ts`) and use crafted ring coordinates so no assertion depends on stabilization timing. Services under test are deliberately **not started** where a background tick would race the premise.

| Spec | What it pins |
|---|---|
| `hasAddresses` true/false | peerStore-known vs absent peer; asserts the helper's contract, not libp2p internals |
| wholesale-rebuild prune | `peerStore.delete` → next rebuild reports `false` |
| `announceToNewPeers` | regression for the path the bug switched off: announce reaches an address-known, non-connected peer, and the receiver's store shows the merge |
| `handleLeave` negative | addressless replacement → **zero** `dialProtocol` calls (instrumented counter) |
| `handleLeave` positive | address-known replacement → dial happens (proves the counter is live and the guard is selective) |
| `routeAct` | two undialable ghosts nearest the key + one connected peer farther → forwards to the connected one; zero dials; ghosts keep `negotiateFailures === 0` and `membership === 'member'` |
| `iterativeLookup` empty | all candidates undialable → exactly `['exhausted']`, zero dials |
| `iterativeLookup` anchor | stub responder returns an addressless anchor → no `activity_sent`, zero dials, walk still terminates `exhausted` |

## Known gaps — treat this as a floor

- **No dedicated spec for the five previously-dead guard sites** (`preconnectNeighbors`, active preconnect, `stabilizeOnce`'s near filter, `classifyUnknownPeers`, `reprobeForeignPeers`). Fixing `hasAddresses` re-enables real dial attempts at all of them — the intended traffic increase. Covered only indirectly by the existing suite staying green; nobody has measured the actual traffic delta on a live ring.
- **The anchor-guard spec depends on `shouldIncludePayload` returning false**, which it does because the test node is placed half a ring from the key. That is arithmetic on the payload heuristic, not a stated invariant; if the heuristic's thresholds change, that spec could start exercising the include-payload path instead and silently stop testing what it claims to.
- **`refreshAddressKnown` does one `peerStore.get` per `peer:identify` event.** Fine at expected identify rates; not measured.
- **`addressKnown` has no independent bound** — it is exactly as large as the peerStore. If libp2p's peerStore is unbounded in some deployment, so is this set.
- **Tripwire parked in code, not filed**: `stabilizeOnce` now selects address-known non-connected peers into `near`, but `fetchNeighbors` is still connection-only, so `mergeNeighborSnapshots` gets an empty snapshot while `snapshotsFetched` counts it — a diagnostics overcount, not a correctness bug. `NOTE:` at the call site in `fret-service.ts` (`stabilizeOnce`).
- **Not addressed (out of scope, per the ticket):** the durable fix is that no call site should have to remember the dial policy — it belongs at the `openRpcStream` seam or a service-level send wrapper. `tickets/plan/8-rpc-shared-helper` carries that arm. The `announceNeighbors` `dial` flag added here is one more per-site policy knob for that consolidation to absorb.
- **`tickets/plan/4-leave-amplification-cap`** redesigns `handleLeave`'s warm loop; the guard added here sits inside that loop and should move with it.
