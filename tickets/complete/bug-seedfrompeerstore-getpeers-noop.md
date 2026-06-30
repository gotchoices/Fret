----
description: A start-up/maintenance routine meant to learn about already-known peers was calling a method that doesn't exist, so it silently did nothing; it now enumerates peers correctly and the regression test is un-skipped.
prereq:
files:
  - packages/fret/src/service/fret-service.ts (seedFromPeerStore ~786-826; classifyByProtocols ~287-292)
  - packages/fret/test/membership-identify.spec.ts (un-skipped "classifies from the peerStore poll path at start" ~133)
  - packages/fret/test/helpers/libp2p.ts (createIdentifyNode doc comment ~38)
  - docs/fret.md (Ring membership → "peerStore protocols" bullet)
difficulty: medium
----

# Complete: `seedFromPeerStore` enumerates via `peerStore.all()`

## What the change did

`seedFromPeerStore` enumerated peers with the non-existent `peerStore.getPeers()` (that method
lives on the libp2p **node**, not the `PeerStore`; the enumerator is `all()`). A permissive
hand-written `WithPeerStore` interface declared the absent method optional, so the optional call
compiled, short-circuited to `undefined`, `?? []` yielded `[]`, and the per-peer upsert/classify
loop was a silent no-op — only the trailing self-upsert ran. The fix:

- Enumerate with `const peers = await this.node.peerStore.all()` (properly typed off `Libp2p`, no cast).
- Classify each still-`unknown` entry directly via `classifyByProtocols(pidStr, p.protocols)` off the
  same `Peer` record (no second `peerStore.get` round-trip).
- Delete the dead `WithPeerStore` interface and the now-callerless `classifyFromPeerStore` method.
- Un-skip the `peerStore poll path at start` regression test and repoint stale comments
  (test file + `helpers/libp2p.ts`).
- Update `fret.md`'s "peerStore protocols" bullet to credit the start-time/per-tick seed poll.

## Review findings

Adversarial pass over the implement diff (`c5eb4a0`) with fresh eyes before reading the handoff.

**Scope checked:** correctness of the enumeration/typing, the classification guard, the discovery
emission path (foreign/unknown leak + per-tick spam), `start()` ordering vs the test's isolation
premise, residual stale references across the tree, docs accuracy, and the full test matrix
(happy path / edge / regression).

- **Correctness — CONFIRMED OK.** `peerStore.all()` is the correct typed enumerator; `classifyByProtocols`
  keeps its `membership === 'unknown'` guard, so already-classified peers are untouched. Foreign→member
  re-admission is correctly left to the `peer:update` listener and the foreign re-probe pass (both
  documented), not this poll — the `=== 'unknown'` guard intentionally does not re-classify `foreign`
  here, and that is by design, not a miss.
- **Discovery leak (the handoff's "confirm not a double-emit") — CONFIRMED OK.** `emitDiscovered`
  (fret-service.ts ~1157) is member-scoped internally (`membership !== 'member'` → skip) and
  TTL-deduped via `announcedIds`, so the now-live `discovered` accumulation cannot surface
  foreign/unknown peers to libp2p discovery, and cannot spam per-tick — only ids *absent* from the
  store are pushed, so after the first tick the delta is empty for known peers. Self-emission to
  `peer:discovery` is unchanged pre-existing behavior (the self block always ran), not a regression.
- **`start()` ordering — CONFIRMED OK.** `await this.seedFromPeerStore()` (line 296) precedes every
  `addNodeListener` call (302+), so the un-skipped test's "poll is the only thing that could have
  classified" isolation premise genuinely holds.
- **Type safety / dead code — CONFIRMED OK.** No `any` introduced; the cast and the redundant
  `peerStore.get` round-trip are gone. No stale `classifyFromPeerStore` / `WithPeerStore` /
  `getPeers` references remain in source or test — the only hits are in ticket archives
  (`tickets/complete/*`), which are historical and correctly left untouched.
- **Docs — CONFIRMED OK.** The `fret.md` "peerStore protocols" bullet now accurately describes
  `peerStore.all()` enumeration + per-entry protocol classification, matching the code.

**Minor findings (fixed in this pass):** none.

**Major findings (new tickets):** none.

**Tripwire (recorded, not ticketed):** the per-tick re-enumeration cost — this loop re-enumerates
the whole peerStore and SHA-256-hashes each peer's id every stabilization tick (1.5s passive /
300ms active), not just at `start()`. It is parked as a `NOTE:` at the enumeration site
(fret-service.ts ~789). The handoff flagged this as "worth a second look at whether per-tick is
wanted"; on review it is **intended, not accidental**: the call site (`startStabilizationLoop →
seedFromPeerStore`) was already per-tick before this fix (merely dead), `fret.md` documents the
"start-time / per-tick seed poll" as a real classification trigger, and the already-landed
`bug-upsert-resets-peer-stats-each-tick` makes re-seeding stats-preserving and therefore safe. No
action needed; the NOTE captures the gate-on-epoch / reuse-stored-coord remedy if it ever shows up
as hot.

**Test coverage assessment:** the un-skipped `membership-identify.spec.ts` test pins the start-time
poll path in isolation (real TCP+identify nodes, FretService probing stubbed, synchronous assertion
after `start()` with `pingsSent === 0`) — it is a precise regression witness that fails against the
old `getPeers()` code and passes against the fix. Per-tick re-enumeration is not separately pinned;
this was judged acceptable (the behavior is the documented existing design and exercised indirectly
by the full suite), not worth an added test.

## Validation performed (all green)

From `packages/fret/`:
- `npx tsc --noEmit` → exit 0.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/membership-identify.spec.ts" --timeout 30000` → 3 passing (incl. the un-skipped one).
- `yarn test` → **262 passing**, 0 failing, 0 pending/skipped.
