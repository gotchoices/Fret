description: Peers that repeatedly fail to answer are now marked dead after three spread-out failed contact attempts, and are brought back to life the moment they prove they are reachable. Review the new counter, the single seam that decides what counts as a failed contact, and the five call sites routed through it.
files: packages/fret/src/store/digitree-store.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/index.ts, packages/fret/test/dead-state.spec.ts, packages/fret/test/relevance.properties.spec.ts, docs/fret.md
difficulty: medium
----

Implemented Phases 1–3 of the split `dead-state-transition` work: the per-peer contact-failure
counter, the liveness seam on `FretService`, and the five outbound-RPC failure call sites routed
through it. Sibling ticket `dead-state-exclusion-recovery` (Phases 4–6) still owns ring exclusion of
dead peers, the dead re-probe pass, and the design-doc prose rewrite.

`PeerState` already had a `'dead'` member and `FretPeerDiscovery` already skipped dead entries, but
**no code path wrote `'dead'`**. Now three call sites can.

## What landed

**Store (`digitree-store.ts`).** `PeerEntry` gains `contactFailures` (consecutive failed contact
attempts since the last proof of life) and `lastContactFailureAt` (the spacing timestamp), both
defaulted to 0 in `upsert`'s new-entry branch and preserved by the hit branch's spread — exactly
mirroring the `negotiateFailures` / `lastNegotiateFailureAt` pair. `contactFailures` is exported in
`SerializedPeerEntry` (optional, diagnostics only) and reset to 0 on import; `lastContactFailureAt`
is never serialized. `importEntries` already forced `state: 'disconnected'`, so an imported table
can carry neither a dead peer nor the counter that would immediately re-kill it.

**Service (`fret-service.ts`).**

- `FretConfig.deadAfterFailures` (default 3, floored at 1 so a `0` cannot mark every peer dead on
  its first failure). `this.cfg` is now typed `Required<FretConfig>` so no read site re-derives a
  default — `bootstraps` / `networkName` were already always assigned, so this is type-only.
- `CONTACT_FAILURE_MIN_SPACING_MS = 500`, deliberately a separate constant from
  `NEGOTIATE_FAILURE_MIN_SPACING_MS` even though the value matches.
- `applyContactStrike(id)` — **synchronous, no awaits**: skip self, apply the spacing guard, clamp
  the count at the threshold, set `state: 'dead'` on reaching it. Synchronous because
  `applySuccess` / `applyFailure` read-await-write and lose an increment under concurrency (there is
  already a `NOTE:` saying so); harmless for a relevance score, not for a threshold counter.
- `applyContactFailure(id, coord)` = `applyFailure` then the strike. The single seam for "we could
  not reach this peer".
- `noteProofOfLife(id)` — synchronous: clear the run, and if the entry was `'dead'` restore
  `'connected'` when a connection exists else `'disconnected'`. Called from `applySuccess`,
  `noteInboundRpc`, and the `peer:connect` handler.
- `noteRpcFailure(id, err)` — the routing seam: unsupported-protocol → membership strike only
  (the dial succeeded, so the peer is alive); anything else → `applyContactFailure`. Records **no**
  backoff, so each call site keeps its existing backoff behavior. Never throws (it runs inside
  `catch` blocks in background loops); a bookkeeping failure is logged, not swallowed silently.
- `coordOf(id)` extracted for the repeated
  `store.getById(id)?.coord ?? await hashPeerId(peerIdFromString(id))` pattern, applied only at the
  sites this ticket touched (5 of ~8). The rest is `cleanup-core-service`'s sweep.

Call sites routed through `noteRpcFailure`: `probeNeighborsLatency` catch, `probeMembership` catch,
`routeAct` forward catch, `iterativeLookup` activity-send catch, `iterativeLookup` hop catch. The
`ok: false` arms were left alone (relevance decay / backoff only, no strike) — `sendPing` collapses
busy / empty / undecodable into one result, so the conservative reading is "the peer answered".

## Behavior deltas — please check these deliberately

Every one is a consequence of funnelling five hand-rolled catch blocks through one seam. None was
required by the ticket beyond the first, but all follow from the seam's definition.

1. **`probeNeighborsLatency`: an `UnsupportedProtocolError` no longer also decays relevance.**
   Previously that catch called `applyMembershipSignal` *and* `applyFailure` on both arms. This is
   the intended reading — a peer that refuses negotiation answered at the transport layer, so it is
   alive and the membership machinery owns the signal — but it is a change. (Flagged in the source
   ticket; restated here so it isn't rediscovered.)
2. **`probeMembership`: a timeout / transient failure now decays relevance.** Previously that arm
   only recorded backoff and touched no counters. Consistent with the design doc's "soft failure
   (timeout): decay relevance by δ", but new at this site.
3. **`routeAct` forward catch: a non-negotiation failure now decays relevance.** Previously backoff
   only.
4. **Both `iterativeLookup` catches: now apply membership *and* liveness bookkeeping.** Previously
   backoff only — neither site had any membership handling at all, so an
   `UnsupportedProtocolError` on a lookup hop was silently ignored. That gap is now closed, which is
   an improvement but is also the largest of these deltas.

Deltas 2–4 all mean more relevance decay than before on failing peers, which feeds capacity eviction
and next-hop preference. The full suite is green, including the churn/coverage simulations that would
be most sensitive to it, but they are stochastic — worth an adversarial look at whether decaying on
a lookup-hop failure can evict a peer the walk still needs.

## Deliberately NOT done (sibling ticket `dead-state-exclusion-recovery`)

- Dead peers are still **in every ring view**: `isMember` is `membership === 'member'` and does not
  look at `state`, so a dead peer is still a neighbor / cohort member / routing candidate. Only
  `FretPeerDiscovery` (which already filtered dead) changes behavior today. Ring exclusion is the
  sibling's Phase 4 — so the user-visible effect of this ticket alone is small by design.
- No dead re-probe pass, so today a dead peer recovers only via `applySuccess` on a path that still
  selects it, an inbound RPC, or a `peer:connect`. Sibling's Phase 5.
- `docs/fret.md` prose still says "3+ consecutive timeouts **or explicit error**" and "reset
  relevance score to baseline" — both readings this implementation deliberately rejects. That
  rewrite is the sibling's Phase 6. I did add two purely factual doc lines (the
  `SerializedPeerEntry.contactFailures` field and the `deadAfterFailures` default) so the schema
  and config sections are not wrong at HEAD; the sibling should expect to edit around them.

## Testing done — treat as a floor

`packages/fret/test/dead-state.spec.ts` (new, 14 tests, all passing). Spacing is wall-clock, so the
tests rewind `lastContactFailureAt` to 0 between strikes rather than sleeping. The service is
constructed but **not started** in the seam tests, so no stabilization loop probes the synthetic
peers — deterministic, but it also means these tests exercise the helpers directly and **not** the
five call sites that call them.

Covered: three spaced failures → dead with count 3; two → live, third kills; three inside the 500 ms
window → count 1, live; unsupported-protocol through the seam → no liveness strike but membership
still reaches `foreign`; three bare `applyFailure` calls (the `peer:disconnect` shape) → no strike;
self never dies; resurrection via `applySuccess`, via `noteInboundRpc`, and via `noteProofOfLife`
on a still-live peer; resurrection to `connected` when a real connection exists; a configured
`deadAfterFailures: 2`; counter clamping at the threshold. Store-level: default 0 + survives
re-upsert; dead peer exports with its count and imports as `disconnected` with count 0.

### Known gaps in that coverage

- **No end-to-end test that a real unreachable peer goes dead.** Nothing drives an actual failing
  RPC through `probeNeighborsLatency` / `routeAct` / `iterativeLookup` and asserts the transition;
  the wiring at those five call sites is verified by type-checking and reading, not by a test. This
  is the biggest gap. A two-node memory-transport test that stops one node and waits for the other
  to mark it dead across ≥3 stabilization ticks would close it, at the cost of ~5s wall clock.
- **No test for the `peer:connect` proof-of-life site.** `noteProofOfLife` is tested directly, but
  the handler calling it is not — that site's whole reason to exist is that `setState('connected')`
  alone would leave the counter clamped.
- **No concurrency test for the synchronous-strike claim.** The helper is synchronous by
  construction and reading it is convincing, but nothing pins it: a future refactor that adds an
  await inside `applyContactStrike` would silently reintroduce lost increments and every existing
  test would still pass.
- `deadAfterFailures` is exercised at 2 and 3 only; the `Math.max(1, …)` floor for a configured 0
  or negative is not tested.

## Validation run

- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && yarn test` — **506 passing, 0 failing** (~4m). No pre-existing failures
  surfaced, so `tickets/.pre-existing-error.md` was not written.

One unrelated type fix was needed to keep the build green: `test/relevance.properties.spec.ts`'s
`makeEntry` builds a full `PeerEntry` literal, so it gained the two new fields.
