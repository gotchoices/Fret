----
description: The health and relevance scoring that decides which peers to trust is fed fake zero-millisecond timing on successful message forwards, and separately cannot tell a real zero-millisecond measurement from no measurement at all, so good peers can end up scored worse than slow ones.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/store/relevance.ts
difficulty: medium
----
Two related bugs feed fabricated zero-millisecond latency into the health/relevance scoring.

1. On a successful forward, the service calls `applySuccess(next, coord, 0)`, injecting a fake 0 ms sample into the peer's `avgLatencyMs`. The forward's real RPC duration is never measured, so a peer's recorded latency is corrupted downward by every forward.

2. In `relevance.ts`, an `avgLatencyMs === 0` sentinel conflates "no latency measured yet" with "measured exactly 0 ms". A genuine 0 ms sample is common on localhost given `Date.now()` granularity; such a peer is kept out of the EMA latency branch and ends up scored *worse* than a peer measured at 300 ms.

Expected behavior: successful forwards record their actual RPC duration (or take a latency-less success path that does not touch `avgLatencyMs`); and the scoring distinguishes "unknown latency" from "measured 0 ms" explicitly rather than overloading the value 0.

Requirements:
- Measure the real duration of the forward RPC and pass it to the success update, or add a success variant that records success/health without a latency sample.
- Represent latency known-ness explicitly (a nullable latency field, or gate on `successCount > 0`) so a true 0 ms sample is treated as measured.

References: fret-service.ts successful-forward `applySuccess(next, coord, 0)` (~1252); relevance.ts `avgLatencyMs === 0` handling (~83, 118). Review "Core service" minor finding (fake 0 ms latency skews health EMA) and the store-section relevance finding (0 ms sentinel).
