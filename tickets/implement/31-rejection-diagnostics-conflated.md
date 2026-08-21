description: When the service turns a request away for being over a limit, every different reason for turning it away is added to one shared tally, so an operator watching a node cannot tell which limit was hit, or even which kind of request hit it. Fix by giving each reason its own slot instead of one shared counter.
files: packages/fret/src/service/fret-service.ts (the `diag.rejected` object ~415; six `rejected.rateLimited++` sites at lines 1290, 1298, 1381, 1421, 1838, 1999), packages/fret/test/profile.behavior.spec.ts, packages/fret/test/inflight-concurrency.spec.ts, docs/fret.md
difficulty: easy
tradeoffs: n/a (implement ticket)
---

## Resolved design

Replace the single `rejected.rateLimited: number` field with a keyed record, one slot per
protocol, plus one new sibling field for the concurrency-cap case (a different mechanism
entirely, not a rate limit):

```ts
type RateLimitedProtocol = 'neighbors' | 'ping' | 'maybeAct' | 'leave' | 'announce';

rejected: {
	payloadTooLarge: number;
	timestampBounds: number;
	ttlExpired: number;
	identityMismatch: number;
	malformed: number;
	/** Per-protocol token-bucket rejections — which wire protocol's bucket was empty. */
	rateLimited: Record<RateLimitedProtocol, number>;
	/** maybeAct inflight-concurrency-cap saturation (Core 16 / Edge 4) — distinct from a token-bucket rejection: this fires when the bucket had a token but the peer is already working on as many maybeAct requests as it allows at once. */
	concurrencyLimited: number;
}
```

Initialize `rateLimited` as `{ neighbors: 0, ping: 0, maybeAct: 0, leave: 0, announce: 0 }` next
to the other zeroed counters (~line 415).

This is a keyed record rather than a tagged-enum log or anything heavier, because the only
requirement is "read out per protocol, cheaply, synchronously" (`getDiagnostics()` stays a plain
object snapshot) — a record satisfies that with the least churn to the public diagnostics shape,
and a reason added later gets a new record key or a new sibling field rather than reusing
someone else's.

### Call-site mapping (six sites → their own slot)

- line 1290, `handleNeighborsRequest` (`bucketNeighbors.tryTake()` fails) → `rateLimited.neighbors++`
- line 1298, `handlePingRequest` (`bucketPing.tryTake()` fails) → `rateLimited.ping++`
- line 1381, `handleMaybeAct` (`bucketMaybeAct.tryTake()` fails — the token bucket) → `rateLimited.maybeAct++`
- line 1421, `handleMaybeAct` (`this.inflightAct >= limit` — the concurrency cap) → `concurrencyLimited++` (**not** `rateLimited.maybeAct`, per the resolved design above — this is the mechanism the original ticket singled out as "a different mechanism entirely")
- line 1838, `handleLeave` (`bucketLeave.tryTake()` fails) → `rateLimited.leave++`
- line 1999, `handleAnnounce` (`bucketAnnounceInbound.tryTake()` fails) → `rateLimited.announce++`

## Second arm: maybeAct silently drops undecodable bodies with no counter movement

`handleMaybeAct` is not on the shared `registerJsonHandler` seam that the other four handlers use
(its token bucket must be taken before any per-message work, which that seam cannot do — see
*Cheap-guard rejections* in `docs/fret.md`). Find where the raw JSON body for a maybeAct message
is decoded ahead of `parseRouteAndMaybeAct` (grep `handleMaybeAct` and its registration in
`registerRpcHandlers`/the maybeAct protocol handler for the `decodeJson`/`readFramed` call). Today
an undecodable body there throws out of the handler, which `registerRpcHandler`'s wrapper catches
by `abort()`-ing the stream (see *Inbound handlers release their stream on every path* in
`docs/fret.md`) — tearing the connection down with **no diagnostic counter incremented at all**.

Fix: wrap that decode in a try/catch (or otherwise catch the decode failure) at the same point the
other four protocols' `onMalformed` hook fires, and count it under the existing `diag.rejected.malformed`
counter — the same bucket a structurally-invalid-but-decodable message already falls into via
`parseRouteAndMaybeAct` returning `undefined`. Do not abort/tear down the connection for this case;
reply with the same static reject the malformed-structure path already returns, matching how the
other four handlers turn a body-level failure into a polite drop rather than a frame-level abort.

## Edge cases & interactions

- **Concurrency-cap saturation must never be counted under `rateLimited.maybeAct`.** This is the
  exact conflation the original ticket flagged as sharpest (a flood vs. a sizing/capacity issue an
  operator would act on differently) — a regression here silently re-merges the two counters the
  ticket exists to split apart. `test/inflight-concurrency.spec.ts` must assert on
  `diag.rejected.concurrencyLimited`, not `rateLimited.maybeAct`.
- **A busy reply from the token bucket and a busy reply from the concurrency cap still look
  identical on the wire** (`{busy: true, retry_after_ms: ...}` either way) — only the local
  diagnostic distinguishes them now. Don't conflate this with a wire-protocol change; none is
  needed or in scope.
- **The maybeAct concurrency-cap spec (`test/inflight-concurrency.spec.ts`) currently relies on the
  shared counter being unambiguous by construction** — it sizes fan-out to stay inside the token
  bucket so no too-fast rejection mixes into the tally it asserts on. Once the counters split, that
  constraint is no longer load-bearing; remove/update the comment explaining it (per the original
  ticket's notes) since the spec should now assert on `concurrencyLimited` directly regardless of
  bucket sizing.
- **`profile.behavior.spec.ts` reads the old flat `rateLimited` counter** — update every read site to
  the new keyed shape (`diag.rejected.rateLimited.<protocol>`), and check whether it asserts a
  *sum* across protocols anywhere (if so, sum the record's values rather than reading one field).
- **`docs/fret.md` names this counter in (at least) three places** needing coordinated updates:
  - the departure-notice section ("The only local signal is `diag.rejected.rateLimited`" — update
    to name the specific keyed field, `rateLimited.leave`);
  - the concurrency-cap bullet under *Operating profiles* ("a bucket rejection and an inflight
    rejection both increment `diag.rejected.rateLimited` and differ only in `retry_after_ms`" —
    this sentence is now **false** under the new design and must be rewritten to say they increment
    different fields, which is the fix);
  - the security section's rate-limiting bullet mentioning `diag.rejected.rateLimited` generically —
    update to describe the per-protocol keyed shape.
- **Type import**: if `RateLimitedProtocol` (or equivalent) is exported/used across modules, use
  `import type` per `verbatimModuleSyntax` (see AGENTS.md) — but this is likely a private type local
  to `fret-service.ts` and need not be exported at all unless a test imports it directly.
- **Don't touch the other five `rejected.*` fields** (`payloadTooLarge`, `timestampBounds`,
  `ttlExpired`, `identityMismatch`, `malformed`) — they are already unambiguous and out of scope.

## TODO

- Change the `diag.rejected` type/initializer (~line 415) to the resolved shape above.
- Update all six call sites (1290, 1298, 1381, 1421, 1838, 1999) per the mapping above.
- Locate and fix the maybeAct undecodable-body silent-drop (second arm) so it counts under
  `diag.rejected.malformed` instead of aborting the stream with no diagnostic.
- Update `test/inflight-concurrency.spec.ts` to assert on `concurrencyLimited` and drop/rewrite the
  now-stale comment about the shared counter being unambiguous by construction.
- Update `test/profile.behavior.spec.ts` for the new keyed shape.
- Update the three `docs/fret.md` sites named above.
- Run `cd packages/fret && npx tsc --noEmit` and `yarn test` (targeted specs first, then full suite)
  before handoff.
