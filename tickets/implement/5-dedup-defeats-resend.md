----
description: A node that first asks the network where to act and then follows up with the actual work gets its follow-up silently ignored, so the work never happens and the request spins uselessly until it gives up.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/protocols.ts, packages/fret/test/iterative-lookup.spec.ts, docs/fret.md
difficulty: medium
repro: verified
----

## What is wrong

FRET's find-then-act flow has two phases. A node first sends a *digest-only* probe ("who is near this key?"), gets back a `NearAnchor` reply naming the peers nearest the key, and then *resends* the same request carrying the real work payload (the `activity`) to one of those named peers.

Both phases currently travel under the **same** correlation ID, and the receiving side caches its reply keyed on that ID alone. So the second message — the one that actually carries the work — is treated as a duplicate of the first and answered from cache. The activity handler never runs.

It is not a rare race. The anchors a node returns include *itself* (it is in-cluster, which is why it answered at all), so the resend normally goes straight back to the peer that just cached a digest-only reply.

### Reproduced

Two in-memory libp2p nodes, both running `FretService`, activity handler installed on the responder. Send `maybeAct` twice over the wire with the same `correlation_id`: first digest-only, then with an `activity`.

Observed: the first call returns a `NearAnchor` whose `anchors` list **contains the responder's own peer id**; the second call returns the byte-identical cached `NearAnchor`, and the activity handler fired **0** times. Expected: a commit certificate, handler fired once.

The reproduction spec is not in the tree — recreate it as a permanent test (see TODO).

### Why it spins

`iterativeLookup` keeps no record of which peers it has already contacted. Its `exclude` set holds only self, and an anchor is dropped from the pool only when a call *throws*. Because the broken resend returns a perfectly valid `NearAnchor` rather than throwing, the same peer is re-selected on the next attempt, returns the same cached reply, and the loop makes no forward progress until `maxAttempts` is exhausted — a fast no-op spin, not a hang.

## Design

### 1. The cache key names the phase, not just the request

Root cause: a single correlation ID is being used for two things at once — *"this is a retry of a request you already answered, here is the same answer"* (idempotency) and *"here is a response you can hand back for free"* (response caching). A digest-only probe and an activity-bearing resend are **different requests**, and must not share a cache slot.

Key the dedup cache on correlation ID **plus phase**, where phase is simply whether the message carried an `activity`:

```
dedupKey(msg) = `${msg.correlation_id}|${msg.activity ? 'act' : 'digest'}`
```

Both arms keep their idempotency:

- a repeated **digest-only** probe (a routing loop, a replay) still returns the cached `NearAnchor` without re-walking the ring;
- a repeated **activity** message — a genuine retry of the same work to the same peer — still returns the cached commit certificate rather than performing the work twice. This is the arm that actually matters for correctness, and it is the one the current keying breaks by shadowing it with the digest reply.

Do this with a small private helper on `FretService` rather than inline string-building at both the `get` and the `set`, so the two can never drift apart.

Deliberately **not** hashing the activity payload into the key. With change 2 below, an activity resend carries its own ID, so distinct payloads do not collide in practice; hashing the payload would also mean a retry with a re-encoded-but-equivalent payload misses the cache and re-performs the work, which is worse than the thing it guards against.

### 2. Two correlation IDs per lookup, one per phase

`iterativeLookup` mints one ID and stamps it on every message. Mint **two**, both once per `iterativeLookup` call:

- `discoveryId` — every digest-only probe, across every hop and attempt.
- `activityId` — every activity-bearing resend.

Per-*call* and not per-*message* is the important part. Sharing one ID across all activity sends is what makes an activity retry idempotent: a peer that already performed the work recognises the retry and returns its stored certificate. Minting a fresh ID per send would destroy that and risk the work being done twice. Equally, the digest phase wants one shared ID so a probe that loops back around the ring is recognised.

`routeAct` forwards the message with its correlation ID unchanged; that stays as-is and is correct under both changes.

Note the correlation ID is also passed to the application's activity handler as an operation identifier (`activityHandler(activity, cohort, minSigs, correlationId)`). After this change that argument is the stable `activityId`, which is the identifier the handler actually wants — today it is an ID shared with unrelated digest traffic.

### 3. A visited set in `iterativeLookup`

Track every peer the walk has contacted — the probe target, the activity target, and a peer that answered `busy` — in a `visited` set that lives across attempts, seeded with self. Then:

- filter `bestAnchors` against it before using them as candidates;
- pass it as the `exclude` argument to `dialableCohort`, so it is applied **inside** the ring walk, not to the walk's result (post-filtering a sized cohort shrinks it below the requested count — see the cohort-assembly section of `docs/fret.md`).

There is an existing `NOTE:` comment in `iterativeLookup` recording exactly this gap as a tripwire ("the walk keeps no visited set … if lookups ever need to cover more of the ring, thread the probed ids through as an exclusion"). That note's premise was that the repeat probe is cheap and bounded; with the dedup defect above it is also *useless*, which is what promoted it from tripwire to work. **Delete that NOTE block** when the visited set lands — leaving a note describing a gap that no longer exists is worse than no note.

Expected consequence on tiny rings: a lookup now reaches `exhausted` sooner instead of burning `maxAttempts` on repeat probes. That is the correct outcome and existing specs already accept `exhausted` as a terminal event.

## Interactions with other tickets

- **`maybeact-ratelimit-ordering`** (`tickets/fix/7-…`) restructures the guard ordering at the top of the same `handleMaybeAct` function, moving the rate-limit token ahead of the validity checks. Compatible: the dedup lookup must stay before any ring/next-hop work; whichever of the two lands second should preserve *both* orderings (token → cheap guards → dedup → work). Expect a textual conflict in that function, not a semantic one.
- **`replay-dedup-hardening`** (`tickets/implement/`) declares this ticket as its prereq and will replace `Math.random()` ID generation with `crypto.randomUUID()`. It explicitly builds on the two-phase ID shape introduced here — keep the two IDs distinct and named so that ticket can swap the generator underneath without reintroducing a single shared ID.
- **`dedup-cache-eviction`** (`tickets/fix/15-…`) changes eviction inside `DedupCache`. No overlap: this ticket does not touch `dedup-cache.ts`, only what is used as the key.
- **`pickanchors-key-coord`** (`tickets/fix/6-…`) fixes `pickAnchors` measuring from the zero coordinate. Independent, but note it will change *which* anchors come back — it does not change the fact that the responder can name itself, which is correct behaviour (it is in-cluster) and must not be "fixed" by excluding self from anchors.

## TODO

### Phase 1 — reproduce as a permanent test

- Add a spec (extend `test/iterative-lookup.spec.ts`, or a new `test/maybeact-dedup-phases.spec.ts`) that stands up two in-memory nodes with `FretService`, installs an activity handler on the responder, and sends `maybeAct` over the wire twice with the same `correlation_id`: digest-only, then with an `activity`. Assert the second returns a `commitCertificate` and the handler fired exactly once. Confirm it fails before the fix.
- Add a companion assertion that dedup still works *within* a phase: two identical activity-bearing sends with the same correlation ID fire the handler exactly once and return the same certificate.

### Phase 2 — phase-keyed dedup

- Add the private `dedupKey(msg)` helper on `FretService` and route both the `get` and the `set` in `handleMaybeAct` through it.
- Confirm the early-return paths (breadcrumb loop, stale timestamp, TTL expired, oversized payload, busy) still do not populate the cache.

### Phase 3 — two-phase correlation IDs

- In `iterativeLookup`, replace the single `correlationId` with `discoveryId` and `activityId`, both minted once per call.
- Stamp `discoveryId` on the probe message and `activityId` on the activity resend message (the resend currently spreads `...msg`, so it inherits the probe's ID — override it explicitly).
- Handle the case where the probe itself carries the activity (`includePayload` true): that message is an activity-bearing message and must use `activityId`, not `discoveryId` — otherwise the payload-heuristic path and the resend path disagree about which ID identifies the work.

### Phase 4 — visited set

- Add `visited: Set<string>` to `iterativeLookup`, seeded with self, and record the probe target, the activity target, and busy responders.
- Filter `bestAnchors` against `visited`; pass `visited` as the `exclude` argument to `dialableCohort`.
- Delete the superseded `NOTE:` block about the missing visited set.
- Add a spec asserting no peer id appears twice across the `probing` progress events of a single lookup.

### Phase 5 — docs and validation

- `docs/fret.md`: in the "Unified find+maybe-act RPC" routing rule, state that the response cache is keyed on correlation ID *and* phase (digest vs activity-bearing), and that a lookup uses one ID per phase rather than one per lookup. Update the security section's "Correlation ID dedup cache" line accordingly.
- `docs/fret.md`: note in the RouteAndMaybeAct field description that `correlationId` identifies a request *phase*, not a whole lookup.
- Run `npx tsc --noEmit`, then `yarn test`, both from `packages/fret/`.
