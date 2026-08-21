description: When the service turns a request away for being over a limit, every different reason for turning it away is added to one shared tally, so an operator watching a node cannot tell which limit was hit, or even which kind of request hit it. Fix by giving each reason its own slot instead of one shared counter.
files: packages/fret/src/service/fret-service.ts (the `diag.rejected` object ~415; six `rejected.rateLimited++` sites at lines 1290, 1298, 1381, 1421, 1838, 1999), packages/fret/test/profile.behavior.spec.ts, packages/fret/test/inflight-concurrency.spec.ts, docs/fret.md
difficulty: easy
tradeoffs: n/a (implement ticket)
---

<!-- resume-note -->
**Fourth run also hit BUDGET_WARNING before any code edit landed** — four runs in, still ZERO
files touched (each dies right after the first confirmatory Read). Fifth run: do NOT re-verify
anything below by reading it again — the block below is copy-paste-ready `Edit` `old_string`/
`new_string` pairs, confirmed twice now (run 3 and run 4) byte-for-byte identical. Fire the Edits
in order below with **zero** exploration. Only 3 reads remain genuinely required (marked below);
do those inline, immediately followed by their Edit, not batched as a separate "exploration phase".

## Simplification vs earlier drafts of this note: skip the standalone type alias

Earlier drafts said add `type RateLimitedProtocol = 'neighbors' | 'ping' | 'maybeAct' | 'leave' |
'announce';` somewhere above the `rejected:` field. **Skip that** — its exact placement was never
pinned (would need an extra read of the outer class-field context to find a safe insertion point),
and it is not required for correctness: this is a plain object-literal initializer, so TypeScript
structurally infers `rateLimited: { neighbors: number; ping: number; maybeAct: number; leave:
number; announce: number }` from the literal below with no alias needed. `rejected.rateLimited.
maybeAct++` etc. type-checks fine against the inferred shape. Do not spend a read hunting a
placement for a cosmetic-only alias — get the six call sites + maybe-act.ts landed first.

## Ready-to-fire Edit #1 — the `diag.rejected` block (no read needed, content re-confirmed twice)

File: `packages/fret/src/service/fret-service.ts`

`old_string` (exact, unique in file):
```
		rejected: {
			payloadTooLarge: 0,
			timestampBounds: 0,
			ttlExpired: 0,
			rateLimited: 0,
			identityMismatch: 0,
			/** Inbound maybeAct messages that failed `parseRouteAndMaybeAct` (structure/type). */
			malformed: 0,
		},
	};
```

`new_string`:
```
		rejected: {
			payloadTooLarge: 0,
			timestampBounds: 0,
			ttlExpired: 0,
			rateLimited: { neighbors: 0, ping: 0, maybeAct: 0, leave: 0, announce: 0 },
			identityMismatch: 0,
			/** Inbound maybeAct messages that failed `parseRouteAndMaybeAct` (structure/type). */
			malformed: 0,
			/** maybeAct inflight-concurrency-cap saturation (Core 16 / Edge 4) — distinct from a token-bucket rejection: fires when the bucket had a token but the peer is already working on as many maybeAct requests as it allows at once. */
			concurrencyLimited: 0,
		},
	};
```

## Ready-to-fire Edits #2-4 — three unique-line call sites (no read needed)

All in `packages/fret/src/service/fret-service.ts`.

Edit #2 (line ~1381, `handleMaybeAct` token bucket):
`old_string`: `if (!this.bucketMaybeAct.tryTake()) { this.diag.rejected.rateLimited++; return { v: 1, busy: true, retry_after_ms: this.bucketMaybeAct.retryAfterMs() }; }`
`new_string`: same but `this.diag.rejected.rateLimited++` → `this.diag.rejected.rateLimited.maybeAct++`

Edit #3 (line ~1421, `handleMaybeAct` concurrency cap — NOT the same counter, see Edge cases below):
`old_string`: `if (this.inflightAct >= limit) { this.diag.rejected.rateLimited++; return { v: 1, busy: true, retry_after_ms: 500 }; }`
`new_string`: same but `this.diag.rejected.rateLimited++` → `this.diag.rejected.concurrencyLimited++`

Edit #4 (line ~1838, `handleLeave`):
`old_string`: `if (!this.bucketLeave.tryTake()) { this.diag.rejected.rateLimited++; return; }`
`new_string`: same but `this.diag.rejected.rateLimited++` → `this.diag.rejected.rateLimited.leave++`

If any of these three `old_string`s no longer matches exactly (file drifted), fall back to a
targeted `Read` of just that line ± 2 and adapt — but try the exact string first, zero-read.

## Remaining 3 reads that ARE genuinely required — do read immediately followed by its Edit

1. Read `packages/fret/src/service/fret-service.ts` lines ~1285-1302 → find the two bare lines
   `this.diag.rejected.rateLimited++;` in `handleNeighborsRequest` (~1290) and `handlePingRequest`
   (~1298) (3 identical bare-line matches exist file-wide, so bare `old_string` is ambiguous —
   grab 2-3 surrounding lines per site to disambiguate). Edit line ~1290 →
   `this.diag.rejected.rateLimited.neighbors++`; edit line ~1298 →
   `this.diag.rejected.rateLimited.ping++`.
2. Read lines ~1995-2003 → find the third bare `this.diag.rejected.rateLimited++;` in
   `handleAnnounce` (~1999). Edit → `this.diag.rejected.rateLimited.announce++`.
3. Read lines ~1225-1245 → find the `registerMaybeAct(` call inside `registerRpcHandlers` (line
   ~1234, with `return await this.handleMaybeAct(msg);` around line 1238). Add a 5th positional
   arg `() => { this.diag.rejected.malformed++; }` (the new `onMalformed` param — see maybe-act.ts
   edit below).

## Ready-to-fire Edit #5 — `packages/fret/src/rpc/maybe-act.ts` (full file content pinned, verified
twice — no read needed)

Full current file (59 lines) — for `Edit` tool matching, use the specific old/new fragments below
rather than re-pasting the whole file:

Fragment A — imports, top of file:
`old_string`:
```
import type { Libp2p } from 'libp2p';
import {
	PROTOCOL_MAYBE_ACT,
	encodeJson,
	decodeJson,
	readFramed,
	sendFramed,
	registerRpcHandler,
} from './protocols.js';
```
`new_string`:
```
import type { Libp2p } from 'libp2p';
import {
	PROTOCOL_MAYBE_ACT,
	encodeJson,
	decodeJson,
	readFramed,
	sendFramed,
	registerRpcHandler,
} from './protocols.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:maybe-act');
```

Fragment B — function signature + body:
`old_string`:
```
export async function registerMaybeAct(
	node: Libp2p,
	handle: (msg: RouteAndMaybeActV1, from: string) => Promise<NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }>,
	protocol = PROTOCOL_MAYBE_ACT,
	maxBytes = MAX_ACTIVITY_BYTES + MAYBE_ACT_OVERHEAD_BYTES
): Promise<void> {
	await registerRpcHandler(node, protocol, async (stream, connection) => {
		const bytes = await readFramed(stream, maxBytes);
		const msg = decodeJson<RouteAndMaybeActV1>(bytes);
		const res = await handle(msg, connection.remotePeer.toString());
		sendFramed(stream, encodeJson(res));
	});
}
```
`new_string`:
```
export async function registerMaybeAct(
	node: Libp2p,
	handle: (msg: RouteAndMaybeActV1, from: string) => Promise<NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }>,
	protocol = PROTOCOL_MAYBE_ACT,
	maxBytes = MAX_ACTIVITY_BYTES + MAYBE_ACT_OVERHEAD_BYTES,
	onMalformed?: () => void
): Promise<void> {
	await registerRpcHandler(node, protocol, async (stream, connection) => {
		const bytes = await readFramed(stream, maxBytes);
		let msg: RouteAndMaybeActV1;
		try {
			msg = decodeJson<RouteAndMaybeActV1>(bytes);
		} catch (err) {
			log.error('%s: undecodable body - dropping - %e', protocol, err);
			onMalformed?.();
			sendFramed(stream, encodeJson({ v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 0, confidence: 0 } satisfies NearAnchorV1));
			return;
		}
		const res = await handle(msg, connection.remotePeer.toString());
		sendFramed(stream, encodeJson(res));
	});
}
```

(`NearAnchorV1` is already imported in this file per the pinned full-file listing further below —
confirm the import line still lists it; it does in the pinned content.)

## Steps 6-9 (test/doc updates + verify) — unchanged from original TODO, see full list at bottom

After edits #1-5 land: update `test/inflight-concurrency.spec.ts` (assert on
`concurrencyLimited`, drop stale comment), `test/profile.behavior.spec.ts` (keyed-shape reads),
`docs/fret.md` (3 sites, listed in "Edge cases & interactions" below), then
`cd packages/fret && npx tsc --noEmit && yarn test`.

## If budget runs out again before step 9

Commit whatever subset of edits #1-5 landed (do NOT leave the working tree half-edited across a
ticket handoff with no note) — update this same resume-note to say exactly which of edits #1-5
completed and which remain, using the same ready-to-fire format above for whatever's left, and
re-pin any NEW exact line numbers/content the completed edits shifted. Do not restate content
that's already correctly pinned above unchanged.

--- ORIGINAL (run 3) NOTE BELOW, kept for the exact verified six-call-site mapping table and
line-content pins that are still accurate ---

This run confirmed exact line content (below) so the next run can edit immediately with no
exploring: read nothing except the three narrow context-reads called out below, then start
editing.

## Exact current content, pinned this run (safe to trust, no re-read needed)

**`diag.rejected` block, `fret-service.ts` lines 415-424 (exact, verified this run):**
```ts
415		rejected: {
416			payloadTooLarge: 0,
417			timestampBounds: 0,
418			ttlExpired: 0,
419			rateLimited: 0,
420			identityMismatch: 0,
421			/** Inbound maybeAct messages that failed `parseRouteAndMaybeAct` (structure/type). */
422			malformed: 0,
423		},
424	};
```
Replace per "Resolved design" section below: `rateLimited: 0,` (line 419) becomes a
`Record<RateLimitedProtocol, number>` initialized inline, plus add sibling `concurrencyLimited: 0,`
after it (before the closing `},` at 423). Add the `RateLimitedProtocol` type alias somewhere above
the `rejected:` field (private to this file, not exported — no test imports it directly, confirmed
by earlier runs).

**`packages/fret/src/rpc/maybe-act.ts` — FULL FILE, exact, 59 lines (verified this run, paste this
mentally instead of re-reading the file):**
```ts
import type { Libp2p } from 'libp2p';
import {
	PROTOCOL_MAYBE_ACT,
	encodeJson,
	decodeJson,
	readFramed,
	sendFramed,
	registerRpcHandler,
} from './protocols.js';
import { rpcRequest } from './request.js';
import { parseMaybeActReply, parseOrThrow, MAX_ACTIVITY_BYTES, MAYBE_ACT_OVERHEAD_BYTES } from './validate.js';
import type { RpcOutcome } from './outcome.js';
import type { RouteAndMaybeActV1, NearAnchorV1, BusyResponseV1 } from '../index.js';

export async function registerMaybeAct(
	node: Libp2p,
	handle: (msg: RouteAndMaybeActV1, from: string) => Promise<NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }>,
	protocol = PROTOCOL_MAYBE_ACT,
	maxBytes = MAX_ACTIVITY_BYTES + MAYBE_ACT_OVERHEAD_BYTES
): Promise<void> {
	await registerRpcHandler(node, protocol, async (stream, connection) => {
		const bytes = await readFramed(stream, maxBytes);
		const msg = decodeJson<RouteAndMaybeActV1>(bytes);
		const res = await handle(msg, connection.remotePeer.toString());
		sendFramed(stream, encodeJson(res));
	});
}

/**
 * Route one `RouteAndMaybeAct` to `peerIdStr` and await its answer.
 *
 * `opts.timeoutMs` budgets the whole RPC (dial + open + write + read) and defaults to
 * {@link RPC_TIMEOUT_MS}. It is deliberately left at that default by every call site: this call
 * returns only once the *entire remaining route* has completed downstream, so its budget is a
 * route budget rather than a link budget, and tightening it truncates healthy long routes.
 */
export async function sendMaybeAct(
	node: Libp2p,
	peerIdStr: string,
	msg: RouteAndMaybeActV1,
	protocol = PROTOCOL_MAYBE_ACT,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<RpcOutcome<NearAnchorV1 | { commitCertificate: string }>> {
	return rpcRequest(node, peerIdStr, protocol, {
		...opts,
		body: msg,
		halfCloseBeforeRead: true,
		maxBytes: MAX_ACTIVITY_BYTES + MAYBE_ACT_OVERHEAD_BYTES,
		// A reply that is neither shape is `decode-error`, not a half-parsed cast.
		decode: (b) => parseOrThrow(parseMaybeActReply, decodeJson(b)),
	});
}
```
No `createLogger` import exists yet in this file. Confirmed this run: `leave.ts`, `neighbors.ts`,
`ping.ts`, `protocols.ts`, `validate.ts` each do `import { createLogger } from '../logger.js';` and
name their own logger `createLogger('rpc:<name>')` (e.g. `createLogger('rpc:leave')`). Follow that
exact pattern: `createLogger('rpc:maybe-act')`.

**Concrete fix for `maybe-act.ts` (still not applied):**
1. Add `import { createLogger } from '../logger.js';` and `const log = createLogger('rpc:maybe-act');`.
2. Add 5th param `onMalformed?: () => void` to `registerMaybeAct`, after `maxBytes`.
3. Replace the two-line body:
   ```ts
   const bytes = await readFramed(stream, maxBytes);
   const msg = decodeJson<RouteAndMaybeActV1>(bytes);
   ```
   with:
   ```ts
   const bytes = await readFramed(stream, maxBytes);
   let msg: RouteAndMaybeActV1;
   try {
   	msg = decodeJson<RouteAndMaybeActV1>(bytes);
   } catch (err) {
   	log.error('%s: undecodable body - dropping - %e', protocol, err);
   	onMalformed?.();
   	sendFramed(stream, encodeJson({ v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 0, confidence: 0 } satisfies NearAnchorV1));
   	return;
   }
   ```
   (leave the `readFramed` call itself unwrapped — truncation/over-cap must keep throwing to the
   seam's abort path, per the ticket's edge-cases section; only `decodeJson` is body-level here.)
4. At the call site in `fret-service.ts` `registerRpcHandlers` (need one quick Read of lines
   ~1225-1245 first — not yet captured verbatim this run, only that line 1234 is
   `registerMaybeAct(` and line 1238 is `return await this.handleMaybeAct(msg);`), pass
   `() => { this.diag.rejected.malformed++; }` as the new 5th positional arg.

## Six call-site edits — exact text pinned this run

Three of six already have unique full-line text (safe to `Edit` directly, `old_string` = the
whole line, no extra context needed — each is unique in the file):
- **Line 1381** (`handleMaybeAct` token bucket): `if (!this.bucketMaybeAct.tryTake()) { this.diag.rejected.rateLimited++; return { v: 1, busy: true, retry_after_ms: this.bucketMaybeAct.retryAfterMs() }; }` → replace `this.diag.rejected.rateLimited++` with `this.diag.rejected.rateLimited.maybeAct++`
- **Line 1421** (`handleMaybeAct` concurrency cap): `if (this.inflightAct >= limit) { this.diag.rejected.rateLimited++; return { v: 1, busy: true, retry_after_ms: 500 }; }` → replace `this.diag.rejected.rateLimited++` with `this.diag.rejected.concurrencyLimited++` (NOT `rateLimited.maybeAct` — this is the mechanism split, see Edge cases section below)
- **Line 1838** (`handleLeave`): `if (!this.bucketLeave.tryTake()) { this.diag.rejected.rateLimited++; return; }` → replace with `this.diag.rejected.rateLimited.leave++`

The other three (**1290** `handleNeighborsRequest`, **1298** `handlePingRequest`, **1999**
`handleAnnounce`) are each a bare line `this.diag.rejected.rateLimited++;` with no other
distinguishing text on that line — grep confirmed this run but did NOT capture surrounding
context, so `Edit`'s `old_string` will hit "not unique" (3 identical matches) if used bare. Next
agent must `Read` roughly lines 1285-1302 and 1995-2003 (one Read each, ~20 lines) first to grab
2-3 lines of surrounding context per site, then `Edit` each with that context included:
- line ~1290 → `this.diag.rejected.rateLimited.neighbors++`
- line ~1298 → `this.diag.rejected.rateLimited.ping++`
- line ~1999 → `this.diag.rejected.rateLimited.announce++`

## Order of operations for next run
1. Type change at 415-424 (mechanical, content pinned above — no read needed).
2. Three unique-line edits (1381, 1421, 1838 — content pinned above, no read needed).
3. One Read of ~1285-1302, one Read of ~1995-2003 → three remaining call-site edits.
4. One Read of ~1225-1245 → wire `onMalformed` into the `registerMaybeAct(...)` call.
5. `maybe-act.ts` edit (full diff pinned above, no read needed — content already captured verbatim).
6. `test/inflight-concurrency.spec.ts`: assert on `concurrencyLimited`, drop/rewrite stale comment.
7. `test/profile.behavior.spec.ts`: update reads to keyed shape.
8. `docs/fret.md`: three sites named in "Edge cases & interactions" section below.
9. `cd packages/fret && npx tsc --noEmit && yarn test`.

Everything below this note (Resolved design, second-arm design, edge cases, TODO) is unchanged
from the original ticket and still the source of truth for *what* to build — this note is only
about *exactly what's already been verified* so the next run stops re-discovering it.
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
