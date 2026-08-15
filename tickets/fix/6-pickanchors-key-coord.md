----
description: When a node tells a requester which neighbors sit nearest a key, it accidentally measures distance from a fixed zero point instead of from the key, so the neighbors it hands back are the wrong ones.
files: packages/fret/src/service/fret-service.ts
difficulty: easy
----
`pickAnchors` passes `new Uint8Array(32)` — the all-zero coordinate — as the target coordinate instead of the key's coordinate. As a result the anchors returned in a `NearAnchor` reply are biased toward numerically small ring coordinates rather than being the key's true successor and predecessor, which is what the wire format promises the requester.

Expected behavior: anchors are the successor and predecessor of the *key's* coordinate.

Requirements:
- Pass the key coordinate to `pickAnchors`. Both callers already have the key in scope.

References: fret-service.ts `pickAnchors` (~1195-1198). Review "Core service" major finding (pickAnchors measures distance to zero, not to the key).
