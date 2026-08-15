---
description: Fixed a bug where a node that first asked the network where to act and then followed up with the actual work had its follow-up silently ignored, so the work never happened.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/maybeact-dedup-phases.spec.ts, docs/fret.md
difficulty: medium
---

## What changed

Three coupled changes in `packages/fret/src/service/fret-service.ts`, plus a new spec and doc updates.

### 1. Response cache keyed on correlation ID **and** phase

New private helper `dedupKey(msg)` (just above `handleMaybeAct`, ~line 655):

```ts
private dedupKey(msg: RouteAndMaybeActV1): string {
	return `${msg.correlation_id}|${msg.activity ? 'act' : 'digest'}`;
}
```

Both the `get` (~line 688) and the `set` (~line 709) in `handleMaybeAct` route through it, so the
two can't drift apart. Nothing else in `handleMaybeAct` moved — the dedup lookup is still between
the breadcrumb check and the timestamp check, and the early-return paths (breadcrumb loop, stale
timestamp, TTL expired, oversized payload, busy) still never populate the cache (verified by
reading: only the `routeAct` success path calls `set`).

`DedupCache` itself is untouched.

### 2. Two correlation IDs per lookup, one per phase

New private `newCorrelationId(phase: 'digest' | 'act')` replaces the inline ID construction.
`iterativeLookup` mints `discoveryId` and `activityId` **once per call** (not per message):

- the probe message uses `includePayload ? activityId : discoveryId` — a probe that carries the
  payload is itself an activity-bearing message, so it must use the activity ID or the
  payload-heuristic path and the resend path disagree about which ID names the work;
- the resend spreads `...msg` and then explicitly overrides `correlation_id: activityId`.

The phase name is appended to the ID string so the two IDs of one lookup differ by construction
rather than by the randomness. A receiver never parses it — `dedupKey` reads the phase off the
message's own `activity` field.

`routeAct` still forwards the correlation ID unchanged (correct under both changes).

### 3. `visited` set in `iterativeLookup`

`const visited = new Set<string>([selfId])`, living across attempts. Records the probe target
(added just before the `probing` event, so a `busy` reply and a throwing hop are both covered) and
the activity target. It is passed **into** `dialableCohort` as the `exclude` argument, and
`bestAnchors` is filtered against it before use. The old `bestAnchors = bestAnchors.filter(id => id
!== target)` in the catch block was removed as redundant.

The superseded `NOTE:` block about the missing visited set is deleted.

The activity target is **deliberately not** filtered against `visited` — the anchor we resend to is
normally the peer we just probed (it named itself, being in-cluster), which is the whole point of
the two-phase flow. That decision is recorded as a `NOTE:` tripwire at the site.

### Docs

`docs/fret.md`: RouteAndMaybeAct `correlationId` field description (identifies a phase, not a
lookup); routing-rule step 1 cache line (keyed on ID + phase, and why); security section's
"Correlation ID dedup cache" line; the A5 pipeline bullets (visited set; "Correlation-ID + phase
dedup cache").

## Validation

`npx tsc --noEmit` clean, `yarn build` clean, `yarn test` **326 passing, 0 failing** (~5 min).

New spec `packages/fret/test/maybeact-dedup-phases.spec.ts` (4 tests, all over the wire through
`sendMaybeAct` so the inbound handler and its cache actually run — `routeAct` alone never touches
the cache, which is why the pre-existing "Correlation ID dedup" test in
`test/iterative-lookup.spec.ts` never caught this):

- **the repro** — digest-only probe then activity resend, same `correlation_id`: asserts the second
  returns a `commitCertificate` and the handler fired exactly once. **Confirmed failing before the
  fix**: temporarily reverting `dedupKey` to return `msg.correlation_id` produced
  `expected { v: 1, anchors: [ …(2) ], …(3) } to have property 'commitCertificate'`, i.e. the
  byte-identical cached `NearAnchor`, handler fired 0 times.
- dedup still holds *within* the activity phase — two identical activity sends, same ID: work
  performed once, retry returns the identical stored certificate.
- dedup still holds *within* the digest phase — two identical probes: second answered from cache.
- `iterativeLookup` yields no duplicate peer across its `probing` events (4-node mesh).

### Use cases worth exercising by hand

- Two nodes, activity handler on the responder, `iterativeLookup` with an `activity`: expect a
  `complete` event rather than a walk that spins to `maxAttempts`.
- A tiny ring with no fresh hop left: expect `exhausted` **sooner** than before. This is the
  intended consequence of the visited set; existing specs already accept `exhausted` as terminal.
- Retry semantics: same lookup's activity re-sent to a peer that already committed — should return
  the stored certificate, never re-run the handler.

## Known gaps / where to look hardest

- **`newCorrelationId` still uses `Math.random()`.** Not replay-resistant. Out of scope here —
  `replay-dedup-hardening` (in `tickets/implement/`) declares this ticket as its prereq and swaps
  the generator. The two-phase shape is designed so that swap drops in underneath. A `NOTE:` at the
  helper records it.
- **Phase is a boolean, not a real phase enum.** `dedupKey` distinguishes exactly two states:
  activity-bearing or not. If a third kind of maybeAct message ever appears, this key stops being
  sufficient and the helper needs a real discriminator.
- **The activity payload is not hashed into the key** (argued in the ticket and in the helper's
  doc comment): two *different* activities under the same correlation ID would collide. In
  practice each lookup mints its own activity ID, so that requires a peer deliberately reusing an
  ID — which is the replay-hardening ticket's problem, not this one's. Worth a reviewer's second
  opinion on whether that reasoning holds.
- **The `visited` set is per-lookup and unbounded.** Bounded in practice by `maxAttempts`
  (`ttl + 2` by default), so at most a handful of ids; no eviction added.
- **Test ring sizes are small** (2 and 4 nodes, memory transport). The repro path — responder names
  itself as an anchor — is exactly the small-ring case, so this is the right shape for the defect,
  but the visited-set behavior on a larger ring (where a lookup genuinely walks several hops) is
  only covered by the existing simulation specs, which passed unchanged.
- **No test asserts the two IDs are distinct on the wire.** The behavior is asserted end-to-end
  (the resend gets a certificate), not structurally. A reviewer wanting a tighter guard could
  capture the messages a lookup emits and assert the digest and activity messages carry different
  `correlation_id`s.
- **Expected textual conflict** with `maybeact-ratelimit-ordering` (`tickets/fix/7-…`), which
  reorders the guards at the top of the same `handleMaybeAct`. Whichever lands second must preserve
  both orderings: token → cheap guards → dedup → work. Semantically compatible.

## Review findings

- Recorded a tripwire as a `NOTE:` in `iterativeLookup` at the activity-target selection: the same
  peer can be an activity target on more than one attempt (free today, since every activity send of
  a lookup shares one ID and repeats are answered from that peer's cache); if activity delivery
  ever needs to try successive anchors, it needs its own attempted-set rather than reusing
  `visited`.
- Recorded a `NOTE:` at `newCorrelationId` that `Math.random()` is not replay-resistant, pointing at
  the planned replay hardening in `docs/fret.md`.
