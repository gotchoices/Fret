----
description: The rate limiter on the main routing request handler runs only after the handler has already done the expensive work, so an attacker can flood the node with clearly-invalid requests and bypass rate limiting entirely.
files: packages/fret/src/service/fret-service.ts
difficulty: easy
----
`handleMaybeAct` performs the full `nearAnchorOnly()` computation — hashing the key, running two membership-filtered ring walks, and two next-hop selections — for messages that are loop-detected, stale, expired-TTL, or oversized, *before* it calls `bucketMaybeAct.tryTake()`. The rate-limit token is taken after this work, so a flood of trivially-invalid messages (e.g. already-expired TTL) never touches the bucket and each still forces the expensive per-message computation.

Expected behavior: the rate-limit token is taken first, and messages that fail the cheap validity checks are rejected with a minimal static response without doing any ring/next-hop work.

Requirements:
- Take the rate-limit token before any per-message computation.
- Return a minimal, statically-constructed rejection for loop/stale/expired/oversized messages rather than computing a `NearAnchor`.

References: fret-service.ts `handleMaybeAct` validity checks and bucket call (~441-458). Review "Core service" major finding (rate-limit check runs after the expensive work).
