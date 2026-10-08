description: A peer with no dialable address (a phone that dials out and listens nowhere) used to stay a live ring member forever after it went away, and its graceful leave notice either never arrived or was undone a tick later. All three departure paths now retire such a peer promptly.
architecture: docs/fret.md#stabilization-and-churn-handling
files: packages/fret/src/service/fret-service.ts (`NearWindow`, `nearProbeTargets`, `strikeUncontactable`, `stabilizeOnce`, `handleLeave`, `markDeparted`), packages/fret/src/service/libp2p-fret-service.ts (`beforeStop`, `stop`, `shutdown`), packages/fret/test/address-less-departure.spec.ts, packages/fret/test/churn.leave.spec.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/test/ring-membership.spec.ts, packages/fret/test/libp2p-facade-forwarding.spec.ts, docs/fret.md, docs/threat-analysis.md, tickets/backlog/22-debt-leave-authentication.md
----
Reported from sereus (`p2p-fret` v1.0.1): always-on members kept an offline phone in their Optimystic cohorts, so every member write waited ~50 s on it and failed.

## What shipped (`ticket(implement): address-less-peer-never-marked-dead`)

- **Uncontactable near-window members are struck once per tick.** `nearProbeTargets` returns `{ targets, uncontactable }` over the S/P window (`max(2, m)` live members per side, via `ringNeighborsBothSides`). `targets` = dialable, at most 4, closest first, sides interleaved; `uncontactable` = not connected and no peerStore address. `stabilizeOnce` books `applyContactFailure` against each before phase 1 (skipped once the run signal fired). The 500 ms spacing guard makes each tick one strike → `dead` on the third. Recovery is the existing proof-of-life paths.
- **Near-probe targets changed** from s1..s4 (the successor-biased `getNeighbors` walk) to s1, p1, s2, p2. Kept in this ticket: the strike window has to be the two-sided window, and splitting the target list from it would have meant two walks of the same window.
- **Leave notices go out before connections close.** `Libp2pFretService.beforeStop()` runs the whole shutdown (discovery, then core `stop()`); `stop()` runs the same idempotent `shutdown()`. Verified in libp2p 3.3.11: `Libp2p.stop()` → `components.beforeStop()` → `components.stop()`, each a `Promise.all` over startables.
- **A leave notice marks the sender `dead`** (`markDeparted`) instead of removing it, so the next `seedFromPeerStore` / `peer:update` cannot resurrect it as a live member.

## Review findings

Read the implement diff first, then the handoff; ran `npx tsc --noEmit` (clean) and `yarn test` (1306 passing, 0 failing) after review edits.

**Correctness — checked, no defects found.**
- `peer:disconnect` after a leave: `noteDisconnected` already skips a `dead` entry, so the disconnect that follows a graceful departure cannot clear the label; `applyFailure` only decays relevance. `peer:connect` (`setState('connected')` + `noteProofOfLife`) restores a returning phone at once.
- Re-seed: `seedFromPeerStore` runs before `stabilizeOnce` in the loop, so `addressKnown` is fresh when the uncontactable split is taken; `upsert` preserves `state`, classification touches only `membership`.
- Disjointness: uncontactable ids are live members but undialable, so they cannot appear in any pooled phase-1/phase-2 set; awaiting the strikes before phase 1 has no race. `applyContactStrike` is synchronous and self-guarded.
- Facade double shutdown: `FretPeerDiscovery.stop()` and core `stop()` are both idempotent, so `stop()` after `beforeStop()` is a no-op. `inner?.stop()` handles a never-built core.
- libp2p lifecycle claim verified against `node_modules/libp2p/dist/src/{components,libp2p}.js` (3.3.11).
- A leave from a `foreign`/`unknown` entry also marks it dead; the dead re-probe arm owns it from there. Fine.

**Docs — one inaccuracy fixed.** `docs/fret.md` *Hard failure* said a vanished address-less peer is dead "after three ticks (~4.5 s)". It ignored active mode, whose 300 ms ticks the 500 ms spacing guard thins to every other tick (~1.2–1.5 s to dead). Reworded with both cadences.

**Stale wording — fixed inline.** `docs/threat-analysis.md` §1 said `handleLeave` removes the peer (now: marks it dead, history noted); `test/churn.leave.spec.ts` comment on "never inserts self or the departing peer" still said `handleLeave` removed it (now: the skip guards the no-entry case); `tickets/backlog/22-debt-leave-authentication.md` overview and arm 1 said "removes"/"before removal" (now: marks dead / before acting on the notice). The interaction note the implementer already added at the end of that ticket stands.

**Tests — kept as written, none added or cut.** `address-less-departure.spec.ts` has two cases: the arm-1 reproduction, and the arms-2+3 case against a real libp2p-hosted phone. Each is a reproduction of the reported bug at the lowest layer that shows it, and the implementer mutation-checked them. The `ring-membership.spec.ts` `stopWithoutNotice` helper matches those tests' intent: they model a restart blip with the handlers gone and the node up, not a departure. Before this change those tests passed only because the re-seed undid the leave removal. The rewritten assertions in `churn.leave.spec.ts` and `rpc.codec-properties.spec.ts` check the new observable (`state === 'dead'`).

**Tripwires / accepted gaps (no tickets filed):**
- Window-only sweep: on a ring larger than 2·max(2, m) + 1 live members, an address-less member outside our window is never struck by us. This is already parked as a `NOTE:` at `strikeUncontactable` and in docs.
- A departed entry keeps its relevance (`markDeparted` does not decay it), so a highly scored departed peer is unprotected but not a *preferred* eviction victim, and it lingers until capacity pressure reaches it. It is bounded by capacity and invisible to every ring view. Not worth a NOTE beyond the docs' *Leave* paragraph, which already states the entry stays until capacity evicts it.
- Shutdown latency: a libp2p-hosted `stop()` can now take up to `SHUTDOWN_BUDGET_MS` (3 s) longer when neighbours stall, because the fan-out now really runs over live connections instead of failing fast. This is stated in the handoff and in the docs' A1 lifecycle section, and it is the intended cost.
- `beforeStop` runs concurrently with other components' `beforeStop`. Nothing in libp2p 3.3.11 implements it, and docs say so.
- No diagnostics counter for uncontactable strikes; there is only a debug log line. The ticket marked the counter optional.

**Major findings:** none, so no tickets filed.

**Not touched:** the `tess` submodule shows as modified in the working tree; that is unrelated to this ticket.
