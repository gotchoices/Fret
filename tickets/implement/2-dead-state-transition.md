----
description: Peers that repeatedly fail to answer are supposed to be marked dead and dropped from routing, but nothing in the code ever marks one, so unreachable peers linger in the routing table and keep getting picked as next hops. Add the failure counting, the dead marking, the exclusion from routing, and the recovery path.
files: packages/fret/src/store/digitree-store.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/index.ts, packages/fret/src/service/peer-discovery.ts, packages/fret/test/dead-state.spec.ts, docs/fret.md
difficulty: medium
----

`PeerState` already has a `'dead'` member and `FretPeerDiscovery` already skips dead entries
(`src/service/peer-discovery.ts:118`), but **no code path ever writes `'dead'`**. The only failure
response today is relevance decay (`applyFailure`, factor 0.7), so an unreachable peer keeps a
low-but-nonzero relevance, stays in the successor/predecessor windows, keeps being selected as a
next hop, and keeps being counted in the network-size estimate. This ticket implements the doc's
"Failure detection and recovery" contract end to end.

### Design, settled

**1. The counter lives on the routing-table entry, not in a service-side map.**
`PeerEntry` gains `contactFailures` (consecutive failed contact attempts since the last proof of
life) and `lastContactFailureAt` (the spacing timestamp below). Exact precedent:
`negotiateFailures` / `lastNegotiateFailureAt` already live there so they are evicted with their
entry for free, need no pruning pass, and cannot outlive the peer. A service-side `Map` would be
one more unbounded map to bound (cf. ticket `map-capacity-bounds`).

**2. What counts as a strike — the one rule.**
A strike is *failure to reach the peer at all*: the outbound RPC threw (dial failure,
`NoValidAddressesError`, stream/read timeout, transport error). A **negotiation refusal**
(`isUnsupportedProtocolError`) is **not** a strike: the dial succeeded and the peer answered at the
transport layer, so it is demonstrably alive — that error is membership evidence and already routes
to `applyMembershipSignal(id, 'negotiate-failure')`. Nor is a `peer:disconnect` event a strike:
libp2p closes idle connections as a matter of course, and counting them would kill healthy peers
after three ordinary connection cycles. `peer:disconnect` keeps its relevance decay and nothing
more. An `ok: false` ping reply (busy / empty / undecodable) is also not a strike — the peer
answered; `sendPing` collapses busy and empty into the same result, so we take the conservative
reading and only decay relevance.

**3. Three strikes, and they must be spread over time.**
Threshold defaults to 3, configurable as `FretConfig.deadAfterFailures`. Two failures closer
together than 500 ms are the *same* observation seen by concurrent callers (several forwards to one
restarting hop), not independent evidence, so the second is ignored — identical reasoning and
identical constant to `NEGOTIATE_FAILURE_MIN_SPACING_MS`, but a separate constant
(`CONTACT_FAILURE_MIN_SPACING_MS`) because the two runs mean different things and should be free to
diverge. The doc's "3+ consecutive timeouts **or explicit error**" reads, in code, as "3+ consecutive
failed contacts, whether timeout or error" — the alternative reading (any single explicit error kills
the peer immediately) is exactly the mistake the membership work already fixed for
`UnsupportedProtocolError`, where one error from a restarting same-network peer looks identical to a
genuinely absent one. Update `docs/fret.md` to say so rather than leaving the divergence.

**4. Strike accounting is synchronous.**
`applySuccess` / `applyFailure` read an entry, `await selfCoord()`, then write a value derived
before the await — so two concurrent chains lose one increment (there is already a `NOTE:` on
`applySuccess` saying so). Harmless for a relevance score recomputed every call; *not* harmless for
a threshold counter, where a lost strike silently delays or prevents the transition. So the strike
helper takes no awaits: read entry → patch → return, exactly like `applyMembershipSignal`.

**5. Exclusion extends the existing ring predicate; it is not a second guard.**
`isMember` (`fret-service.ts:80`) becomes `isLiveMember`:
`e.membership === 'member' && e.state !== 'dead'`. Every ring-shaped read already funnels through
it, so one edit covers successor/predecessor windows, cohort assembly, the routing-candidate walk,
the size estimate, and the outgoing snapshot's neighbor lists and sparsity sample. Two consequences
fall out rather than needing their own code:

- *"Remove from S/P"* — FRET stores no S/P set; those windows **are** the filtered ring walk, so
  exclusion from the predicate is the removal.
- *Dead peers become preferred eviction victims* — `enforceCapacity` protects only the peers the
  same predicate returns around self, so a dead peer loses protection while its decayed relevance
  puts it at the front of the victim list. No eviction-specific dead handling is needed.

**6. Recovery: proof of life resets the counter and resurrects the state.**
One synchronous helper, called from every site that proves the peer is alive — `applySuccess` (a
completed namespaced RPC), `noteInboundRpc` (the peer dialed us), and the `peer:connect` handler (a
transport connection formed). It sets `contactFailures: 0` and, if the entry was `'dead'`, restores
`'connected'` when `isConnected(id)` else `'disconnected'`. Note the counter must be reset on
`peer:connect` too: `setState(id, 'connected')` there would otherwise resurrect a peer whose counter
is still clamped at the threshold, so the very next failure re-kills it.

Relevance is deliberately **not** hard-reset to a baseline, despite the doc's wording. `scoreSuccess`
already up-ranks on success, and wiping the health counters would erase the record of a peer that
flaps. Reword that doc bullet to describe what the code does.

**7. A dead peer must be able to come back on its own.**
Once excluded from the ring views, nothing pings a dead peer again — `stabilizeOnce` draws its probe
targets from `getNeighbors`, so a dead peer that recovers but never dials us and never forms a
connection would stay dead until evicted at capacity (and `upsert` preserves `state`, so a peerStore
re-seed does not resurrect it either). That is a black hole on a small ring, so the existing
foreign-re-probe pass is generalized: extract the shared mechanics (off-backoff + reachable
candidates, ascending-backoff-factor order, small per-tick budget, `probeMembership`) into one helper
and run it over two candidate sets with their own budgets — `foreign` (unchanged: core 2 / edge 1)
and `dead` (core 2 / edge 1). Separate budgets, not one merged list, so a large foreign population
cannot starve dead recovery (that pass is already near saturation around ~42 foreign peers by its
own stated arithmetic). `probeMembership` needs no change: on success it calls `applySuccess`, which
now both promotes membership and resurrects.

`classifyUnknownPeers` skips dead candidates so the two passes do not double-probe the same peer; a
dead peer's recovery arm promotes membership on success anyway.

**8. Persistence: dead does not survive a restart.**
`contactFailures` is exported in `SerializedPeerEntry` (optional, diagnostics only) and reset to 0
on import, and `importEntries` already forces `state: 'disconnected'` — so an imported table never
carries a dead peer. Same reasoning as `negotiateFailures`: liveness history cannot outlive the
process on either end. `lastContactFailureAt` is not serialized at all.

### Edge cases & interactions

- **Burst vs run.** Three failures inside 500 ms count as one; the peer must survive. Three failures
  spread past the window kill it.
- **Self.** The strike helper refuses to mark self dead. Self is not a normal RPC target, but a
  dead self drops out of every ring view *and* out of capacity protection, which is unrecoverable
  without a restart — cheap guard, catastrophic failure avoided.
- **Negotiation refusal on a confirmed member.** Must demote membership (after its own run of 3) and
  must **not** contribute a liveness strike. A peer can end up `foreign` while alive, or `dead` while
  labelled `member`; both labels are independent and both are recoverable.
- **`peer:disconnect` churn.** N disconnects in a row leave the peer live (relevance decayed only).
- **Dead + capacity.** Fill past capacity with one dead peer and one live member neighbor: the dead
  one is evicted, the live neighbor is protected.
- **Dead peer in a cohort walk.** The ring walk *skips and keeps advancing* on a filter miss, so a
  cluster of dead peers sitting nearest a key must not shrink the cohort below `wants` while live
  members exist further out. Same property the member gate already relies on.
- **Dead peer as an announce / leave target.** `sendAnnouncementsRateLimited` (`~:903`) walks the
  store unfiltered and already skips `foreign`; it must skip dead for the same reason (the dial can
  only fail). Leave-notice fan-out draws from the gated ring views — verify, don't assume.
- **Resurrection races.** An inbound RPC arriving while a probe is failing: last write wins, and both
  paths are synchronous single patches, so the entry cannot end up half-resurrected.
- **Discovery.** `FretPeerDiscovery` already filters `state === 'dead'` independently of the service
  predicate; leave it, and check it still agrees once dead peers actually exist.
- **Simulator / exported standalones.** `assembleCohort`, `estimateSizeAndConfidence`,
  `selectDiverseSample` take the predicate as a parameter and default to no filter — the simulation
  harness must stay byte-for-byte unaffected.

### Tests — `packages/fret/test/dead-state.spec.ts`

Spacing is wall-clock, so drive strikes deterministically: apply a strike, then
`store.update(id, { lastContactFailureAt: 0 })` before the next one, rather than sleeping.

- Three spaced contact failures → `state === 'dead'`, `contactFailures === 3`.
- Two spaced failures → still live (`state !== 'dead'`, count 2); the third kills it.
- Three failures inside the 500 ms spacing window → count 1, still live.
- An `UnsupportedProtocolError` failure → no strike (count stays 0); membership path unaffected.
- Three `peer:disconnect`-style `applyFailure` calls → no strike, still live.
- A dead peer is absent from `getNeighbors`, `assembleCohort`, the routing-candidate walk, the
  outgoing snapshot's successors/predecessors/sample, and the member-scoped size estimate — where
  a live member at a comparable coordinate is present in all of them.
- Cohort does not shrink: with `wants` live members available past a run of dead ones nearest the
  key, the cohort still returns `wants` ids, none dead.
- Capacity eviction prefers the dead peer over a live member neighbor.
- Recovery: `applySuccess` on a dead peer → `contactFailures === 0`, state `disconnected` (or
  `connected` when a connection exists), and it reappears in `getNeighbors`.
- Recovery via inbound RPC (`noteInboundRpc`) resurrects a dead peer.
- Two-node: mark B dead in A's store, run a stabilization tick, expect the dead-re-probe arm to ping
  B and A's view of B to return to live + `member`.
- Export/import round-trip: a dead peer imports as `disconnected` with `contactFailures === 0`.

### TODO

**Phase 1 — store**
- Add `contactFailures: number` and `lastContactFailureAt: number` to `PeerEntry`, with doc comments
  in the style of the `negotiateFailures` pair (what a run proves, why spacing matters).
- Default both to 0 in `upsert`'s new-entry branch; `upsert`'s hit branch preserves them (already
  does, via spread).
- `SerializedPeerEntry`: add optional `contactFailures?: number`; export it, reset to 0 on import
  alongside `negotiateFailures`; do not serialize `lastContactFailureAt`.

**Phase 2 — liveness seam in `FretService`**
- Add `deadAfterFailures` to `FretConfig` (`src/index.ts`) and default it to 3 in the constructor's
  config block (`~:242`).
- Add `CONTACT_FAILURE_MIN_SPACING_MS = 500` static, documented as its own run separate from the
  negotiate one.
- Add a **synchronous** strike helper (no awaits): skip self, apply the spacing guard, clamp the
  count at the threshold, and set `state: 'dead'` on reaching it.
- Add `applyContactFailure(id, coord)` = `await applyFailure(...)` then the strike helper — the
  single seam for "we could not reach this peer".
- Add a synchronous aliveness helper (reset count, resurrect from `'dead'`), and call it from
  `applySuccess`, `noteInboundRpc`, and the `peer:connect` handler.
- Add a small `coordOf(id)` helper for the
  `store.getById(id)?.coord ?? await hashPeerId(peerIdFromString(id))` pattern the new call sites
  repeat; use it in the sites you touch (do not sweep the file — that is
  `cleanup-core-service`'s job).

**Phase 3 — failure call sites**
- Add one seam `noteRpcFailure(id, err)`: unsupported-protocol → membership strike only; anything
  else → `applyContactFailure`. It must **not** record backoff — each call site keeps its existing
  backoff behavior so this ticket introduces no backoff where there was none.
- Route through it: `probeNeighborsLatency`'s catch (`~:1373`), `probeMembership`'s catch (`~:1480`),
  `routeAct`'s forward catch (`~:1738`), `iterativeLookup`'s hop catch (`~:2178`) and activity-send
  catch (`~:2159`).
- Leave the `ok: false` arms as they are (relevance decay / backoff only, no strike).

**Phase 4 — exclusion**
- Rename `isMember` → `isLiveMember` and extend it to `membership === 'member' && state !== 'dead'`;
  update its doc comment and all call sites.
- Skip dead in `classifyUnknownPeers`'s candidate filter and in `sendAnnouncementsRateLimited`'s
  target loop (next to the existing `foreign` skip).
- Verify the leave fan-out targets are gated views; gate them if not.

**Phase 5 — recovery pass**
- Extract the shared mechanics of `reprobeForeignPeers` into one helper parameterized by candidate
  predicate and budget; call it for `foreign` (core 2 / edge 1) and for dead (core 2 / edge 1).
- Update the doc comments to explain the two arms and why the budgets are separate.

**Phase 6 — docs + validation**
- `docs/fret.md`: "Stabilization and churn handling" (what counts as a strike, the spacing rule,
  removal-from-S/P being ring-view exclusion, recovery resetting the counter and state rather than
  hard-resetting relevance), the member-only ring-views section (predicate is now member **and** not
  dead), `SerializedPeerEntry` (add `contactFailures`), and the suggested-defaults list
  (`deadAfterFailures: 3`).
- Write `test/dead-state.spec.ts` per the list above.
- `cd packages/fret && npx tsc --noEmit`, then `yarn test` in the foreground with no redirection.
