----
description: A node that first asked the network where to act and then followed up with the actual work had its follow-up silently ignored, so the work never happened. Two separate causes were found and fixed.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/maybeact-dedup-phases.spec.ts, docs/fret.md
----

## What the bug was

FRET's find-then-act flow is two messages: a cheap probe asking "who is near this key?", then a
resend carrying the actual work. Both belong to one lookup, so both carried the same request id.
The receiver's duplicate-request cache was keyed on that id alone, so it handed the probe's cheap
"try these peers" reply back as the answer to the message carrying the work — and the work never
ran, silently.

The responder's own list of suggested peers normally names *itself* (it answered because it is
near the key), so the resend usually goes straight back to the peer holding the probe's cached
reply. Not a rare race: the common path.

## What shipped

### Implement stage

- **Duplicate-request cache keyed on request id *and phase*** — `dedupKey(msg)` in
  `fret-service.ts` pairs the correlation id with whether the message carries an activity, so a
  probe and its resend get separate cache slots. Both `get` and `set` route through the one
  helper so they cannot drift apart.
- **Two request ids per lookup, one per phase** — `newCorrelationId(phase)`; `iterativeLookup`
  mints `discoveryId` and `activityId` once per call (not per message, which is what keeps a
  retry idempotent). A probe that the payload heuristic loads with the activity uses the activity
  id, since it *is* an activity-bearing message.
- **A `visited` set in `iterativeLookup`**, seeded with self, passed *into* the candidate ring
  walk rather than filtering its result. Stops a remote anchor list that keeps naming an
  already-probed peer from spinning the walk to `maxAttempts`.
- Docs and a 4-test spec (`maybeact-dedup-phases.spec.ts`) exercising the fix over the wire.

### Review stage (this pass)

Two further defects of the same class — *the activity is silently dropped* — were found and fixed;
see `## Review findings`.

## Validation

`npx tsc --noEmit` clean, `yarn build` clean, `yarn test` **328 passing, 0 failing** (~4 min).
No pre-existing failures surfaced.

## Review findings

### Major — fixed in this pass

- **The resend was still refused, now as a routing loop.** `iterativeLookup` stamped the activity
  resend with `breadcrumbs: [selfId, target]`. Breadcrumbs are the peers a *message* has already
  passed through, and `handleMaybeAct` answers anchors-only to any message whose trail names the
  receiver. The resend's destination is normally `target` itself — the peer that named itself as
  an anchor, which is the entire point of the two-phase flow — so the receiver found itself in
  the trail, refused its own resend as a loop, and the activity was silently never performed.
  The implement stage's dedup fix was therefore invisible on the real path: one silent drop was
  simply replaced by another.

  Caught by a new end-to-end test, not by reading — the implement spec sent its activity message
  by hand with an empty breadcrumb trail, so it never reproduced the real `iterativeLookup` path.
  The ticket's own "use cases worth exercising by hand" listed exactly this scenario; running it
  is what surfaced the defect.

  Fixed at the site: `breadcrumbs: [selfId, target].filter(id => id !== actTarget)`. The probed
  peer stays in the trail when the resend goes to a *different* anchor, where it is a genuine
  "don't bounce back" hint. The invariant — *a message never carries its own destination* — is
  recorded in the comment at the site and in the `breadcrumbs` field description in
  `docs/fret.md`, so the general rule outlives this instance.

- **A refusal was cached as the answer to work.** `handleMaybeAct` cached *every* `routeAct`
  result. For a digest probe a `NearAnchor` is the answer, so caching it is right. For an
  activity-bearing message a `NearAnchor` is the opposite — it means "I did not perform the work;
  try over there", returned when no activity handler is installed, or when the peer is not
  in-cluster and its forward found no hop or failed. Caching it answered every retry of that work
  for the 30 s TTL with the same refusal. That is the ticket's own bug one level in: the phase
  split separated probe from work, but within the activity phase a non-answer was still stored as
  an answer, and just as silently.

  Fixed by a named seam, `cacheResponse(msg, result)`, which stores only a *terminal* answer for
  the phase: an activity-bearing message caches a commit certificate and nothing else. The trade
  — a replayed activity can re-drive a forward attempt — is correct, because the work was never
  performed, and TTL decrement, breadcrumbs and the rate-limit bucket already bound the cost.
  Documented in the routing rule in `docs/fret.md`.

### Tripwires — recorded at the site, not filed

- **A busy peer is retired for the rest of a lookup.** `visited.add(target)` runs before the
  probe, so a `busy` reply removes that peer from every later candidate set instead of allowing a
  retry. Free today: the attempt loop has no delay, so an immediate retry would meet the same
  empty token bucket. `NOTE:` at the busy branch in `iterativeLookup` — if the walk ever honours
  `retry_after_ms` with a real wait, busy responders must stay out of `visited` so the wait can
  pay off.

### Considered and left alone

- **Not hashing the activity payload into the cache key** — the implement handoff asked for a
  second opinion. The reasoning holds. Two different activities can only collide under one
  correlation id if a peer deliberately reuses an id, and a peer that can choose the id can
  equally choose a fresh one, so hashing buys nothing against it; meanwhile it would cost a cache
  miss (and a re-performed activity) on any retry whose payload re-encodes to different bytes.
  Predictable ids are a separate concern, already owned by `replay-dedup-hardening`.
- **`visited.add(actTarget)` while anchor lists are *not* filtered against `visited`** reads
  contradictory but is coherent: a peer that refused the work stays reachable as an activity
  target via a later anchor list, yet is no longer worth spending a probe on. The existing
  `NOTE:` at the site states this; no change.
- **`newCorrelationId('act')` is minted even for a lookup with no activity.** One string; not
  worth a branch.

### Checked, nothing found

- **Cache population paths** — read every early return in `handleMaybeAct` (breadcrumb loop,
  stale timestamp, expired TTL, oversized payload, rate-limited, in-flight cap). None populates
  the cache, so a rejection is never replayed as an answer. Confirmed by reading, and the guard
  ordering is untouched by this ticket.
- **`routeAct` forwarding** — forwards the correlation id unchanged, which is correct under the
  phase split: the phase travels with the `activity` field, not the id.
- **`DedupCache`** — untouched; its FIFO eviction and TTL are unaffected by the longer keys, and
  capacity tuning belongs to `replay-dedup-hardening`.
- **Docs** — read every file the change touches. `docs/fret.md` updated in four places by the
  implement stage (correlation-id field, routing-rule cache line, security current-state, A5
  pipeline bullets) and three more in this pass (terminal-answer-only caching, the breadcrumbs
  invariant, the security line). No other doc describes this path.
- **Test coverage** — the implement spec covered the repro and both intra-phase dedup arms but
  only over hand-built messages. Added the end-to-end `iterativeLookup` find-then-act test (which
  caught the breadcrumb defect) and a regression test that a refusal is not cached. Also cleaned
  `as any[]` / a needless `let` out of the new spec, per the project's no-`any` rule.

### Not filed, already claimed

- `fret-service.ts` is 2134 lines. `tickets/plan/23-fret-service-decomposition.md` already owns
  the split; this pass added ~30 net lines and did not widen it further.
- The `Math.random()` correlation-id generator and the dedup cache's fixed capacity are owned by
  `tickets/implement/replay-dedup-hardening.md`, which declares this ticket as its prereq. The
  `NOTE:` at `newCorrelationId` points there.
- The expected textual conflict with `tickets/fix/7-maybeact-ratelimit-ordering.md` still stands:
  it reorders the guards at the top of `handleMaybeAct`. Whichever lands second must preserve
  token → cheap guards → dedup → work. This pass moved the cache *write* behind `cacheResponse`
  but left the guard order untouched, so the two remain semantically compatible.
