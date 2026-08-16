---
description: FRET used to announce newly found peers to libp2p from three different places, one of which leaked peers belonging to a different network — and none of which libp2p actually listened to. All three are now one path, and it is properly connected and proven to reach libp2p's peer store.
files: packages/fret/src/service/peer-discovery.ts, packages/fret/src/service/libp2p-fret-service.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/index.ts, packages/fret/test/peer-discovery.spec.ts, packages/fret/test/profile.behavior.spec.ts, docs/fret.md
difficulty: medium
---

## What landed

Three emission paths collapsed to one, and that one wired into libp2p for the first time.

**Deleted**
- `packages/fret/src/service/discovery.ts` (whole file — `seedDiscovery`, the unfiltered path
  that dispatched *every* store entry including foreign and dead ones), its `export` from
  `src/index.ts`, and its call in `Libp2pFretService.start()`.
- `FretService.emitDiscovered` and everything it owned: the `announcedIds` debounce map, the
  `bucketDiscovery` token bucket, the now-unused `PeerInfo` type import, and its four call sites.

**Reworked — `FretPeerDiscovery` (`peer-discovery.ts`)**
- Constructor input widened from `DigitreeStore` to
  `FretPeerDiscoveryInput = DigitreeStore | (() => DiscoverySnapshotSource | null)`, where
  `DiscoverySnapshotSource` is `{ store, selfId }`. Resolved at the top of every `scan`, not
  captured — libp2p reads `peerDiscoverySymbol` off a service while *constructing* the node,
  which is before the node (and therefore the store) exists.
- A thunk returning `null` means "not ready": the tick no-ops and the interval stays armed. A
  thunk that throws is caught and logged with the same result.
- Self filter: an entry whose id equals the resolved `selfId` is skipped, so libp2p never logs
  "discovery mechanism discovered self". A bare-store input has no self id and emits every
  matching entry, unchanged.
- `NOTE:` tripwires at `scan` (batch drain rate) and at the emission site (empty multiaddrs).

**Reworked — `Libp2pFretService`**
- Builds the single `FretPeerDiscovery` in its constructor with a lazy thunk; `getPeerDiscovery()`
  returns that same instance.
- New `get [peerDiscoverySymbol]()` — the fix that makes FRET discovery reach libp2p at all. The
  node reads that symbol during construction and subscribes to the object's `peer` event. The two
  deleted paths dispatched `peer:discovery` at the node object, which only reaches application
  listeners; libp2p forwards internal → node, never node → internal.
- `start()` keeps `core.start()` → `discovery.start()` ordering so the first scan sees a
  peerStore-seeded table.

## Review findings

### Read first, then the handoff

Reviewed the implement diff (`2a16363`) before the handoff summary, and verified the central
mechanism against the installed libp2p (3.1.3) rather than taking the ticket's word for it:
`node_modules/libp2p/dist/src/libp2p.js:157-162` reads `service[peerDiscoverySymbol]` during
construction and subscribes to `peer`; `:323-333` (`#onDiscoveryPeer`) rejects self and calls
`peerStore.merge(id, { multiaddrs })`; `:81-89` re-dispatches `peer:discovery` on the node when a
merge creates a peer that had no previous record. All three claims hold.

### Fixed in this pass (minor)

- **Docs overstated what the wiring buys.** `docs/fret.md` said the merge feeds "the peerStore
  (and so into the auto-dialer)", and the `FretPeerDiscovery` class docstring said the same.
  libp2p v3.1.3 has no auto-dialer — `connection-manager/` contains only `reconnect-queue.js`,
  which reconnects peers tagged `KEEP_ALIVE` — and the emitted `PeerInfo` carries no multiaddrs,
  so an emission can never cause a dial. Both sites now state precisely what it does buy: the
  peerStore entry for a peer libp2p had never heard of, plus the node-level `peer:discovery`
  re-dispatch for application listeners, plus the member/non-dead/non-self filtering. Reachability
  needs address hints on the wire, which is the already-open backlog ticket.
- **Added the end-to-end test the handoff flagged as missing** — the claim the whole ticket rests
  on was argued from libp2p's source, not from a test. `test/peer-discovery.spec.ts` now has
  *a symbol-registered service lands emitted members in libp2p's own peerStore*: it registers FRET
  the way an application would (`createLibp2p({ services: { fret: fretService(...) } })`), imports
  a routing table holding one `member` and one `foreign` peer, starts the node, and polls
  `node.peerStore.has`. The member arrives; the foreign peer never does. Targeted run: 17 passing.

### Recorded as a tripwire, not a ticket

- Discovery emission now writes address-less entries into libp2p's peerStore, so
  `seedFromPeerStore`'s per-tick `peerStore.all()` + SHA-256 loop is partly fed by FRET's own
  output. Still bounded — the emissions come from the FRET store, which is capped at C=2048 — so
  the existing sizing argument holds. Parked as a `NOTE:` appended to the pre-existing
  `seedFromPeerStore` NOTE in `fret-service.ts`, which already owns this concern.

### Major — appended to existing tickets rather than filed fresh

Both sites were already claimed by open plan tickets, so these are arms on those, not new tickets.

- **`tickets/plan/21-libp2p-fret-service-cleanup.md`** — its "dead `components` input" bullet is
  now a functional blocker, not tidiness, and I verified it by running it. Registering FRET the
  obvious way, `createLibp2p({ services: { fret: fretService() } })`, **fails**: libp2p starts
  every service during `node.start()`, and `Libp2pFretService.start()` throws
  `"Libp2pFretService: libp2p node not injected"` because nothing ever set the node. The only
  working shape is `start: false` → `setLibp2p(node)` → `await node.start()`, which is
  undocumented. Also recorded there: libp2p v3.1.3 exposes no `libp2p` component, so that
  ticket's proposed `components.libp2p` fix is not literally available and the arm has a real
  decision in it. The new test above uses the working shape and should be simplified once it lands.
- **`tickets/plan/6-map-capacity-bounds.md`** — its first bullet named `FretService.announcedIds`,
  which this ticket deleted, so the ticket was pointing at code that no longer exists. Retargeted
  to `FretPeerDiscovery.emitted`, which has the identical shape (same 4096 threshold, same
  expired-only prune), and added `peer-discovery.ts` to its `files:`.

### Checked and clean — no action

- **`announceToNewPeers` survived**, the one thing the handoff called easy to break. Both
  `detach(this.announceToNewPeers(...))` call sites are intact (`fret-service.ts:1231, 1527`); the
  `discovered` / `announced` delta arrays were removed only where nothing else read them.
- **No dangling references** to `seedDiscovery`, `emitDiscovered`, `bucketDiscovery`, or
  `service/discovery` anywhere in tracked source. The only hits are in `packages/fret/dist/`
  (gitignored build output) and in ticket prose.
- **The private-field cast in the restored-table test is not the silent hazard the handoff
  feared.** `(svc as unknown as { inner: CoreFretService }).inner.getStore()` — if `inner` is
  renamed, the expression is `undefined` and `.getStore()` throws a TypeError, so the test fails
  loudly rather than silently passing. Left as is; a test accessor would widen the public surface
  to buy nothing.
- **No membership feedback loop.** Emission → `peerStore.merge` → `peer:update` → FRET's
  `classifyByProtocols` is safe: a merged entry carries no protocols, an empty protocol list is
  explicitly left alone, and the demote arm only fires from `unknown`.
- **Lifecycle.** `discovery.start()` is guarded by `running`; `stop()` clears the timer and the
  debounce map; `Libp2pFretService.stop()` no longer needs its optional chain now that the
  instance always exists. Reading `peerDiscoverySymbol` pre-injection is side-effect free.
- **Accepted tradeoffs left alone.** The empty-multiaddr `NOTE:` at the emission site is a
  decided design point with an open backlog ticket
  (`feat-address-hints-in-neighbor-exchange`); its stated condition (address hints on the wire)
  has not tripped, so it was not re-filed. Same for the batch-drain-rate `NOTE:`.
- **`docs/review.html`** still names `seedDiscovery`. It is a 54 KB tracked snapshot of an earlier
  review, dated by nature rather than live documentation, so it was deliberately left alone.
- **Behavior change accepted in planning** — a peer already `member` when re-learned emits up to
  `emissionIntervalMs` (5 s) later than before. Judged not worth pinning with a test: a freshly
  learned peer is `unknown`, and the deleted path skipped `unknown` peers anyway.

### Validation

There is no lint step in this repo — `AGENTS.md` records that `yarn format` is forbidden (no
prettier config, it would rewrite every file against the house tab style) and that
`yarn check` (typecheck + build + test) is the gate.

- `npx tsc --noEmit` — clean.
- `yarn build` — clean.
- `mocha "test/peer-discovery.spec.ts"` — 17 passing (was 16; +1 added here).
- `yarn test` (full suite) run twice: **436 passing / 2 failing**, then **437 passing / 1 failing**
  — with a *different* set of failures each time. Every failing test passes when run alone.

  None are in this diff, and this review pass changed no runtime behavior at all (comments in
  `src/`, prose in `docs/`, one added test). The three are `dedup-cache.spec.ts:86`,
  `simulation.spec.ts`'s churn case, and `dialability.spec.ts:222` — all assert against wall-clock
  timers with margins under 2×, so they fail whenever the machine is loaded enough to overshoot a
  `setTimeout`. Written up as one class in `tickets/.pre-existing-error.md` for the triage pass;
  nothing was skipped, disabled, or loosened.
