----
description: Close the long replay window by tightening how fresh a message must be, generating request identifiers that an attacker cannot predict, and sizing the duplicate-request cache to the node's role so it cannot be cheaply flushed.
prereq: dedup-defeats-resend
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/service/dedup-cache.ts, docs/fret.md
----
Three changes close the multi-minute replay window: the accepted timestamp drift is far wider than the duplicate-request cache TTL, correlation IDs are predictable, and the cache is a fixed size regardless of node role.

### 1. Tighten timestamp validation

`validateTimestamp` defaults its maximum drift to five minutes while the dedup cache TTL is thirty seconds. This leaves a window where a replayed message passes the freshness check but has already fallen out of the dedup cache. Change the default drift to thirty seconds so it aligns with the cache TTL. All callers (maybe-act, leave, and the neighbor snapshot handler) use the default, so no call-site changes are needed. Thirty seconds remains generous for NTP-synced clocks; nodes with poor time sync can pass a wider window explicitly.

### 2. Cryptographically strong correlation IDs

`iterativeLookup` builds correlation IDs from `Math.random()`, whose PRNG is predictable from observed outputs, letting an attacker pre-fill the dedup cache. Generate IDs with `crypto.randomUUID()` via `globalThis.crypto`, keeping the self-id prefix for traceability (the prefix need not be secret). Provide a fallback using `crypto.getRandomValues` for environments such as React Native where `randomUUID` may be unavailable. Place the helper as a module-level, non-exported function.

### 3. Profile-tuned dedup capacity

The dedup cache is hardcoded at 1024 entries. Derive capacity from the profile: 512 for Edge (lower traffic, rate limits cap inbound further) and 2048 for Core (higher throughput, harder to exhaust by flooding). Wire the capacity through the service config; the existing FIFO eviction is unchanged.

### Reconciliation note

The `dedup-defeats-resend` fix also rewrites correlation-ID generation in `iterativeLookup`, giving each phase (digest probe and activity resend) its own correlation ID. Build this ticket on top of that: apply the secure-generation helper to the per-phase ID minting introduced there, and do NOT reintroduce a single reused ID per lookup.

### Docs

Update `docs/fret.md`: change the current-state timestamp bound from five minutes to thirty seconds, and mark the tightened-timestamp, strong-correlation-id, and profile-tuned-dedup items as done in the planned-work list.

References: review Design assessment "Correlation-ID semantics conflate idempotency with response caching" (dedup TTL vs timestamp window, the alignable ~10% replay surface). Threat model sections on the replay window, weak correlation IDs, timestamp replay, and dedup cache poisoning. Leave-notice dedup is handled separately by the leave-authentication work.
