description: When the service turns a request away for being over a limit, every different reason for turning it away is added to one shared tally, so an operator watching a node cannot tell which limit was hit, or even which kind of request hit it. Fix by giving each reason its own slot instead of one shared counter.
files: packages/fret/src/service/fret-service.ts (the `diag.rejected` object ~415; six `rejected.rateLimited++` sites at lines 1290, 1298, 1381, 1421, 1838, 1999), packages/fret/test/profile.behavior.spec.ts, packages/fret/test/inflight-concurrency.spec.ts, docs/fret.md
difficulty: easy
tradeoffs: n/a (implement ticket)
---

<!-- resume-note -->
Second run hit BUDGET_WARNING before any code edit landed (investigation-only run again). Still
zero files touched — safe to resume from scratch, nothing to undo or revert.

Confirmed this run, on top of everything the first run already confirmed (six call sites, the
`diag.rejected` block at 415-424, `handleMaybeAct` 1370-1433 not being the gap):

**Second-arm gap is now precisely located — no more searching needed.** It is
`packages/fret/src/rpc/maybe-act.ts`, function `registerMaybeAct` (lines 15-32):

```ts
export async function registerMaybeAct(
	node: Libp2p,
	handle: (msg: RouteAndMaybeActV1, from: string) => Promise<NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }>,
	protocol = PROTOCOL_MAYBE_ACT,
	maxBytes = MAX_ACTIVITY_BYTES + MAYBE_ACT_OVERHEAD_BYTES
): Promise<void> {
	await registerRpcHandler(node, protocol, async (stream, connection) => {
		const bytes = await readFramed(stream, maxBytes);
		const msg = decodeJson<RouteAndMaybeActV1>(bytes);          // <-- line 28, unguarded
		const res = await handle(msg, connection.remotePeer.toString());
		sendFramed(stream, encodeJson(res));
	});
}
```

Line 28's `decodeJson` throws on an undecodable/non-object body. That throw propagates out of
`serve()` into `registerRpcHandler`'s own try/catch (`src/rpc/protocols.ts` ~124-148), which logs
and `abort()`s the stream — no `diag` counter touched anywhere. Compare
`registerJsonHandler` (`protocols.ts` ~213-221), which the other four handlers sit on: it wraps
the same `decodeJson` call in try/catch, calls `opts.onMalformed?.('decode')`, and **returns
normally** (so the seam's ordinary budgeted `close()` runs, not abort). `registerMaybeAct` needs
the same shape, by hand, since it deliberately stays off that seam (bucket-before-parse).

**Concrete fix (not yet applied):**
1. Add an `onMalformed?: () => void` param to `registerMaybeAct` (5th param, after `maxBytes`).
2. Wrap line 28 in try/catch: on catch, call `onMalformed?.()`, log
   (`log.error('%s: undecodable body - dropping - %e', protocol, err)` — needs a
   `createLogger` import in `maybe-act.ts`; check whether one already exists in a sibling rpc
   file, e.g. `leave.ts` or `neighbors.ts`, before adding a fresh namespace string — reuse the
   existing house style, likely `optimystic:fret:rpc:maybe-act` or similar, don't invent one
   inconsistent with siblings), reply with the same static-reject shape `handleMaybeAct` already
   uses on its own malformed path (`{ v: 1, anchors: [], cohort_hint: [], estimated_cluster_size:
   0, confidence: 0 } satisfies NearAnchorV1` — copy the literal, don't import
   `FretService`'s private `staticReject()`), then `return` (no throw) so the seam's normal
   success-path budgeted close runs instead of abort.
3. At the call site in `fret-service.ts` `registerRpcHandlers` (~1234-1242), pass
   `() => { this.diag.rejected.malformed++; }` as the new 5th arg — same counter
   `handleMaybeAct`'s own parse-failure path already increments, per the ticket's stated design
   (undecodable body counts under the *existing* `malformed` bucket, not a new one).
4. Do **not** touch `readFramed`'s own failures (truncation, over-cap) — those stay frame-level
   and must keep aborting per `registerJsonHandler`'s documented drop/abort split; only the
   `decodeJson` call is body-level here.

Everything else in this ticket (six rateLimited++ call-site edits, the `diag.rejected` type
change, both spec files, the three `docs/fret.md` sites, tsc/test run) is **still fully
untouched** — resume the TODO list top to bottom exactly as written below, this second-arm item
now has a fully specified fix so it should be fast. Do the `diag.rejected` type change and the
six call-site edits first (mechanical), then this second-arm fix, then tests/docs.
<!-- /resume-note -->

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
