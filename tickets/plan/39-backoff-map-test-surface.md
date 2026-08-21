---
description: Tests that check how often the system retries an unresponsive peer have to reach inside the main service class to read private bookkeeping, which makes them brittle. Consider giving that bookkeeping a small class of its own so the tests can use it directly.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/utils/expiring-map.ts, packages/fret/test/ring-membership.spec.ts
difficulty: medium
tradeoffs: The map is small and its callers are few, so a maintainer may reasonably judge that a handful of test-only casts is cheaper than another module boundary and another injected clock.
---
Discovered while planning `23.2-membership-classification-extraction` (now closed as "no seam" —
see `tickets/complete/`). That ticket set out to price the test-surface cost of policy living inside
`FretService`. The measurement it produced points at a **different** seam than the one it was
investigating, so it is filed here rather than folded into that ticket.

## The measurement

`packages/fret/test/ring-membership.spec.ts` contains 20 `as any` / `as unknown as` casts
(`grep -n "as any\|as unknown as"`, counted by hand from the 20 matching lines). They split:

| Target | Count | Lines |
|---|---|---|
| Probe-backoff internals — `backoffMap`, `recordBackoff`, `getBackoffPenalty`, `pruneBackoffMap`, and the `BACKOFF_BASE_MS` / `BACKOFF_MAX_FACTOR` / `BACKOFF_RETAIN_MS` class constants | 18 | 368–370, 403–405, 435–436, 461, 467, 469, 475, 477–478, 481, 491–493 |
| Stubbing `stabilizeOnce` to disable probing | 1 | 504 |
| `applyMembershipSignal` | 1 | 802 |

So the membership guard — the thing `23.2` was investigating — costs one cast. The per-peer
**probe backoff** costs eighteen, in one `describe` block (`Foreign re-probe backoff growth`,
lines 347–509).

## What is actually being reached for

Those tests are pure arithmetic over a clock: does the backoff window double, does it cap at
factor 32, does an entry survive an expired window but not the retention period, is
`BACKOFF_RETAIN_MS` longer than the longest possible window. None of that needs a libp2p node —
but the state lives in a private `ExpiringMap` field on `FretService` alongside private
`recordBackoff` / `getBackoffPenalty` / `pruneBackoffMap` methods and private static constants,
so every assertion goes through a cast. One test even *replaces* the private field with its own
`ExpiringMap` (line 467) in order to inject a clock, which is a test reaching past the boundary
rather than through it.

## Shape of the fix

A small class owning the map, the escalation rule, the retention lifetime and the constants —
with an injectable clock, following the house pattern `SizeObserver`
(`packages/fret/src/service/size-observer.ts`) already set for exactly this: a class that reads
nothing but its own state and a `now: () => number`, so the maths is unit-testable without sleeps
or nodes. `FretService` would keep the call sites (`probeMembership`'s failure arms, the
`busy`-reply arm of `probeNeighborLatency`, the routing cost penalty, the two re-probe arms'
candidate ordering) and delegate.

Two things a design must check rather than assume:

- **The map has two different readers of the same entry** — a boolean off-backoff gate and an
  ordering key (`backoffMap.get(id)?.factor`) used by both re-probe arms. Any extracted interface
  has to expose both without letting a caller reconstruct the escalation rule for itself.
- **The `foreign` and `dead` re-probe arms deliberately share one backoff map.** There is a
  `NOTE:` at `reprobeExcludedTargets` recording that as a decision. An extraction must not turn
  the shared map into two.

## Why this is filed as debt rather than a bug

Nothing is wrong today: the tests pass and the behavior they pin is correct. The cost is that the
backoff rule can only be exercised through a class that needs a libp2p node to construct, and that
a future change to the escalation schedule breaks 18 casts before it breaks an assertion.
