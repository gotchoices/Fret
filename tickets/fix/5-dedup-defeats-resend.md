----
description: A node that first asks the network where to act and then follows up with the actual work gets its follow-up silently ignored, so the work never happens and the request spins uselessly until it gives up.
files: packages/fret/src/service/fret-service.ts
difficulty: medium
----
The unified find-then-act flow is broken by an interaction between the duplicate-request cache and the way lookups reuse a single request identifier.

Today `handleMaybeAct` consults the correlation-ID dedup cache and returns the cached response *before* it ever runs the activity handler. Separately, `iterativeLookup` mints one correlation ID and reuses it across every hop of the walk *and* for the final resend that carries the activity payload. The first digest-only pass caches a `NearAnchor` reply under that ID. When the walk then resends with the activity, it commonly targets a node that already answered digest-only (the `NearAnchor` anchors built by `buildNearAnchor` can include the responder itself). That target sees the same correlation ID, hits its cache, and returns the stored `NearAnchor` — the activity handler never fires.

This compounds with `iterativeLookup` keeping no visited set: `exclude` is only self, and anchors are dropped from the candidate pool only when a call throws. So an already-probed peer is re-selected on the next attempt, and with the caching bug above the loop makes no forward progress — it degrades into a fast no-op spin until `maxAttempts` is exhausted.

Expected behavior: a resend carrying an activity payload always reaches the activity handler regardless of a prior digest-only exchange with the same peer; and a lookup does not re-probe a peer it has already contacted.

Requirements:
- Distinguish digest-only responses from activity-bearing ones in the dedup cache (key on correlation ID plus whether the message carried an activity), or do not cache digest-only responses at all.
- Give the activity resend a freshly minted correlation ID rather than reusing the discovery-phase ID.
- Maintain a visited set across attempts in `iterativeLookup` and filter both candidates and anchors against it so an already-contacted peer is not selected again.

References: fret-service.ts `handleMaybeAct` dedup check (~444-447), `iterativeLookup` correlation-ID reuse and resend (~1477, 1553), `buildNearAnchor`/anchor construction, and the lookup candidate/anchor selection (~1494-1496, 1577, 1594). Review "Core service" critical finding (dedup defeats resend) and the minor "iterativeLookup keeps no visited set".
