description: A node connected to a relay that runs no FRET (or to a node of another FRET network) kept pinging it forever and kept its own maintenance loop from slowing down to its idle rate; now routine re-probes no longer hold the loop awake, and a peer that both advertises none of our protocols and has refused a run of our probes is left alone.
architecture: docs/fret.md#ring-membership-same-network-vs-foreign
files: packages/fret/src/service/fret-service.ts (`stabilizeOnce` phase-2 pending site + NOTE, `PhaseTwoTargets`, `phaseTwoTargets`, `classifyByProtocols`, `noteAdvertisedProtocols`, `reprobeExcludedTargets`, `isSettledForeign`, `reprobeOffRingTargets`), packages/fret/src/store/digitree-store.ts (`PeerEntry.advertisedForeign`, `upsert`, `importEntries`), packages/fret/src/service/idle-backoff.ts (docs only), packages/fret/test/near-exchange.spec.ts, packages/fret/test/address-hints.relay.spec.ts (header only), packages/fret/test/stabilize-concurrency.spec.ts, packages/fret/test/relevance.eviction.spec.ts, packages/fret/test/relevance.properties.spec.ts, docs/fret.md
----
# Review: foreign peers no longer re-probed by the idle loop

GitHub [#3](https://github.com/gotchoices/Fret/issues/3), from sereus's message accounting (gotchoices/sereus#50).

## What changed

**1. Only the classify arm holds the idle backoff at its base.** `phaseTwoTargets` now returns `{ classify, reprobe }` (`PhaseTwoTargets`); `stabilizeOnce` calls `idle.notePending()` only when `classify` is non-empty and pools `[...classify, ...reprobe]` exactly as before. The old NOTE at the pending site is replaced by an accepted-tradeoff NOTE: once backed off, the re-probe arms service their budget (Core 2 / Edge 1 per arm) per interval, so at the 60 s cap a Core ring with 10 dead entries re-probes each about every 5 minutes while idle. Revisit condition: dead-recovery latency on large idle rings showing up as a problem. Unchanged: a phase cut off by the tick budget still holds pending, and so does a redial the pass outlives (`runStabilizationPass`).

**2. New `PeerEntry.advertisedForeign`.** It records whether the latest non-empty protocol list libp2p delivered for the peer named none of ours, whatever the peer's label. It is written in `classifyByProtocols` → `noteAdvertisedProtocols` (the one site that sees identify lists), only when the value changes, and never counts as a change. `upsert` defaults it to `false`, it is kept across updates, it is not serialized, and `importEntries` resets it to `false`.

**3. Re-probe suppression: deviates from the ticket's plan, and the reviewer should weigh this.** The plan had the re-probe arms skip any peer with `advertisedForeign`. That broke `test/address-hints.relay.spec.ts` every time I ran it (2 of 2 runs alone, plus the full suite). Its three nodes each start the core `FretService` by hand after their node was identified, and they run no `identifyPush`. So every node's peerStore holds every other node's pre-FRET protocol list. Every node therefore labels every other `foreign` with the flag set, and nobody ever probes anybody, so the ring never forms. The plan's "residual hole" paragraph assumed a peer started this way "walks its peerStore, labels us `member`, and pings us". That is false when *both* sides started after identify.

What shipped instead is `isSettledForeign(e)` = `advertisedForeign && negotiateFailures >= NEGOTIATE_FAILURE_THRESHOLD`. A peer is skipped only when its advertised list lacks our protocols **and** it has refused a full spaced negotiate run (3 refusals) with no positive proof since. A relay therefore costs 3 failed pings per run (about 7 s on the 1 s / 2 s / 4 s backoff), then silence. Two hand-started same-network peers recover: the one that starts later finds the earlier one serving, so its foreign-arm probe succeeds and its pings then promote it on the other side. Both re-probe arms (foreign and dead) use this filter. docs/fret.md, *Re-probe passes*, now states this rule ("Neither half suppresses alone") and the narrower residual hole.

**4. Docs.** docs/fret.md is updated in three places:
- *Pending work holds the base*: only the classify arm holds, the per-interval throughput consequence, and the two rejected alternatives.
- *Re-probe passes*: a new bullet on settled-foreign peers covering the rule, why neither half suppresses alone, the paths back and the residual hole; the saturation arithmetic is fixed.
- The `peerStore protocols` bullet under *Evidence strength*: notes the flag.

## Tests

Added to `test/near-exchange.spec.ts`, "idle two-node strand". Both use the shared helper `climbBesideOffRingPeer`: a third, plain libp2p node C (no FRET service) is connected to A and held in A's table, C's probe backoff is cleared before every cycle, and the test drives `runStabilizationPass` to a 12 s cap.
- **"…advertises another network and refused a run backs off to the cap and never probes it"**: C is labelled with `classifyByProtocols(cId, ['/ipfs/id/1.0.0'])` plus `negotiateFailures: 3`. The test asserts that A's `pingsFail` does not change, then that A and B both reach the cap. Mutation (filter removed): reddens on "C was never probed".
- **"…is negotiate-foreign backs off to the cap while still re-probing it"**: C is `foreign` with `negotiateFailures: 3` and the flag `false`. The test asserts that A and B reach the cap and that `pingsFail` grew. Mutation (pending on any selection): reddens on "A reached the cap".
- The two cases differ only in the flag, which isolates it.

Updated tests:
- `test/address-hints.relay.spec.ts`: header only. It now records a third mutation: suppressing on the flag alone reddens the positive case. I ran that mutation. This spec is the only pin on the "neither half alone" rule.
- `test/stabilize-concurrency.spec.ts`: its `phaseTwo` helper flattens the new `{ classify, reprobe }` return shape.
- `test/relevance.eviction.spec.ts` and `test/relevance.properties.spec.ts`: their `PeerEntry` literals gain the new field.

Validation: `npx tsc --noEmit` passes. `yarn test` from `packages/fret` gave 1340 passing, 0 failing. All six specs the ticket lists, plus `idle-backoff.spec.ts`, pass on their own (126 tests).

## Known gaps and things to check

- **Not measured on sereus.** The "~10 pings a minute" and "2 failed negotiations a minute" figures are the reporter's numbers. I did not re-measure on a device. The near-exchange cases show the loop reaching the cap beside such a peer, but not the absolute message rate.
- **The flag is about what the peer advertises, not about RPC results**, as the plan specified. A successful RPC (`rpc-success` / `rpc-inbound`) promotes the peer but leaves the flag set. This is harmless under `isSettledForeign`, because a positive proof resets `negotiateFailures` to 0, so the peer cannot be suppressed again until it refuses a fresh run. Worth a second look if a reviewer prefers the flag cleared on positive proof.
- **Import after `start()`:** a replaced foreign entry comes back with the flag `false` and keeps being re-probed (per interval while idle) until its next `peer:update`. Accepted; a comment in `importEntries` says so.
- **Residual-hole reasoning is not tested beyond the relay rig.** The docs argue that a hand-started same-network peer suppressed by both halves is still recovered by its own probe of us, but nothing tests a peer that starts serving after we have already suppressed it.
- **Startup with a relay:** each of the relay's three refusal strikes counts as a change, so for roughly the first 7 s the loop stays at its base. This is expected.
- No `identifyPush`-driven test of the flag clearing (`identify-member` → `false`). It is pinned only indirectly, by the start-walk and listener paths in `test/membership-identify.spec.ts` staying green.
