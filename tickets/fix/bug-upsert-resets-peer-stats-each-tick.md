----
description: Every routing-table refresh wipes a known peer's accumulated quality stats (relevance, success/failure history, latency) back to zero, so those scores never build up over time and the table's "keep the good peers, drop the bad ones" logic works off near-empty data.
prereq:
files:
  - packages/fret/src/store/digitree-store.ts (upsert rebuilds the entry from defaults)
  - packages/fret/src/service/fret-service.ts (seedFromPeerStore upserts every peerStore peer every stabilization tick; startStabilizationLoop tick)
difficulty: medium
----

# `upsert` clobbers relevance / health / state on every stabilization tick

## What's wrong

`DigitreeStore.upsert(id, coord)` is **create-or-replace**: when an entry already
exists it deletes it and rebuilds a fresh one from defaults —
`relevance: 0, accessCount: 0, successCount: 0, failureCount: 0, avgLatencyMs: 0,
state: 'disconnected'`. (As of the `ring-membership-classification` ticket it now
*preserves* `membership`, but nothing else.)

The stabilization loop calls `seedFromPeerStore()` **on every tick**
(`fret-service.ts` ~line 819; passive cadence 1.5s, active 300ms), and that method
calls `this.store.upsert(pidStr, coord)` **unconditionally** for every peer in the
libp2p peerStore (~line 786) — not just for newly-discovered ones. So for every
peerStore-known peer, its relevance and health counters are reset to zero roughly
once per tick.

## Why it matters

Relevance scoring (success/failure ratio, RTT, access recency/frequency, sparsity
bonus) is the basis for:
- **eviction victim selection** when the table is over capacity, and
- **next-hop routing cost** (`linkQuality` / health terms).

Because the counters are wiped each tick, they can only ever reflect activity that
happened *within the current tick* (e.g. a ping in the same `stabilizeOnce` after the
re-seed). Any peer not actively probed that tick carries `relevance: 0`. The
documented "distance-balanced, health-aware cache" therefore never accumulates the
signal it's designed around.

Connection `state` is also reset to `'disconnected'` each tick, but that is cosmetic:
`isConnected()` reads `node.getConnections()` directly, not the stored field. The
substantive damage is to relevance/health.

## Scope / context

- **Pre-existing** — predates `ring-membership-classification`; that ticket only added
  membership preservation and is the reason this was noticed. Out of scope for it.
- The fix is to make `upsert` (or the per-tick re-seed) **preserve** the existing
  entry's mutable stats the same way it now preserves `membership` — i.e. update
  coord/lastAccess on an existing entry rather than rebuilding it, or have
  `seedFromPeerStore` skip peers already in the store. Confirm no caller relies on
  `upsert` zeroing an existing entry.
- Add a regression test: upsert an entry, score it (relevance > 0), upsert the same
  id again, assert relevance/counters survive — mirroring the existing
  "preserves membership across a re-upsert" test in `test/ring-membership.spec.ts`.
