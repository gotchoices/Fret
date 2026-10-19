description: A node connected to a relay that runs no FRET (or to a node of another FRET network) keeps pinging it forever and keeps its own maintenance loop from slowing down to its idle rate; stop probing peers whose advertised protocols show they cannot serve this network, and stop letting routine re-probes hold the loop awake.
architecture: docs/fret.md#ring-membership-same-network-vs-foreign
files: packages/fret/src/service/fret-service.ts (`stabilizeOnce` phase-2 pending site and its NOTE, `phaseTwoTargets`, `reprobeExcludedTargets`, `reprobeOffRingTargets`, `applyMembershipSignal` identify arms, `classifyByProtocols`), packages/fret/src/store/digitree-store.ts (`PeerEntry`, `upsert` defaults, `importEntries`), packages/fret/src/service/idle-backoff.ts (class doc only), packages/fret/test/near-exchange.spec.ts, docs/fret.md
----
<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-10-19T18:50:46.277Z (agent: claude)
  Log file: C:\projects\Fret\tickets\.logs\foreign-peers-not-reprobed-by-the-idle-loop.implement.2026-10-19T18-50-46-277Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
# Foreign peers are not re-probed by the idle loop

GitHub [#3](https://github.com/gotchoices/Fret/issues/3), from sereus's message accounting (gotchoices/sereus#50).

## Problem

Measured on sereus (FRET 1.1.0, unchanged in 1.2.0): two relay-only parties on one strand, idle 60 s. Each strand node sent ~10 `fret/ping` per minute to the other (a stable two-member ring that should idle at ~1 pass a minute), plus 2 failed `fret/ping` negotiations per minute to its relay and 2 each way between two connected control nodes of different FRET networks — all of it through the relay on a phone.

Two causes, both in the stabilization tick's phase 2 (`stabilizeOnce` → `phaseTwoTargets`):

1. **Any non-empty phase-2 selection holds the idle backoff at its base** (`this.idle.notePending()` when `targets.length > 0`). A permanently foreign peer comes off its probe backoff (1 s doubling to 32 s) about once per 32 s, each time the ladder restarts at 1.5 s, and the ring settles at ~5 passes per 32 s (the existing NOTE at that site predicted exactly this). Each pass is a near ping.
2. **The foreign re-probe arm probes peers that cannot be same-network.** A relay or another network's node is labelled `foreign` by identify (its protocol list is non-empty and names none of ours). The foreign arm exists to recover a *mislabelled* same-network peer, but it re-probes these at the backoff cadence forever, and redials them when disconnected.

## Design

### 1. Hold pending for the classify arm only

`phaseTwoTargets` returns the two selections apart (e.g. `{ classify: string[]; reprobe: string[] }`); `stabilizeOnce` calls `notePending()` only when `classify` is non-empty, and pools `[...classify, ...reprobe]` exactly as today.

Why the arms differ: an `unknown` peer is a transient population the ring is waiting on — the next pass should continue classifying at the base. A foreign or dead re-probe's outcome lands *inside* the pass: success is a membership/revival change (`noteChange` already fires), a failure that progresses a run is a change, and a failure that progresses nothing needs no follow-up pass. A redial the pass outlives is already held by the `redials.size > 0` check in `runStabilizationPass`, and a phase 1 cut off by the tick budget keeps its own `notePending()` — both unchanged.

Stated consequence (goes into docs): once backed off, the off-ring arms service their budget (Core 2 / Edge 1 per arm) per *interval*, not per 1.5 s. A dead or negotiate-foreign peer whose 32 s window expires during a backed-off interval is re-probed up to one interval late (already documented), and with more such peers than the budget per interval each is re-probed roughly once per `ceil(count / budget)` intervals — at the 60 s cap, a ring holding 10 dead entries re-probes each about every 5 minutes (Core) while idle. Accepted: a recovered peer that is our neighbour contacts us itself (inbound RPC revives), a reconnect revives via `peer:connect`, and any change puts the loop back at the base. Replace the existing NOTE at the pending site with a NOTE carrying this tradeoff and its revisit condition (dead recovery latency on large idle rings showing up as a problem → hold pending when an off-ring arm was truncated by its budget, accepting that it re-wakes the loop when the arms are saturated).

Rejected: pending whenever an arm was budget-truncated. With Edge's budget of 1, two dead entries whose windows align truncate on every window and restart the ladder every ~32 s — the bug again.

### 2. Do not re-probe a peer whose latest advertised protocol list lacks ours

New `PeerEntry` field, e.g. `advertisedForeign: boolean` — "the most recent non-empty protocol list libp2p delivered for this peer (identify / `peer:update` / the start walk) named none of this network's protocols". The store only stores it (same rule as `membership`).

- Written in the identify arms of `applyMembershipSignal` (or `classifyByProtocols`, implementer's choice — one site): `identify-foreign` → `true` **whatever the current label** (a `member` peer stays `member`, but the flag records what it now advertises); `identify-member` → `false`. Write only when the value differs. An empty list (identify pending) leaves it untouched, matching the label rule.
- Never a `noteChange` on its own: a flip to `false` coincides with the `identify-member` promotion that already counts, and a flip to `true` on a member moves nothing a pass acts on.
- `upsert` default `false`; preserved across `upsert`/`update` like every mutable field; **not serialized**, `false` on `importEntries` (the start walk re-derives it from the peerStore; a table imported after `start()` re-probes a replaced foreign entry until its next `peer:update` — acceptable, say so in a comment only if the code reads ambiguous).
- `reprobeOffRingTargets` (the shared mechanics of both re-probe arms) skips entries with `advertisedForeign`. Both arms, not just foreign: a dead peer advertising none of ours cannot become a ring member by answering our ping; if it comes back, `peer:connect` revives it and an identify change re-labels it. This also ends FRET redialing a disconnected relay.
- The classify arm needs no filter: `identify-foreign` demotes an `unknown` peer in the same call that sets the flag.
- The separate per-arm budgets — the invariant that a large foreign population must not starve dead recovery — are untouched; the filter only removes candidates.

Paths back for a same-network peer suppressed by the flag, all already present: `identifyPush` delivering the new list (`identify-member` → member, flag cleared); a reconnect re-running identify (a changed list fires `peer:update`); any inbound namespaced RPC from it (`rpc-inbound` → member). A negotiate-demoted peer whose latest list still names ours (a same-network peer mid-restart on a host without `identifyPush`) keeps being re-probed — that is the case the foreign arm exists for.

Residual hole, to be stated in docs as accepted: a same-network peer identified *before* its FRET registered handlers, on a deployment without `identifyPush`, that never reconnects and never contacts us, stays `foreign`. Not reachable under the ordinary libp2p-service registration: libp2p starts every service before the transport manager listens (`TransportManager.afterStart`, verified in `packages/fret/node_modules/libp2p/dist/src/transport-manager.js`), so a peer's FRET handlers are registered before anyone can identify it. Reachable only for a host that starts the core `FretService` by hand after its node — and such a peer, once started, walks its peerStore, labels us `member`, and pings us from its warm-up and near passes on any small ring.

### 3. Embedder-supplied never-probe set — declined

Item 2 already covers relays (every libp2p relay runs identify; the circuit-relay client needs it to find the hop protocol) and other networks' nodes. A peer whose identify never completes falls to the negotiate path and, with item 1, costs at most one re-probe per interval. Not filed; revisit only if a deployment shows a non-identifying peer class worth configuring away.

## Edge cases & interactions

- **Peer both `dead` and `advertisedForeign`**: skipped by the dead arm too (by the shared filter). Verified by inspection.
- **Member that stops serving us with `identifyPush`** (remote `stop()` unhandles): flag `true`, label stays `member`; the near pass's negotiate strikes demote it to `foreign`; it is then suppressed; its restart's push (`identify-member`) promotes it and clears the flag. Verified by inspection; existing `test/failure-recovery.spec.ts` service-only-outage block must stay green.
- **Same restart without `identifyPush`**: the stale list still names ours → flag `false` → re-probed → recovers. Existing tests cover the recovery; must stay green.
- **Unknown peer probed before identify lands** (relay just connected): the classify arm may strike it once (foreign-protocol); identify then demotes it with the flag set. No special handling.
- **Phase 2 truncated by the tick budget** after selecting re-probe targets only: nothing pending; next pass reselects one interval later. Documented as "up to one interval late".
- **`phaseTwoTargets` zero-walk gate**: unchanged; a permanently foreign relay keeps `countByMembership('foreign') > 0`, so the tick still takes its one `store.list()` per pass — at most one per interval once backed off. No new count for the flag.
- **Stale-walk NOTE** in `phaseTwoTargets` still holds (selection still writes nothing).
- **Active mode**: passes don't drive the ladder; unaffected.

## Test (one `it` per behaviour, in `test/near-exchange.spec.ts` "idle two-node strand", reusing `member` / `admit` / the `runStabilizationPass` cycle and a small `maxPassiveIntervalMs` cap like the existing backoff case)

Add a third plain libp2p node C (no FRET service — the relay stand-in), connect it to A, and upsert it into A's store. Then:

- **"a ring whose only off-ring peer advertises another network backs off to the cap and never probes it"**: label C via `(a.svc as any).classifyByProtocols(cId, ['/ipfs/id/1.0.0'])` (sets `foreign` + flag). Clear C's probe backoff before every cycle (`(a.svc as any).backoff.clear(cId)`) so only the flag can keep it out. Expect A and B to reach the cap, and A's `pingsFail` unchanged across the climb (C never probed). Mutation: removing the flag filter reddens the `pingsFail` assertion.
- **"a ring whose only off-ring peer is negotiate-foreign backs off to the cap while still re-probing it"**: `store.update(cId, { membership: 'foreign', negotiateFailures: 3 })` (a settled run, so each failed probe is quiet — do *not* leave it below the threshold: hand-driven passes land inside the 500 ms negotiate spacing and the strikes would be ignored or count as changes unpredictably). Clear C's backoff before every cycle so the foreign arm selects it every pass. Expect both sides at the cap, and A's `pingsFail` grew (non-vacuity: C was probed). Mutation: restoring pending-on-any-selection reddens the cap assertion.

No other new tests: the flag's write rule is two branches in an existing guard, pinned indirectly by the first case and by `test/membership-identify.spec.ts`.

## TODO

- Split `phaseTwoTargets`' result into classify and re-probe selections; `notePending()` on classify only; replace the NOTE at the pending site with the tradeoff + revisit condition above.
- Add `advertisedForeign` to `PeerEntry` (doc comment in the house style), `upsert` default, `importEntries` reset; do not add it to `SerializedPeerEntry`.
- Write it in the identify arms (`identify-foreign` → true regardless of label, `identify-member` → false; only on change; no `noteChange`).
- Skip `advertisedForeign` entries in `reprobeOffRingTargets`; update the doc comments of `reprobeExcludedTargets` / `reprobeOffRingTargets` (the foreign-arm bullet's "dependable backstop" sentence now applies to negotiate-demoted peers only).
- Update `IdleBackoff`'s class doc ("off-ring peers it selected for probing" → unknown peers selected for classification).
- Add the two tests above; run `test/near-exchange.spec.ts`, `test/membership-identify.spec.ts`, `test/ring-membership.spec.ts`, `test/failure-recovery.spec.ts`, `test/dead-state.spec.ts`, `test/stabilize-concurrency.spec.ts`, then `yarn test` and `npx tsc --noEmit` from `packages/fret/`.
- docs/fret.md: in *The passive interval backs off* → "Pending work holds the base", change "a pass whose phase 2 *selected* at least one off-ring peer" to the classify arm only, and replace the "settles at about five passes per window" consequence with the per-interval throughput consequence above; in *Re-probe passes*, add the `advertisedForeign` exclusion and the residual hole, and fix the saturation arithmetic's "a non-empty selection holds the loop at the base" clause (true now only while unknowns exist or the loop is otherwise at the base); in *Evidence strength*, note that `identify-foreign` also suppresses off-ring re-probing until a list naming ours arrives.
