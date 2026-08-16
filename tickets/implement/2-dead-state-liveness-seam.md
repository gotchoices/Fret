description: Peers that repeatedly fail to answer are supposed to be marked dead, but nothing in the code ever marks one. This is the first half: count failed contact attempts per peer, mark a peer dead after three spread-out failures, and clear that state again as soon as the peer proves it is alive.
files: packages/fret/src/store/digitree-store.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/index.ts, packages/fret/test/dead-state.spec.ts
difficulty: medium
----

Split from the original `dead-state-transition` ticket after a budget cutoff; **no code was
written**, only a call-site survey (recorded below, verified against the current tree — use it
instead of re-discovering). This ticket is Phases 1–3: the counter, the liveness seam, and the
failure call sites. Its sibling `dead-state-exclusion-recovery` is Phases 4–6 (ring exclusion,
the dead re-probe pass, docs) and depends on this landing.

`PeerState` already has a `'dead'` member and `FretPeerDiscovery` already skips dead entries
(`src/service/peer-discovery.ts:117`, verified present), but **no code path ever writes `'dead'`**.
The only failure response today is relevance decay (`applyFailure`, factor 0.7), so an unreachable
peer keeps a low-but-nonzero relevance and lingers.

### Design, settled

**1. The counter lives on the routing-table entry, not in a service-side map.**
`PeerEntry` gains `contactFailures` (consecutive failed contact attempts since the last proof of
life) and `lastContactFailureAt` (the spacing timestamp below). Exact precedent:
`negotiateFailures` / `lastNegotiateFailureAt` (`digitree-store.ts:30-47`) already live there, so
they are evicted with their entry for free, need no pruning pass, and cannot outlive the peer.

**2. What counts as a strike — the one rule.**
A strike is *failure to reach the peer at all*: the outbound RPC threw (dial failure,
`NoValidAddressesError`, stream/read timeout, transport error). A **negotiation refusal**
(`isUnsupportedProtocolError`) is **not** a strike: the dial succeeded and the peer answered at the
transport layer, so it is demonstrably alive — that error is membership evidence and already routes
to `applyMembershipSignal(id, 'negotiate-failure')`. Nor is a `peer:disconnect` event a strike:
libp2p closes idle connections routinely, and counting them would kill healthy peers after three
ordinary connection cycles. `peer:disconnect` keeps its relevance decay and nothing more. An
`ok: false` ping reply (busy / empty / undecodable) is also not a strike — the peer answered;
`sendPing` collapses busy and empty into the same result, so take the conservative reading and only
decay relevance.

**3. Three strikes, and they must be spread over time.**
Threshold defaults to 3, configurable as `FretConfig.deadAfterFailures`. Two failures closer
together than 500 ms are the *same* observation seen by concurrent callers (several forwards to one
restarting hop), not independent evidence, so the second is ignored — identical reasoning and
identical constant to `NEGOTIATE_FAILURE_MIN_SPACING_MS` (`fret-service.ts:209`), but a separate
constant (`CONTACT_FAILURE_MIN_SPACING_MS`) because the two runs mean different things and should be
free to diverge. The doc's "3+ consecutive timeouts **or explicit error**" reads, in code, as "3+
consecutive failed contacts, whether timeout or error" — the alternative reading (any single
explicit error kills the peer immediately) is exactly the mistake the membership work already fixed
for `UnsupportedProtocolError`. (The doc rewording is the sibling ticket's Phase 6.)

**4. Strike accounting is synchronous.**
`applySuccess` / `applyFailure` read an entry, `await selfCoord()`, then write a value derived
before the await — so two concurrent chains lose one increment (there is already a `NOTE:` on
`applySuccess`, `fret-service.ts:351`, saying so). Harmless for a relevance score recomputed every
call; *not* harmless for a threshold counter, where a lost strike silently delays or prevents the
transition. So the strike helper takes no awaits: read entry → patch → return, exactly like
`applyMembershipSignal`.

**5. Recovery: proof of life resets the counter and resurrects the state.**
One synchronous helper, called from every site that proves the peer is alive — `applySuccess` (a
completed namespaced RPC), `noteInboundRpc` (the peer dialed us), and the `peer:connect` handler (a
transport connection formed). It sets `contactFailures: 0` and, if the entry was `'dead'`, restores
`'connected'` when `isConnected(id)` else `'disconnected'`. The counter must be reset on
`peer:connect` too: `setState(id, 'connected')` there (`fret-service.ts:514`) would otherwise
resurrect a peer whose counter is still clamped at the threshold, so the very next failure re-kills
it.

Relevance is deliberately **not** hard-reset to a baseline, despite the doc's wording.
`scoreSuccess` already up-ranks on success, and wiping the health counters would erase the record of
a peer that flaps. (Reword that doc bullet in the sibling ticket.)

**6. Persistence: dead does not survive a restart.**
`contactFailures` is exported in `SerializedPeerEntry` (optional, diagnostics only) and reset to 0
on import, and `importEntries` already forces `state: 'disconnected'` — so an imported table never
carries a dead peer. Same reasoning as `negotiateFailures`. `lastContactFailureAt` is not serialized
at all.

**7. Self.** The strike helper refuses to mark self dead. Self is not a normal RPC target, but a
dead self drops out of every ring view *and* out of capacity protection once the sibling ticket
lands, which is unrecoverable without a restart — cheap guard, catastrophic failure avoided.

### Verified call-site map (current tree — do not re-survey)

- `PeerEntry` `digitree-store.ts:23-64`; `negotiateFailures` doc-comment pair at `:30-47` is the
  style to match. `upsert` new-entry branch `:170-183`. `SerializedPeerEntry` `:75-88`.
  `exportEntries` `:352-367`. `importEntries` reset block `:396-398`.
- `FretConfig` `src/index.ts:5-12` — `k`/`m`/`capacity`/`profile` required, `bootstraps`/
  `networkName` optional. Constructor config block `fret-service.ts:242-249`.
- `NEGOTIATE_FAILURE_THRESHOLD` `:199`, `NEGOTIATE_FAILURE_MIN_SPACING_MS` `:209`.
- `applySuccess` `:358`, `applyFailure` `:376`, `applyMembershipSignal` `:403`, `noteInboundRpc`
  `:456`, `peer:connect` handler `:506-517`, `peer:disconnect` handler `:518-533`.
- Failure call sites to route through the new seam:
  - `probeNeighborsLatency` catch `:1373-1386` (note the inner `try/catch` and `diag.pingsFail++`)
  - `probeMembership` catch `:1480-1494` (records backoff on both arms)
  - `routeAct` forward catch `:1738-1745`
  - `iterativeLookup` activity-send catch `:2159-2162`, hop catch `:2178-2184`
- The `coordOf` pattern to extract:
  `this.store.getById(id)?.coord ?? (await hashPeerId(peerIdFromString(id)))` — occurrences at
  `:512`, `:524`, `:1365`, `:1369`, `:1382`, `:1471`, `:1728`, `:2171`.
- Test template: `test/ring-membership.spec.ts` (`createMemNode`/`stopAll` from `test/helpers/libp2p.js`,
  its `waitFor`, `coordAt`, `seed` helpers, and the `(svc as any)` private-method access pattern).

### Behavior delta to call out in the handoff

Routing `probeNeighborsLatency`'s catch through the seam means an `UnsupportedProtocolError` there
no longer also decays relevance (today it calls `applyFailure` on both arms, `:1381-1383`). That is
the intended reading — a peer that refuses negotiation answered at the transport layer, so it is
alive and the membership machinery owns that signal — but it *is* a change, so state it plainly in
the review handoff rather than letting the reviewer find it.

### Tests — `packages/fret/test/dead-state.spec.ts` (create; sibling ticket extends it)

Spacing is wall-clock, so drive strikes deterministically: apply a strike, then
`store.update(id, { lastContactFailureAt: 0 })` before the next one, rather than sleeping.

- Three spaced contact failures → `state === 'dead'`, `contactFailures === 3`.
- Two spaced failures → still live (`state !== 'dead'`, count 2); the third kills it.
- Three failures inside the 500 ms spacing window → count 1, still live.
- An `UnsupportedProtocolError` failure through the seam → no strike (count stays 0); the
  membership path still records its own strike.
- Three `peer:disconnect`-style `applyFailure` calls → no strike, still live.
- Self can never be marked dead, however many strikes are applied.
- Recovery: `applySuccess` on a dead peer → `contactFailures === 0`, state `disconnected` (or
  `connected` when a connection exists).
- Recovery via inbound RPC (`noteInboundRpc`) resurrects a dead peer.
- `contactFailures` defaults to 0 and survives a re-upsert (mirrors the `negotiateFailures` test
  at `ring-membership.spec.ts:175`).
- Export/import round-trip: a dead peer imports as `disconnected` with `contactFailures === 0`.

### TODO

**Phase 1 — store**
- Add `contactFailures: number` and `lastContactFailureAt: number` to `PeerEntry`, with doc comments
  in the style of the `negotiateFailures` pair (what a run proves, why spacing matters).
- Default both to 0 in `upsert`'s new-entry branch; the hit branch preserves them via spread already.
- `SerializedPeerEntry`: add optional `contactFailures?: number`; export it, reset to 0 on import
  alongside `negotiateFailures`; do not serialize `lastContactFailureAt`.

**Phase 2 — liveness seam in `FretService`**
- Add `deadAfterFailures` to `FretConfig` and default it to 3 in the constructor's config block.
- Add `CONTACT_FAILURE_MIN_SPACING_MS = 500` static, documented as its own run separate from the
  negotiate one.
- Add a **synchronous** strike helper (no awaits): skip self, apply the spacing guard, clamp the
  count at the threshold, and set `state: 'dead'` on reaching it.
- Add `applyContactFailure(id, coord)` = `await applyFailure(...)` then the strike helper — the
  single seam for "we could not reach this peer".
- Add a synchronous aliveness helper (reset count, resurrect from `'dead'`), and call it from
  `applySuccess`, `noteInboundRpc`, and the `peer:connect` handler.
- Add a small `coordOf(id)` helper for the repeated coord-lookup pattern above; use it in the sites
  you touch (do not sweep the file — that is `cleanup-core-service`'s job).

**Phase 3 — failure call sites**
- Add one seam `noteRpcFailure(id, err)`: unsupported-protocol → membership strike only; anything
  else → `applyContactFailure`. It must **not** record backoff — each call site keeps its existing
  backoff behavior so this ticket introduces no backoff where there was none.
- Route the five call sites listed above through it; leave the `ok: false` arms as they are
  (relevance decay / backoff only, no strike).

**Validation**
- `cd packages/fret && npx tsc --noEmit`, then `yarn test` in the foreground with no redirection.
