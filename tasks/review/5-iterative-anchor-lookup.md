description: Iterative anchor lookup and forwarding (maybeAct pipeline) — A5
dependencies: FRET core (routing table, cohort assembly, size estimation)
----

### Summary

Implemented the full RouteAndMaybeAct forwarding pipeline — the core routing mechanism of FRET (aspect A5). The pipeline supports both recursive server-side forwarding and client-side iterative lookup with progressive results.

### New Modules

- **`service/dedup-cache.ts`** — Bounded TTL cache for correlation-ID deduplication. Prevents re-processing the same request within a configurable window (default 30s, max 1024 entries). Evicts expired entries first, then oldest.

- **`service/payload-heuristic.ts`** — Two functions:
  - `shouldIncludePayload(distToKey, sizeEstimate, confidence, k, beta?, threshold?)` — Decides whether to include the activity payload based on distance to target cluster vs expected cluster span and confidence. Linear probability falloff within the "near zone" (β × clusterSpan).
  - `computeNearRadius(sizeEstimate, k, beta?)` — Returns a 32-byte Uint8Array representing the near-radius threshold for routing decisions.

### Enhanced Modules

- **`selector/next-hop.ts`** — Dual-mode next-hop selection:
  - **Cost-function mode** (when `nearRadius` is provided): Uses weighted cost function per fret.md spec: `cost(peer) = w_d·normDist − w_conn·connected − w_q·linkQ + w_b·backoff`. Near peers use strict distance ordering; far peers use cost-function ordering with connected-first bias.
  - **Legacy mode** (backwards compatible): Original leading-byte tolerance heuristic.
  - New `NextHopOptions` interface with `nearRadius`, `confidence`, `backoffPenalty`.
  - `normalizeDistance` now uses bit-level precision (256 levels) instead of byte-level (32 levels).

- **`service/fret-service.ts`** — Major enhancements:
  - **Breadcrumb loop rejection**: Rejects requests where self appears in breadcrumbs.
  - **Correlation-ID dedup**: Caches results by correlation_id; returns cached result on duplicate.
  - **Activity handler**: `setActivityHandler(handler)` for in-cluster activity execution (pend/commit).
  - **Enhanced `routeAct`**: Uses cost-function next-hop selection with near-radius, confidence, and backoff. Performs in-cluster activity via callback. Records forwarding success/failure for backoff tracking.
  - **`iterativeLookup` async generator**: Client-side iterative anchor lookup that yields progressive `RouteProgress` events (probing, near_anchor, activity_sent, complete, exhausted). Implements the lookup-then-act pattern: probes first, sends activity to anchor when near enough.
  - **Backoff tracking**: Per-peer exponential backoff map for failed forwarding attempts.

- **`index.ts`** — New exported types:
  - `ActivityHandler`, `RouteProgress`, `LookupOptions`
  - New `FretService` interface methods: `setActivityHandler`, `iterativeLookup`
  - Re-exports: `shouldIncludePayload`, `computeNearRadius`, `DedupCache`

### Testing

- **`dedup-cache.spec.ts`** (5 tests): Cache/retrieve, missing keys, TTL expiry, capacity eviction, overwrite.
- **`payload-heuristic.spec.ts`** (8 tests): Zero confidence/size, close/far targets, custom threshold, near-radius scaling.
- **`nexthop-cost.spec.ts`** (4 tests): Near-strict mode, far-slack mode, backoff penalty, legacy fallback.
- **`iterative-lookup.spec.ts`** (4 tests): Digest-only probe yields events, activity handler returns complete, breadcrumb rejection, correlation-ID dedup.

All 44 tests pass (23 existing + 21 new). TypeScript compilation clean.

### Validation

```
npm test       → 44 passing (18s)
tsc --noEmit   → clean
```

### Usage

```typescript
// Set activity handler for in-cluster actions
fret.setActivityHandler(async (activity, cohort, minSigs, correlationId) => {
  // Collect threshold signatures from cohort...
  return { commitCertificate: 'signed-cert' };
});

// Iterative lookup with progressive results
for await (const event of fret.iterativeLookup(keyBytes, {
  wantK: 15,
  minSigs: 14,
  activity: activityPayload,
  ttl: 8,
})) {
  switch (event.type) {
    case 'probing': console.log(`Hop ${event.hop} → ${event.peerId}`); break;
    case 'near_anchor': console.log('Near anchor:', event.nearAnchor); break;
    case 'complete': console.log('Done:', event.result); break;
    case 'exhausted': console.log('TTL/attempts exhausted'); break;
  }
}
```

### Key files

- `packages/fret/src/service/dedup-cache.ts`
- `packages/fret/src/service/payload-heuristic.ts`
- `packages/fret/src/selector/next-hop.ts`
- `packages/fret/src/service/fret-service.ts`
- `packages/fret/src/index.ts`
- `packages/fret/test/dedup-cache.spec.ts`
- `packages/fret/test/payload-heuristic.spec.ts`
- `packages/fret/test/nexthop-cost.spec.ts`
- `packages/fret/test/iterative-lookup.spec.ts`
- `docs/fret.md` (updated A5 section)
