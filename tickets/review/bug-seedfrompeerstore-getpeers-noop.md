----
description: A start-up/maintenance routine meant to learn about already-known peers was calling a method that doesn't exist, so it silently did nothing; it now enumerates peers correctly and the regression test is un-skipped.
prereq:
files:
  - packages/fret/src/service/fret-service.ts (seedFromPeerStore ~786-821; classifyByProtocols ~283-288)
  - packages/fret/test/membership-identify.spec.ts (un-skipped "classifies from the peerStore poll path at start" ~133)
  - packages/fret/test/helpers/libp2p.ts (createIdentifyNode doc comment ~38)
  - docs/fret.md (Ring membership → "peerStore protocols" bullet)
difficulty: medium
----

# Review: `seedFromPeerStore` now enumerates via `peerStore.all()`

## What was wrong

`seedFromPeerStore` enumerated peers with `(this.node as WithPeerStore).peerStore?.getPeers?.() ?? []`.
`PeerStore` has no `getPeers()` (that method lives on the libp2p **node** and returns connected
peer ids, not store entries). The optional call short-circuited to `undefined`, `?? []` yielded
`[]`, and the entire per-peer loop body (upsert / classify) never ran with real libp2p. The bug
was masked by a hand-written `WithPeerStore` interface that declared the absent method as optional,
so the compiler accepted it. Only the trailing self-upsert block did anything.

This is a runtime no-op, not a crash — classification still happened via the `peer:identify` /
`peer:update` event listeners and the stabilization probe pass, which is why it went unnoticed in
production. The dead path was the *start-time* poll: a peer whose `identify` completed before this
service started had to wait for an event or an outbound probe instead of being labelled at `start()`.

## What changed

- **Enumeration fixed**: `seedFromPeerStore` now does `const peers = await this.node.peerStore.all()`
  (`peerStore.all()` is the real `PeerStore` enumerator, returning all *known* peers — including
  not-currently-connected ones — which is the right set for opportunistic seeding/classification).
  `this.node` is already typed `Libp2p`, so `peerStore.all()` is properly typed; no cast.
- **Classify off the same record**: each `Peer` carries `.id` and `.protocols`, so a still-`unknown`
  entry is classified directly via the existing `classifyByProtocols(pidStr, p.protocols)` — no
  second `peerStore.get` round-trip. The `membership === 'unknown'` guard is kept, so an
  already-classified peer is left alone.
- **Removed dead/over-defensive code**: the `WithPeerStore` interface and the now-callerless
  `classifyFromPeerStore` method (which did the redundant `peerStore.get` round-trip) are deleted.
- **`async` is fine**: `seedFromPeerStore` already runs inside the awaited stabilization tick and at
  `start()` (awaited before any node event listener attaches), so the added `await` on `all()` is safe.
- **Docs**: `fret.md`'s "peerStore protocols" bullet now notes the start-time/per-tick seed poll as a
  real classification trigger (previously it only credited the `peer:identify`/`peer:update` events).
- **Stale comments**: three `classifyFromPeerStore` references in the test file + `helpers/libp2p.ts`
  doc comment were repointed to describe the `peerStore.all()` poll, since that method no longer exists.

## Regression guard (the un-skipped test)

`membership-identify.spec.ts` → `it('classifies from the peerStore poll path at start, before any
event listener fires (no probe)')` was `it.skip` with a `SKIPPED:` paragraph explaining the bug;
both are now live. The test pins the poll path *in isolation*:
- C (a real TCP+identify node) serves `net-a`; A dials C and waits until A's peerStore has learned
  C's `net-a` protocols via libp2p identify — all while A has **no FretService**, so no FRET event
  listener or probe is in play.
- A's `FretService` is then started with probing stubbed out (`disableProbing`). `start()` awaits
  `seedFromPeerStore` before attaching listeners, so the poll is the only thing that can classify.
- Asserts **synchronously** after `start()` resolves: C is `member`, and `getDiagnostics().pingsSent
  === 0` (public-API witness that no outbound probe fired).

This test fails against the old `getPeers()` code (loop sees `[]`, C stays `unknown`) and passes
against the fix — it is the precise regression witness.

## Validation performed (all green)

From `packages/fret/`:
- `npx tsc --noEmit` → exit 0.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/membership-identify.spec.ts" --timeout 30000` → 3 passing (all three, including the un-skipped one).
- `yarn test` → **262 passing**, 0 failing, 0 pending/skipped.

## Reviewer: where to look / known gaps & risks

- **Per-tick cost (tripwire, parked as a `NOTE:` at the enumeration site, fret-service.ts ~788).**
  This loop was previously dead; it now re-enumerates the *whole* peerStore and SHA-256-hashes each
  peer's id **every stabilization tick** (1.5s passive / 300ms active), not just at `start()`. The
  sibling fix `bug-upsert-resets-peer-stats-each-tick` (already landed) means `upsert` preserves
  relevance/health/state/membership on a hit, so re-seeding does **not** zero stats — it is correct,
  just not free. Fine at C=2048; the NOTE suggests gating re-seed on a peerStore change/epoch or
  reusing the stored coord for ids already present if it ever shows up as hot. **Worth a second look
  at whether the per-tick re-seed (vs start-only) is actually wanted** — it was de-facto start-only
  before because the loop was dead, so the tick-cadence behavior is *new* even though the call site
  is unchanged.
- **`emitDiscovered` now fires real ids.** `discovered` accumulates ids not already in the store;
  previously always `[]` from this path. Newly-known (member) peers can now be emitted to libp2p
  discovery from the seed poll. Confirm that's desirable and not a double-emit with other paths
  (discovery is member-only and debounced per fret.md, and the full suite is green, but the
  interaction is worth a glance).
- **No new test for the per-tick re-seed behavior** specifically — the un-skipped test covers the
  start-time poll only. If the reviewer considers per-tick re-enumeration a behavior worth pinning,
  that's a candidate for an added test.
- **Self-upsert block, `enforceCapacity`, `emitDiscovered(discovered)` were left as-is** per ticket.

No new tickets warranted from the implement pass; the only conditional concern is the tripwire above.
