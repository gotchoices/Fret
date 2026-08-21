description: When the service turns a request away for being over a limit, every different reason for turning it away is added to one shared tally, so an operator watching a node cannot tell which limit was hit, or even which kind of request hit it. Fix by giving each reason its own slot instead of one shared counter.
files: packages/fret/src/service/fret-service.ts (the `diag.rejected` object ~415; six `rejected.rateLimited++` sites at lines 1290, 1298, 1381, 1421, 1838, 1999), packages/fret/src/rpc/maybe-act.ts, packages/fret/test/profile.behavior.spec.ts, packages/fret/test/inflight-concurrency.spec.ts, docs/fret.md
difficulty: easy
tradeoffs: n/a (implement ticket)
---

<!-- resume-note -->
**Run 6 in a row hit BUDGET_WARNING immediately after the confirmatory Read, before any Edit
call.** Content re-verified byte-for-byte AGAIN this run (both `fret-service.ts` lines 410-424 and
the full 59-line `maybe-act.ts`) — identical to every prior run. The ticket file itself was bloated
with 3 duplicated copies of this same resume-note (each run's "verification" got appended instead
of replacing) — that's likely *why* budget died so early: the file was ballooning context on load.
This rewrite deletes all that duplication and keeps only what's needed to fire the 9 edits below
with **zero reads** (the Edit tool requires one Read call per file per conversation before its
first Edit — do ONE small Read on each file, e.g. `fret-service.ts` lines 410-430 and
`maybe-act.ts` in full, purely to satisfy that tool precondition, NOT to re-verify content — then
fire every edit below back-to-back with no further Reads).

Do the two small Reads, then fire Edits #1-#9 in order, then steps 6-9 (test/doc updates +
`tsc`/`yarn test`). Nothing here has changed across 6 runs — stop re-verifying, just execute.

## Edit #1 — `diag.rejected` block

File: `packages/fret/src/service/fret-service.ts`

old_string:
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

new_string:
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

No type alias needed — plain object literal, TS infers the shape structurally.

## Edit #2 — `handleNeighborsRequest` (~line 1290)

File: `packages/fret/src/service/fret-service.ts`

old_string:
```
	private async handleNeighborsRequest(): Promise<NeighborSnapshotV1 | BusyResponseV1> {
		if (!this.bucketNeighbors.tryTake()) {
			this.diag.rejected.rateLimited++;
			return { v: 1, busy: true, retry_after_ms: this.bucketNeighbors.retryAfterMs() };
		}
		return await this.snapshot();
	}
```

new_string: same but `this.diag.rejected.rateLimited++;` → `this.diag.rejected.rateLimited.neighbors++;`

## Edit #3 — `handlePingRequest` (~line 1298)

File: `packages/fret/src/service/fret-service.ts`

old_string:
```
	private handlePingRequest(): { size_estimate?: number; confidence?: number } | BusyResponseV1 {
		if (!this.bucketPing.tryTake()) {
			this.diag.rejected.rateLimited++;
			return { v: 1, busy: true, retry_after_ms: this.bucketPing.retryAfterMs() } satisfies BusyResponseV1;
		}
		return this.getNetworkSizeEstimate();
	}
```

new_string: same but `this.diag.rejected.rateLimited++;` → `this.diag.rejected.rateLimited.ping++;`

## Edit #4 — `handleMaybeAct` token bucket (~line 1381, unique whole-line match)

File: `packages/fret/src/service/fret-service.ts`

old_string:
```
		if (!this.bucketMaybeAct.tryTake()) { this.diag.rejected.rateLimited++; return { v: 1, busy: true, retry_after_ms: this.bucketMaybeAct.retryAfterMs() }; }
```

new_string: same but `this.diag.rejected.rateLimited++` → `this.diag.rejected.rateLimited.maybeAct++`

## Edit #5 — `handleMaybeAct` concurrency cap (~line 1421, unique whole-line match)

File: `packages/fret/src/service/fret-service.ts`

old_string:
```
		if (this.inflightAct >= limit) { this.diag.rejected.rateLimited++; return { v: 1, busy: true, retry_after_ms: 500 }; }
```

new_string: same but `this.diag.rejected.rateLimited++` → `this.diag.rejected.concurrencyLimited++` (NOT `rateLimited.maybeAct` — mechanism split, see *Edge cases* below)

## Edit #6 — `handleLeave` (~line 1838, unique whole-line match)

File: `packages/fret/src/service/fret-service.ts`

old_string:
```
		if (!this.bucketLeave.tryTake()) { this.diag.rejected.rateLimited++; return; }
```

new_string: same but `this.diag.rejected.rateLimited++` → `this.diag.rejected.rateLimited.leave++`

## Edit #7 — `handleAnnounce` (~line 1999)

File: `packages/fret/src/service/fret-service.ts`

old_string:
```
	private handleAnnounce(from: string, snap: NeighborSnapshotV1): void {
		if (!this.bucketAnnounceInbound.tryTake()) {
			this.diag.rejected.rateLimited++;
			return;
		}
		this.detach(this.mergeAnnounceSnapshot(from, snap), 'mergeAnnounceSnapshot');
	}
```

new_string: same but `this.diag.rejected.rateLimited++;` → `this.diag.rejected.rateLimited.announce++;`

## Edit #8 — wire `onMalformed` into the `registerMaybeAct(...)` call site (~lines 1234-1242)

File: `packages/fret/src/service/fret-service.ts`

old_string:
```
				registerMaybeAct(
					this.node,
					async (msg, from) => {
						this.detach(this.noteInboundRpc(from), 'noteInboundRpc(maybeAct)');
						return await this.handleMaybeAct(msg);
					},
					this.protocols.PROTOCOL_MAYBE_ACT,
					this.maxBytesMaybeAct()
				),
```

new_string:
```
				registerMaybeAct(
					this.node,
					async (msg, from) => {
						this.detach(this.noteInboundRpc(from), 'noteInboundRpc(maybeAct)');
						return await this.handleMaybeAct(msg);
					},
					this.protocols.PROTOCOL_MAYBE_ACT,
					this.maxBytesMaybeAct(),
					() => { this.diag.rejected.malformed++; }
				),
```

## Edit #9a — `packages/fret/src/rpc/maybe-act.ts` imports (top of file)

old_string:
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

new_string:
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

## Edit #9b — `packages/fret/src/rpc/maybe-act.ts` `registerMaybeAct` body

old_string:
```
export async function registerMaybeAct(
	node: Libp2p,
	handle: (msg: RouteAndMaybeActV1, from: string) => Promise<NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }>,
	protocol = PROTOCOL_MAYBE_ACT,
	maxBytes = MAX_ACTIVITY_BYTES + MAYBE_ACT_OVERHEAD_BYTES
): Promise<void> {
	// No inbound `from` on RouteAndMaybeAct, but thread the transport-authenticated
	// sender id through to `handle` for future per-peer rate limiting / diagnostics.
	// Errors and stream release belong to `registerRpcHandler`, not this body — including the
	// close, which the seam performs under its own budget so a remote that stops reading cannot
	// hold the handler open.
	await registerRpcHandler(node, protocol, async (stream, connection) => {
		const bytes = await readFramed(stream, maxBytes);
		const msg = decodeJson<RouteAndMaybeActV1>(bytes);
		const res = await handle(msg, connection.remotePeer.toString());
		sendFramed(stream, encodeJson(res));
	});
}
```

new_string:
```
export async function registerMaybeAct(
	node: Libp2p,
	handle: (msg: RouteAndMaybeActV1, from: string) => Promise<NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }>,
	protocol = PROTOCOL_MAYBE_ACT,
	maxBytes = MAX_ACTIVITY_BYTES + MAYBE_ACT_OVERHEAD_BYTES,
	onMalformed?: () => void
): Promise<void> {
	// No inbound `from` on RouteAndMaybeAct, but thread the transport-authenticated
	// sender id through to `handle` for future per-peer rate limiting / diagnostics.
	// Errors and stream release belong to `registerRpcHandler`, not this body — including the
	// close, which the seam performs under its own budget so a remote that stops reading cannot
	// hold the handler open.
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

`NearAnchorV1` is already imported in this file (`import type { RouteAndMaybeActV1, NearAnchorV1, BusyResponseV1 } from '../index.js';` — untouched by this edit).

## Steps after Edits #1-9b land

6. `test/inflight-concurrency.spec.ts`: assert on `diag.rejected.concurrencyLimited`, drop/rewrite the stale comment about the shared counter being unambiguous by construction (see *Edge cases* below).
7. `test/profile.behavior.spec.ts`: update every read of `diag.rejected.rateLimited` to the keyed shape (`diag.rejected.rateLimited.<protocol>`); check for any site summing across protocols and sum the record's values there instead.
8. `docs/fret.md`: three sites named under *Edge cases* below.
9. `cd packages/fret && npx tsc --noEmit && yarn test` (targeted specs first, then full suite) before handoff.

## If budget runs out again before step 9 completes

Commit whatever subset landed. Update this resume-note in place (don't append a duplicate copy —
overwrite) to say exactly which edits completed and which remain, striking completed ones from the
list above. Do not re-paste the whole history again.

## Resolved design

Replace the single `rejected.rateLimited: number` field with a keyed record, one slot per
protocol, plus one new sibling field for the concurrency-cap case (a different mechanism
entirely, not a rate limit):

```ts
rejected: {
	payloadTooLarge: number;
	timestampBounds: number;
	ttlExpired: number;
	identityMismatch: number;
	malformed: number;
	/** Per-protocol token-bucket rejections — which wire protocol's bucket was empty. */
	rateLimited: Record<'neighbors' | 'ping' | 'maybeAct' | 'leave' | 'announce', number>;
	/** maybeAct inflight-concurrency-cap saturation (Core 16 / Edge 4) — distinct from a token-bucket rejection: this fires when the bucket had a token but the peer is already working on as many maybeAct requests as it allows at once. */
	concurrencyLimited: number;
}
```

This is a keyed record rather than a tagged-enum log or anything heavier, because the only
requirement is "read out per protocol, cheaply, synchronously" — a record satisfies that with the
least churn to the public diagnostics shape, and a reason added later gets a new record key or a
new sibling field rather than reusing someone else's.

### Call-site mapping (six sites → their own slot)

- line 1290, `handleNeighborsRequest` (`bucketNeighbors.tryTake()` fails) → `rateLimited.neighbors++`
- line 1298, `handlePingRequest` (`bucketPing.tryTake()` fails) → `rateLimited.ping++`
- line 1381, `handleMaybeAct` (`bucketMaybeAct.tryTake()` fails — the token bucket) → `rateLimited.maybeAct++`
- line 1421, `handleMaybeAct` (`this.inflightAct >= limit` — the concurrency cap) → `concurrencyLimited++` (**not** `rateLimited.maybeAct` — this is the mechanism the original ticket singled out as "a different mechanism entirely")
- line 1838, `handleLeave` (`bucketLeave.tryTake()` fails) → `rateLimited.leave++`
- line 1999, `handleAnnounce` (`bucketAnnounceInbound.tryTake()` fails) → `rateLimited.announce++`

## Second arm: maybeAct silently drops undecodable bodies with no counter movement

`handleMaybeAct` is not on the shared `registerJsonHandler` seam the other four handlers use (its
token bucket must be taken before any per-message work, which that seam cannot do). Today an
undecodable body in `registerMaybeAct` throws out of the handler, which `registerRpcHandler`'s
wrapper catches by `abort()`-ing the stream — tearing the connection down with **no diagnostic
counter incremented at all**. Edit #9b fixes this: wrap the decode in try/catch, count it under
`diag.rejected.malformed` (the same bucket a structurally-invalid-but-decodable message already
falls into via `parseRouteAndMaybeAct` returning `undefined`), and reply with the same static
reject the malformed-structure path already returns instead of aborting the connection.

## Edge cases & interactions

- **Concurrency-cap saturation must never be counted under `rateLimited.maybeAct`.** This is the
  exact conflation the original ticket flagged as sharpest (a flood vs. a sizing/capacity issue an
  operator would act on differently) — a regression here silently re-merges the two counters the
  ticket exists to split apart. `test/inflight-concurrency.spec.ts` must assert on
  `diag.rejected.concurrencyLimited`, not `rateLimited.maybeAct`.
- **A busy reply from the token bucket and a busy reply from the concurrency cap still look
  identical on the wire** (`{busy: true, retry_after_ms: ...}` either way) — only the local
  diagnostic distinguishes them now. Not a wire-protocol change; none needed or in scope.
- **The maybeAct concurrency-cap spec (`test/inflight-concurrency.spec.ts`) currently relies on the
  shared counter being unambiguous by construction** — it sizes fan-out to stay inside the token
  bucket so no too-fast rejection mixes into the tally it asserts on. Once the counters split, that
  constraint is no longer load-bearing; remove/update the comment explaining it, since the spec
  should now assert on `concurrencyLimited` directly regardless of bucket sizing.
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
