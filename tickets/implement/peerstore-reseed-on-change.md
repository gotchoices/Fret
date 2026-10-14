description: Every 1.5 seconds FRET re-reads and re-decodes libp2p's entire list of known peers, and re-parses its configured bootstrap addresses, even when nothing in either has changed. Do this work only when the list actually changes, with a slow safety re-read every few minutes for the changes libp2p makes without telling anyone.
prereq: maintenance-redial-off-the-tick
architecture: docs/fret.md#dialability-can-we-reach-this-peer-at-all
files: packages/fret/src/service/fret-service.ts (addressKnown field doc, setAddressKnown, refreshAddressKnown, classifyByProtocols NOTE, start, peer:update / peer:identify listeners, noteDiscovered, seedFromPeerStore, startStabilizationLoop, seedFromBootstraps, constructor, stabilizeOnce comment at the enforceCapacity call, comments near 2085 / 2927 / 4030), packages/fret/test/per-tick-hotpath.spec.ts, packages/fret/test/membership-identify.spec.ts (comments only), packages/fret/test/failure-recovery.spec.ts (comment only), packages/fret/test/address-less-departure.spec.ts (must stay green unchanged), packages/fret/test/dialability.spec.ts, docs/fret.md
difficulty: medium
----
Reported as gotchoices/Fret#2 (p2p-fret 1.0.2, via sereus on phones). The reporter's suggestion 3. The `NOTE:` at `seedFromPeerStore` already proposes this ("gate the re-seed itself on a peerStore change/epoch") and its revisit condition has tripped: libp2p's `pbToPeer` and multiaddr parsing show up in the reporter's idle CPU profile.

## Today

Each stabilization pass (the closure in `startStabilizationLoop`) runs `seedFromPeerStore()` → `seedFromBootstraps()` → `stabilizeOnce()`.

- `seedFromPeerStore` calls `peerStore.all()` (decodes every record), and per peer: `store.upsert` (on an existing entry this refreshes `lastAccess` and nothing else), `classifyByProtocols`, `adoptPeerRecord` if the entry holds no record; then swaps `addressKnown` for a freshly built set; then upserts self and labels it `member`.
- `seedFromBootstraps` re-parses up to 8 configured strings as multiaddrs, SHA-256-hashes each id, and calls `noteDiscovered` (a no-op for an id already held).

## What libp2p v3 actually tells us (researched, `@libp2p/peer-store` 12.0.28)

- `save` / `patch` / `merge` / `consumePeerRecord` fire `peer:update` whenever the stored record changed (`#emitIfUpdated`), including the first merge of a never-seen peer, and never when nothing changed. The event's `peer` is the post-change record with addresses already age-filtered, so `peer.addresses.length` is authoritative — an explicit address drop is visible as a `peer:update` and needs no `previous` comparison.
- **Three changes are silent** — no event of any kind:
  - `peerStore.delete(peerId)`. libp2p itself never calls it (grep of `libp2p` / `@libp2p/*` dist finds no internal caller); only host code does.
  - **Address aging.** `pbToPeer` drops any address whose `observed` stamp is older than `maxAddressAge` (default `MAX_ADDRESS_AGE` = 1 h) *on read*. A peer whose addresses nobody refreshes for an hour silently reads as address-less.
  - **Peer expiry.** A record not updated for `maxPeerAge` (6 h) with no fresh address is deleted on read.
- So an event-only `addressKnown` can go stale only on the scale of an hour (or a host `delete`), and only in the "still says dialable, isn't" direction. That is what the backstop below is for.

## Design

### 1. The per-pass walk is removed; its jobs move to events

| Job | New home |
|---|---|
| Create entry for a new peerStore peer | `peer:update` / `peer:identify` listeners (already do it; route through one helper, below) |
| Classify off protocol list | same listeners (already do it) |
| Adopt identify's signed record | `peer:update` listener (already does it) |
| has-addresses set | `peer:update` (`setAddressKnown(id, peer.addresses.length > 0)`, already there) + `peer:identify` (`refreshAddressKnown`, already there) + **backstop** for the silent changes |
| Self upsert + `member` | once, in `start()` (the start walk). Nothing rotates self's coordinate and eviction protects self |

**One creation helper.** The two listeners and the start walk each do `if (!store.getById(id)) store.upsert(id, await hashPeerId(pid))`. Replace all three with one private helper (e.g. `notePeerStorePeer(pid)`) that hashes only on a miss and creates through `noteDiscovered`. Decision: peerStore-learned peers take the **hearsay baseline** (`initialRelevance`) rather than today's bare `upsert` at relevance 0. A peerStore entry is a peer libp2p was told about, not one we contacted (a real connection is scored separately by `peer:connect`'s `applyTouch`), and `docs/fret.md` (*Relevance scoring*) explains why a creation at 0 starves on a full table. An existing entry is left completely untouched, which is also a deliberate change: the walk used to refresh `lastAccess` for every peerStore peer on every pass, which both distorted recency and re-stamped every `unknown` peer each tick, defeating `classifyTargets`' ascending-`lastAccess` rotation. Add the peerStore events to the list of creation sites in the docs' *Relevance scoring* paragraph.

**Listener ordering in `start()`.** Today `start()` awaits the walk, `enforceCapacity` and `registerRpcHandlers` before any listener is attached, so a `peer:update` landing in that window is lost for good once the per-pass walk is gone. Attach the `peer:update` and `peer:identify` listeners **before** the start walk (the other listeners stay where they are). The walk and an event for the same peer may then interleave; that is safe because creation goes through the helper (`noteDiscovered` re-checks `getById` synchronously before inserting), classification goes through `applyMembershipSignal`, record adoption has its own sequence rule, and the address set uses the event-wins rule below.

### 2. The start walk (`seedFromPeerStore`, kept under that name)

Runs once per `start()`, after the two listeners attach, followed by the existing explicit `enforceCapacity`. Keep the name: a dozen specs call it as a "populate from the peerStore" helper and every one of those uses stays valid. Body:

1. `const peers = await this.node.peerStore.all()`.
2. **Synchronously**, before any per-peer await: rebuild `addressKnown` from `peers` via the shared reconcile step (section 4).
3. Per peer: the creation helper, `classifyByProtocols`, and `adoptPeerRecord` when the entry holds none (unchanged rules).
4. Upsert self, label `member`.

### 3. The backstop walk

A time-driven re-read that **only reconciles `addressKnown`** — no entry creation, no classification, no record adoption. Those three only ever change through `patch`/`merge`/`consumePeerRecord`, which always fire `peer:update`; only the address set has silent changes. Not re-creating entries is what makes eviction stick (below).

- Cadence: `PEERSTORE_BACKSTOP_INTERVAL_MS = 300_000` (5 min), a mutable `private static` like the other tick constants so specs can shrink it. Rationale: libp2p's silent address aging runs on a 1 h clock, so 5 min adds at most ~8% to that staleness, and the cost falls to 1/200 of today's at the passive 1.5 s cadence.
- Driven from the pass: extract the loop's pass body into a private method (e.g. `runStabilizationPass()`) that runs the backstop when `Date.now() - lastPeerStoreWalkAt >= PEERSTORE_BACKSTOP_INTERVAL_MS`, then `stabilizeOnce()`. `lastPeerStoreWalkAt` is set by both the start walk and the backstop. The `startStabilizationLoop` closure calls the method; first-pass `ready()` resolution stays in the closure. Being on the pass, it inherits the loop's lifecycle (run generation, `stop()`). Under `stabilize-idle-backoff` the pass is at most one backed-off interval late, which is fine against an hour-scale clock.
- Not a primary path: document it as the backstop for `delete`, address aging and peer expiry, not for missed events.

### 4. Shared reconcile step — event wins

Both walks rebuild `addressKnown` wholesale from their `peers` array (self-pruning, as today). The existing `NOTE:` about wholesale replacement clobbering a concurrent `setAddressKnown` is resolved rather than carried forward: before `await peerStore.all()`, open a "touched during walk" set; `setAddressKnown` adds the id to it while it is open; after `all()` resolves, build the new set from `peers`, then for each touched id copy its *current* membership in `addressKnown` over the walk's answer (the event is at least as new as the snapshot), swap, and close the set. Everything after the `all()` await is synchronous, so that await is the only window. `refreshAddressKnown`'s NotFound arm currently does `this.addressKnown.delete(id)` directly — route it through `setAddressKnown(id, false)` so every write is captured. Concurrent walks (a host-driven `seedFromPeerStore` during a backstop) are not expected; if both can be open, use a counter or per-walk set rather than a single field — implementer's call, state it at the site.

### 5. Bootstraps: parsed once, seeded once per run, no per-pass re-add

- Parse `cfg.bootstraps.slice(0, 8)` into peer ids once, in the constructor (the config is static for the life of the service); log an unparseable entry once there. Keep the existing parsing (multiaddr `p2p` component, else a bare id).
- `seedFromBootstraps()` (keep the name — `per-tick-hotpath.spec.ts` calls it) runs once in `start()`, after the start walk and before `start()`'s `enforceCapacity`, hashing each id (≤ 8 SHA-256 per start) and calling `noteDiscovered` as today. Not called from the pass.
- The per-pass re-add is **not wanted**: a bootstrap is only ever removed from the table by capacity eviction, which happens only when 2048 better-scored peers are present — exactly when the bootstrap is not needed. Re-adding it every pass just to evict it again at the end of phase 1 is churn. A bootstrap libp2p is connected to is re-admitted by `peer:connect` anyway.

### Eviction now sticks

An evicted peer that libp2p still holds is no longer re-created 1.5 s later. It comes back only on fresh evidence: its next `peer:update` (a genuine peerStore change), `peer:connect`, an inbound RPC, or being named in a snapshot. State this in the docs (*Relevance scoring and table management*, near the eviction bullets).

### Capacity enforcement of event-driven inserts

Inserts from the listeners land between passes and are trimmed by the **next pass's** single `enforceCapacity` (end of phase 1). Do not call `enforceCapacity` from a listener: two enforcements running concurrently over-evict (the existing rule). The overshoot is bounded by how many first-time peerStore merges arrive in one pass interval; the dominant source, `FretPeerDiscovery`, is rate-capped at 20 per 5 s and emits peers already in our table (a `getById` hit, so no insert at all). Update the *Two phases* sentence in `docs/fret.md` that names `seedFromPeerStore` / `seedFromBootstraps` as the tick's inserts to say who owns enforcement for each insert source now: the tick for listener inserts and snapshot merges, `start()` for its walk and the bootstrap seed.

### Side effect worth recording: the `classifyByProtocols` NOTE

That `NOTE:` says the per-tick walk re-applies a stale-positive protocol list every tick, resetting the negotiate-failure run so a peer that stops serving this network can never demote to `foreign` on a deployment without `identifyPush`. With the walk gone, the list is re-applied only on a real peerStore change (libp2p's `merge` of an unchanged protocol list fires nothing) and once at `start()`, so the run can now accumulate. Rewrite the NOTE to say so (and that the backstop deliberately does not classify, which is what keeps it that way). Update the explanatory comment above the service-only-outage block in `test/failure-recovery.spec.ts` to match; the test itself stays as it is (identify nodes are still the realistic rig). Do not add a test for the memory-node demotion.

## Edge cases & interactions

- **Departed peers.** A leave notice marks the peer `dead`; nothing in the event path touches `state` (the helper leaves an existing entry alone; classification touches only `membership`). Verified by `test/address-less-departure.spec.ts` staying green **unchanged** — its `tick()` helper calls `seedFromPeerStore` + `stabilizeOnce`, which remains a valid composition — plus inspection of the listener. The docs' *Leave* paragraph and the comments near `fret-service.ts` ~2085 and ~2927 describe "the next tick's `seedFromPeerStore` re-created the entry"; restate as history ("used to") and name what can still deliver a `peer:update` for a departed peer (any peerStore change), which `dead` survives. The docs' pointer "against a started receiver whose next tick re-seeds from the peerStore" needs the same restatement.
- **Silent address loss.** Address aging / `delete` / expiry leave a peer reading dialable for at most `PEERSTORE_BACKSTOP_INTERVAL_MS` beyond libp2p's own clock. The cost of that window is one dial that fails `NoValidAddressesError`, which is a failed contact like any other. By inspection; `test/dialability.spec.ts`'s existing delete-then-`seedFromPeerStore` case keeps covering the reconcile logic (it runs through the shared step).
- **Event racing a walk.** Covered by the event-wins rule (section 4). By inspection; no test (the window is one `await`, not deterministically drivable without mocking the peerStore, which the testing rules forbid).
- **Listeners before the start walk.** A `peer:update` fired during `start()` is no longer lost. The membership-identify poll-path test (`classifies from the peerStore poll path at start…`) still passes — no event fires after A starts — but its comment says the walk runs "BEFORE it attaches any node event listener"; reword it to "before any event could have fired".
- **`stop()` → `start()`.** A restart re-runs the start walk and the bootstrap seed and resets `lastPeerStoreWalkAt`; a backstop timer does not exist separately (it rides the pass), so nothing new to cancel. Close any open touched-set in `stop()` or make the walk tolerate it — by inspection.
- **`importTable` after `start()`.** It replaces entries outright, membership included; previously the next tick's walk re-classified peerStore-known peers. Now a replaced entry keeps the file's label until its next `peer:update` or the classification probe. Acceptable (the probe pass resolves `unknown` within a tick); `importTable` already re-syncs addresses through `consumeImportedAddressRecords` / `adoptStoredPeerRecord`. The comment at ~4030 and the docs line in *A snapshot never speaks for self* ("would heal on the next stabilization tick's peer-store re-seed") should drop the re-seed claim.
- **Discovery feedback loop / event storm.** `FretPeerDiscovery` emissions are of peers already in our table, so each first-time peerStore merge fires one `peer:update` whose handler hits `getById`, classifies an empty protocol list (no-op) and sets address-known false (correct — the emission carries no addresses). Bounded by the emission rate (4/s). By inspection.
- **Concurrency with phase-1 merges.** Both create through `noteDiscovered`, whose check-then-insert is synchronous; the store holds one entry per id. By inspection.
- **Self.** Upserted and labelled `member` once per `start()`. `importTable` never writes self; eviction protects it. By inspection.

## Tests

- **New (the ticket's success measure)** in `test/per-tick-hotpath.spec.ts`: spy on `node.peerStore.all` (wrap the real method and count). After `seedFromPeerStore()` (count 1), drive `runStabilizationPass()` several times → the count stays 1 and `seedFromBootstraps` is not reached (spy on it or assert no new `noteDiscovered`). Then rewind `lastPeerStoreWalkAt` past `PEERSTORE_BACKSTOP_INTERVAL_MS` (or shrink the static) and run one pass → count 2. Use the file's existing short-tick-budget setup.
- **Rework** `per-tick-hotpath.spec.ts`: its `cycle()` helper mirrors the old pass body (`seedFromPeerStore` → `seedFromBootstraps` → `stabilizeOnce`). Make it call `runStabilizationPass()`. The two coordinate-reuse cases (a) are about the walk's hash-on-miss rule, which now lives in the start walk — have them call `seedFromPeerStore()` directly instead of `cycle()` (the "never seen" case would otherwise find no entry, correctly). Update the file header's description of the pass body. The capacity-enforcement cases (c) should keep passing; adjust if any relied on the pass seeding.
- Nothing else new. Run the full suite (`yarn test` from `packages/fret`); specs that call `seedFromPeerStore` directly should pass unchanged. Any spec that started a service and relied on the next tick to pick up a later `peerStore.merge` is now served by `peer:update` — if one fails, it is relying on the removed behavior; fix the spec, not the design.

## Docs (`docs/fret.md`)

- *Dialability*: the bullet "rebuilt wholesale from the `peerStore.all()` walk the stabilization tick already performs" → event-maintained, rebuilt at `start()` and by the 5-min backstop for the silent libp2p changes (name them).
- *Evidence strength*, peerStore-protocols bullet: "start-time / per-tick seed poll" → start-time walk only; events thereafter.
- *Relevance scoring*: add peerStore events to the creation sites (hearsay baseline), and the eviction-sticks statement.
- *Two phases*: enforcement ownership sentence (above).
- *Leave*: re-seed history wording (above).
- *Mirroring libp2p's own records*: still accurate (start walk covers pre-start identify); check wording.
- *Ring membership* "Labels are durable across the network-agnostic re-seeds…" and "an evicted foreign peer is just re-added by the next connect/seed": reword — re-added by its next connect or `peer:update`.
- *A snapshot never speaks for self*: drop "would heal on the next stabilization tick's peer-store re-seed".
- Update the `addressKnown` field doc and remove both stale `NOTE:`s at `seedFromPeerStore` (re-enumeration cost; wholesale-swap clobber), replacing them with one `NOTE:` at the backstop constant: why 5 min, and "if libp2p ever emits an event for deletion/aging, the backstop can go".

## TODO

- Add the creation helper; use it from `peer:update`, `peer:identify` and the start walk (via `noteDiscovered`).
- Add the touched-during-walk mechanism to `setAddressKnown`; route `refreshAddressKnown`'s NotFound arm through it; add the shared reconcile step.
- Reshape `seedFromPeerStore` (address reconcile synchronously after `all()`, then per-peer create/classify/adopt, then self); add the address-only backstop method and `PEERSTORE_BACKSTOP_INTERVAL_MS` / `lastPeerStoreWalkAt`.
- Parse bootstraps in the constructor; `seedFromBootstraps` seeds from the parsed ids; call it once from `start()` before `enforceCapacity`.
- In `start()`: attach `peer:update` / `peer:identify` listeners before the walk; walk → bootstrap seed → `enforceCapacity`.
- Extract `runStabilizationPass()` (backstop-if-due, `stabilizeOnce`); the loop closure calls it.
- Rewrite the `classifyByProtocols` NOTE and the stale comments (~2085, ~2541, ~2927, ~4030, `addressKnown` field doc).
- Tests: new spy case; rework `per-tick-hotpath.spec.ts` `cycle()` and (a) cases; comment updates in `membership-identify.spec.ts` and `failure-recovery.spec.ts`.
- Docs updates listed above.
- `npx tsc --noEmit` and `yarn test` from `packages/fret`.
