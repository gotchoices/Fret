----
description: Every routing-table refresh wipes a known peer's accumulated quality stats (relevance, success/failure history, latency) back to zero, so those scores never build up over time and the table's "keep the good peers, drop the bad ones" logic works off near-empty data.
prereq:
files:
  - packages/fret/src/store/digitree-store.ts (upsert rebuilds an existing entry from defaults — the fix site)
  - packages/fret/src/service/fret-service.ts (seedFromPeerStore upserts every peerStore peer every stabilization tick)
  - packages/fret/test/ring-membership.spec.ts (mirror "preserves membership across a re-upsert" for stats)
  - docs/fret.md (Ring membership section: "upsert preserves an existing entry's membership" — extend to all mutable stats)
difficulty: easy
----

# `upsert` clobbers relevance / health / state on every stabilization tick

## Confirmed reproduction

`DigitreeStore.upsert(id, coord)` (`digitree-store.ts:83`) is **create-or-replace**:
when an entry already exists it deletes it and rebuilds a fresh one from defaults
(`relevance: 0, accessCount: 0, successCount: 0, failureCount: 0, avgLatencyMs: 0,
state: 'disconnected'`). As of the `ring-membership-classification` ticket it carries
`membership` forward, but nothing else.

Reproduced directly against the store (throwaway spec, run + deleted):

```
s.upsert('id1', coord)
s.update('id1', { relevance: 0.9, successCount: 5, failureCount: 1,
                  accessCount: 7, avgLatencyMs: 42, state: 'connected' })
s.upsert('id1', coord)            // simulate a per-tick re-seed
// → { relevance:0, successCount:0, failureCount:0, accessCount:0,
//     avgLatencyMs:0, state:'disconnected' }   ← all wiped
```

## Why it fires every tick

The stabilization loop calls `seedFromPeerStore()` on every tick (passive 1.5s,
active 300ms). That method calls `this.store.upsert(pidStr, coord)`
**unconditionally** for every peer in the libp2p peerStore (`fret-service.ts:813`) —
not just newly-discovered ones — so each peerStore-known peer's relevance and health
counters are reset to zero roughly once per tick. Several other paths also re-seed
unconditionally (announce-snapshot merge ~766/778/789, neighbor-snapshot merge
~1047/1058, `peer:connect` ~331, routing-hint ~1594), but the per-tick re-seed is the
dominant clobber.

## Why it matters

Relevance scoring (success/failure ratio, RTT, access recency/frequency, sparsity
bonus — see `store/relevance.ts`) drives **eviction victim selection** when the table
is over capacity and **next-hop routing cost** (`linkQuality` / health terms). With
the counters wiped each tick, a peer's scores can only ever reflect activity within
the *current* tick; any peer not actively probed that tick carries `relevance: 0`. The
documented "distance-balanced, health-aware cache" never accumulates the signal it is
designed around.

`state` is also reset to `'disconnected'` each tick, but that is cosmetic:
`isConnected()` reads `node.getConnections()` directly, not the stored field. The
substantive damage is to relevance/health. (Still worth preserving `state` for
correctness/consistency — see below.)

## Cause and fix

`upsert`'s contract should be **ensure-an-entry-exists**, not **reset-to-defaults**.
The coord is a deterministic hash of the peer id, so for an existing peer it never
actually changes — an existing entry's coord/key are stable. The fix is to make
`upsert` preserve an existing entry's mutable stats the same way it already preserves
`membership`: on a hit, carry the prior entry forward and only refresh
`coord`/`lastAccess`; build from defaults only for a genuinely new id.

Preferred fix is in `upsert` itself (not `seedFromPeerStore`), because all of the
unconditional callers above want preservation and none rely on zeroing:

- The `getById(id) ?? upsert(id, coord)` callers (`applyTouch`/`applySuccess`/
  `applyFailure` at 232/243/259, and 364/375/1593) never call `upsert` on an existing
  entry, so they are unaffected either way.
- The unconditional callers (seed, snapshot merges, `peer:connect`, routing hint) all
  immediately follow with `applyTouch`/`setState`, i.e. they expect the entry to keep
  accumulating — none want a reset.
- `importTable` uses `insert`, not `upsert`, so persistence is unaffected.

Handle the coord-changed case defensively even though it shouldn't occur in practice
(coord is hash-derived): if the recomputed coord differs from the stored one the BTree
key changes, so delete + re-insert rather than `updateAt` in place — mirror the
existing re-key handling in `DigitreeStore.update` (`digitree-store.ts:116`).

## TODO

- In `digitree-store.ts` `upsert`: on an existing entry (`prevKey` hit), preserve the
  full prior entry (relevance, accessCount, successCount, failureCount, avgLatencyMs,
  state, membership, metadata) and only update `coord` + `lastAccess: now`. Keep the
  default-everything path for a new id. Replace the comment that currently explains
  only membership preservation with one covering all mutable stats.
  - If the recomputed coord differs from the stored coord, delete the old path and
    `insert` the re-keyed entry (re-key safety); otherwise `updateAt` in place.
- Regression test in `test/ring-membership.spec.ts`, mirroring the existing
  "preserves membership across a re-upsert" test: upsert an id, `update` it to non-zero
  relevance + counters (or score it via the relevance helpers), upsert the same id
  again, assert relevance/successCount/failureCount/accessCount/avgLatencyMs/state all
  survive. Add a companion assertion that a brand-new id still defaults to
  `relevance: 0` / zeroed counters / `state: 'disconnected'`.
- Update `docs/fret.md` (Ring membership section, the line "Labels are durable across
  the network-agnostic re-seeds (`upsert` preserves an existing entry's membership)"):
  broaden to state that `upsert` preserves an existing entry's full mutable state
  (relevance, health counters, state, membership) and only refreshes coord/lastAccess —
  rebuilding from defaults only for a new peer.
- Validate: `cd packages/fret && npx tsc --noEmit` and
  `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/ring-membership.spec.ts" --timeout 30000`.
  Run the full `yarn test` once green to confirm no caller depended on the old
  zeroing behavior.
