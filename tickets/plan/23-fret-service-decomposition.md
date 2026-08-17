----
description: The core service file has grown into a single ~1600-line class that mixes many concerns; two self-contained pieces of logic can be lifted out to shrink it and make the extracted logic testable on its own.
files: packages/fret/src/service/fret-service.ts
difficulty: hard
----
`fret-service.ts` is a god class of roughly 1600 lines. Two extractions are cheap and high-value.

(a) Two-sided ring walk helper. The idiom that builds the union of the right- and left-side ring neighbors of a coordinate and drops self appears nine times with small variations — roughly `Array.from(new Set([...neighborsRight(c, m), ...neighborsLeft(c, m)])).filter(id => id !== selfStr)`. Replace these with a single helper, e.g. `ringNeighborsBothSides(coord, count, opts)`, that centralizes the dedup, the self-exclusion, and the member-only filter. This removes duplication and gives one place to fix the wrap-around dedup/early-exit behavior noted elsewhere.

(b) Size observer. About 135 lines handle network-size observation, blending, decay, churn detection, and partition detection. This block has zero coupling to the Digitree store or to libp2p and is currently impossible to unit-test in isolation. Extract it into a `SizeObserver` class with a narrow interface (feed observations in, read blended estimate/confidence out) so the decay and blend math becomes directly testable.

Expected outcome: the nine walk sites call one helper; the size logic lives in its own unit-testable class; `fret-service.ts` is meaningfully smaller with no behavior change.

This is a design/refactor pass — the plan agent should settle the helper signature and the `SizeObserver` interface, enumerate the call sites, and confirm behavior parity (especially member-only filtering and the wrap-around dedup) before handing to implement.

References: fret-service.ts nine two-sided walk sites (~520-719) and the size observation/blend/decay/churn/partition block (~1331-1465). Review "Core service" major finding (nine copies of the two-sided walk idiom; god-class scope).

Size re-measured during the `membership-classification-strength` review: `wc -l packages/fret/src/service/fret-service.ts` now reports **1878** lines, up from the ~1600 this ticket was written against (membership classification and the probe/re-probe passes landed in between). A third extraction candidate has appeared alongside the two above: membership classification — the evidence-strength guard, the inbound-RPC promotion, the identify-list classifier, and the two bounded probe passes — is a self-contained policy with a narrow dependency on the store, and is currently only reachable in tests through real libp2p nodes or private-member casts.

Size re-measured during the `dead-state-exclusion-recovery` review: `wc -l
packages/fret/src/service/fret-service.ts` now reports **2466** lines, up from the 1878 recorded at
the `membership-classification-strength` review and the ~1600 this ticket was written against (the
dead-state liveness seam, ring exclusion, and the two-armed re-probe pass landed in between). The
one extraction that same review performed — `isLiveMember` into `src/service/live-member.ts`, so
`FretPeerDiscovery` shares the predicate rather than copying it — is 20 lines of the god class, not
a dent; the three candidates above still stand.

Size re-measured during the `relevance-scoring-tests` review: `wc -l
packages/fret/src/service/fret-service.ts` reports **2980** lines.

**New arm on (a): the walk sites are off by one against the configured `m`, and they disagree with
each other.** A ring walk anchored at self returns self as its own first result on *both* sides
(`neighborsRight` seeks `hex(coord)|\x00` and lands on self's own key; `neighborsLeft` mirrors it).
So `neighborsRight(selfCoord, m)` yields self plus only `m − 1` other peers, and the ubiquitous
`.filter(id => id !== selfStr)` that follows is the tell — the count was already spent on self.
Consequences, all present today:

- Capacity protection (`enforceCapacity` → `protectedIdsAround(self, max(2, m), isLiveMember)`)
  protects `2·max(2, m) − 1` ids, so the m-th successor and m-th predecessor are evictable at
  capacity even though `docs/fret.md` describes the whole of S(p) ∪ P(p) as retained.
- The self-anchored maintenance walks (leave-notice targets, `isNearNeighbor`, warm-up target
  lists) likewise cover `m − 1` real neighbors per side rather than `m`.
- `windowGaps` in `src/estimate/size-estimator.ts` is the one site that compensates, asking each
  side for `m + 1` with a comment explaining why. That local fix is the evidence this is a class
  rather than an instance.

Verified statically by reading the walk implementations and pinned as current behavior (not as
correct behavior) by `packages/fret/test/relevance.eviction.spec.ts`. The helper this ticket
already proposes is the right place to settle it: decide once whether `count` means "peers besides
self" or "results including self", state it in the signature, and let every call site inherit the
answer. Whether the outermost S/P member *should* be protected is part of that decision, not a
separate ticket.

**Second new arm on (a): the leave-notice walk truncates the *concatenation* of the two sides, so
at the shipped default `k` the predecessor side is almost entirely dropped.** Same five lines as
the off-by-one arm above (`sendLeaveToNeighbors`, `fret-service.ts:1487-1491`), and the same fix
retires it — which is why it is an arm here rather than its own ticket. Found during the
`leave-announce-test-assertions` review; `repro: verified`.

```ts
const ids = Array.from(new Set([
    ...this.store.neighborsRight(selfCoord, this.cfg.m),
    ...this.store.neighborsLeft(selfCoord, this.cfg.m)
])).filter((id) => id !== selfStr).slice(0, 8);
const spSet = new Set(ids);
```

The `8` is a bare literal — every other two-sided walk site bounds itself with `cfg.m`,
`announceFanout`, or `Math.min(N, cfg.m)`. It happens to equal the default `m`, which is what makes
it look deliberate, but it does not scale with `k` and it is applied *after* the two walks are
concatenated, so it eats the second walk rather than bounding each side.

Measured on a hand-seeded 20-peer ring at the shipped default `k: 15` (so `m` = 8), with self in
the store as it is for any live service:

```
unsliced S/P walk offsets: [1,2,3,4,5,6,7, 20,19,18,17,16,15,14]
sliced targets (slice 0,8): [1,2,3,4,5,6,7, 20]
genuine S/P members that are replacement-eligible: [19,18,17,16,15,14]
replacement offsets:        [8,9,10,11,12,13]
```

Two consequences, both live today:

1. **Six of the seven predecessors are never told the peer left.** Only `p1` receives a notice.
   `docs/fret.md` (*Leave*, step 1) says the notice goes to all S(p) ∪ P(p); that claim is false at
   the default config, so the doc and the code have to be reconciled as part of this arm. The
   practical cost is healing latency, not lost state — an un-notified predecessor still drops the
   departed peer once its own contact strikes accumulate — but that is a stabilization-tick
   timescale rather than the immediate one the leave protocol exists to provide.
2. **`spSet` is built from the *sliced* list, so genuine S/P members become replacement
   candidates.** `computeReplacements` excludes `spSet`, and its own doc comment describes its
   output as "the live members just *outside* our own S/P window" — but the six predecessors above
   are inside that window and pass the filter. In the measured run they did not actually ship,
   because the clockwise pool filled all six slots first; a single *connected* predecessor sorts to
   the front of `computeReplacements`' ordering and would ship. So this is a latent wrong-result,
   not a currently-observable one.

Note for whoever implements: the two consequences want different bounds and the decision should be
explicit rather than incidental. The set the notice is *sent* to may legitimately stay budgeted
(shutdown is on a clock — `SHUTDOWN_BUDGET_MS`), but `spSet` must be the **unsliced** S/P set
regardless, because it defines what "outside our window" means rather than who we managed to dial.
Conflating "who we notified" with "what our window is" is the actual root cause, and the helper
this ticket proposes is where the two stop being the same array.

**This arm is shippable on its own** — a per-side bound plus splitting `spSet` off the target list
is a small, local change — and it should not wait on the full decomposition. It is filed here
because it resolves at the same site and via the same helper as the off-by-one arm, not because it
is refactor-sized.

Not pinned by a test on purpose: the `leave-announce-test-assertions` review's new sender-side
specs run at `k: 3` and `k: 7`, where the unsliced walk is 4 and 8 ids so the slice never bites.
Adding a spec now would pin current behavior, which is the wrong shape for a defect.
