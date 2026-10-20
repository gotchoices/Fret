description: A node connected to a relay that runs no FRET (or to a node of another FRET network) kept pinging it forever and kept its own maintenance loop from slowing down to its idle rate; now routine re-probes no longer hold the loop awake, and a peer that both advertises none of our protocols and has refused a run of our probes is left alone.
architecture: docs/fret.md#ring-membership-same-network-vs-foreign
files: packages/fret/src/service/fret-service.ts (`stabilizeOnce` phase-2 pending site + NOTE, `PhaseTwoTargets`, `phaseTwoTargets`, `classifyByProtocols`, `noteAdvertisedProtocols`, `reprobeExcludedTargets`, `isSettledForeign`, `reprobeOffRingTargets`), packages/fret/src/store/digitree-store.ts (`PeerEntry.advertisedForeign`, `upsert`, `importEntries`), packages/fret/src/service/idle-backoff.ts (docs only), packages/fret/test/near-exchange.spec.ts, packages/fret/test/address-hints.relay.spec.ts (header only), packages/fret/test/stabilize-concurrency.spec.ts, packages/fret/test/relevance.eviction.spec.ts, packages/fret/test/relevance.properties.spec.ts, docs/fret.md
----
# Complete: foreign peers no longer re-probed by the idle loop

GitHub [#3](https://github.com/gotchoices/Fret/issues/3), from sereus's message accounting (gotchoices/sereus#50). Implemented in `ticket(implement): foreign-peers-not-reprobed-by-the-idle-loop`.

## What shipped

- **Only the classify arm holds the idle backoff at its base.** `phaseTwoTargets` returns `{ classify, reprobe }` (`PhaseTwoTargets`); `stabilizeOnce` calls `idle.notePending()` only when `classify` is non-empty and still pools both lists together. The accepted-tradeoff `NOTE:` at that site states the consequence: once backed off, the re-probe arms service their budget per interval (at the 60 s cap, a Core ring with 10 dead entries re-probes each about every 5 minutes while idle). Revisit if dead-recovery latency on large idle rings becomes a problem.
- **New `PeerEntry.advertisedForeign`.** It records whether the latest non-empty protocol list libp2p delivered named none of ours, whatever the label. It is written only in `classifyByProtocols` → `noteAdvertisedProtocols`, never counts as a change, is not serialized, and is reset to `false` on import.
- **Re-probe suppression: `isSettledForeign(e)` = `advertisedForeign && negotiateFailures >= 3`.** Both re-probe arms (foreign and dead) skip such a peer. A relay costs 3 failed pings per run, then nothing. Neither half suppresses alone. Suppressing on the flag alone would break `test/address-hints.relay.spec.ts`, where hand-started nodes each hold the others `foreign` off stale identify lists. Suppressing on the refusal run alone would stop recovery of a same-network peer that is mid-restart.
- docs/fret.md is updated under *Pending work holds the base*, *Re-probe passes* (a new settled-foreign bullet with the "neither half alone" rule and the residual hole) and the `peerStore protocols` bullet.

## Review findings

**Diff read first, then the handoff.** I traced every write and read of the new field and every caller of `notePending`.

- **Correctness of the pending change.** No problems found. The classify arm stays transient: `classifyTargets` filters backed-off and dead peers, and every failing outcome of `probeMembership` either records backoff or progresses a contact or negotiate run, so an `unknown` peer cannot hold the loop indefinitely. The other pending sources (a skipped near probe, a tick cut off by its budget, an in-flight redial) are unchanged.
- **Correctness of `isSettledForeign`.** No problems found.
  - `negotiateFailures` is clamped at the threshold, and every positive signal (`rpc-success`, `rpc-inbound`, `identify-member`) resets it to 0. So a peer that proves itself cannot stay suppressed, and the flag being left set after an RPC success does no harm.
  - `identify-foreign` never resets the run, so a relay's reconnect plus re-identify keeps it suppressed. That is intended.
  - The dead arm skipping a settled-foreign peer is correct, because FRET has no reason to redial a relay. libp2p's own relay transport handles reservations.
  - I checked the residual-hole argument in the docs (two hand-started same-network peers) and it holds when neither restarts.
- **Store/serialization.** Correct. `upsert` spreads the previous entry on a hit, so the flag survives. `exportEntries` lists fields explicitly and leaves the flag out. `importEntries` resets it to `false`. The flag is not a label the per-label counts track, so `tally` needs no change.
- **Change accounting.** Correct. `noteAdvertisedProtocols` writes only when the value changes and never calls `noteChange`. Clearing the flag coincides with the `identify-member` promotion, which counts for itself.
- **Tests.** I kept both new near-exchange cases. Each pins one half of the fix, and they differ only in the flag. I re-ran one mutation myself: removing the `isSettledForeign` filter reddens "C was never probed". The `address-hints.relay.spec.ts` header records the flag-alone mutation, which pins the "neither half alone" rule. The helper updates in the other three specs are mechanical. I cut no tests and added none, because no defect was found that needs a reproduction.
- **Docs (minor, fixed inline).**
  - docs/fret.md, *Neither half suppresses alone*: the sentence about hand-started hosts was garbled and is rewritten so it parses.
  - `idle-backoff.ts` header: the list of pending sources omitted the skipped near probe, a gap that predates this change. Added.
  - The rest of the doc text I checked is consistent with the code (*Pending work*, *Re-probe passes* with its saturation note, *peerStore protocols*, the `idle-backoff.ts` `notePending` doc).
- **Hygiene.** Comments at the new sites explain why rather than narrating, and the new functions are small and single-purpose. `fret-service.ts` is 4784 lines (`wc -l`); its size predates this ticket, which added about 70 lines, so nothing new was filed.
- **Major findings:** none. **Tripwires added:** none. The one conditional concern, dead-recovery latency on large idle rings, already has its accepted-tradeoff `NOTE:` at the pending site in `stabilizeOnce`.
- **Known gaps carried from implement, accepted:**
  - The message rate was not re-measured on sereus.
  - No `identifyPush`-driven test of the flag clearing.
  - No test of a peer that starts serving after we have suppressed it.
  - An import after `start()` resets the flag until the next `peer:update`.

  All are documented and none is a latent defect.

## Validation

- `npx tsc --noEmit`: clean.
- `yarn test` from `packages/fret`: 1340 passing, 0 failing (log in `tickets/.logs/foreign-peers-not-reprobed-by-the-idle-loop.review.log`).
- Targeted specs (near-exchange, address-hints.relay, stabilize-concurrency, idle-backoff, ring-membership, membership-identify) all pass.
