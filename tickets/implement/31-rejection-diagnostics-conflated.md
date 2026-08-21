description: When the service turns a request away for being over a limit, every different reason for turning it away is added to one shared tally, so an operator watching a node cannot tell which limit was hit, or even which kind of request hit it. Fix by giving each reason its own slot instead of one shared counter.
files: packages/fret/src/service/fret-service.ts (the `diag.rejected` object ~415; six `rejected.rateLimited++` sites at lines 1290, 1298, 1381, 1421, 1838, 1999), packages/fret/src/rpc/maybe-act.ts, packages/fret/test/profile.behavior.spec.ts, packages/fret/test/inflight-concurrency.spec.ts, docs/fret.md
difficulty: easy
tradeoffs: n/a (implement ticket)
---

<!-- resume-note -->
**8th run in a row died to BUDGET_WARNING right after the two precondition Reads, before any Edit
fired.** Nothing has landed in the codebase yet — zero edits applied across all runs so far. Prior
tickets kept re-verifying content and re-pasting rationale every run, which is likely why this
keeps dying early; this rewrite strips every section that isn't needed to execute, down to just the
9 literal edits + the follow-up steps. **Do not re-read fret-service.ts or maybe-act.ts beyond the
one small precondition Read each** (Edit tool requires one Read per file per conversation before
its first Edit on that file — e.g. `fret-service.ts` lines 405-430, `maybe-act.ts` in full — this
is NOT re-verification, the content below is already confirmed correct across 8 runs). Fire Edits
#1-#9b back to back with no reasoning pauses, then do steps 6-9.

If this run also dies before finishing: commit whatever landed, overwrite this resume-note in place
(don't append) naming exactly which edits completed, strike them from the list below, do not
re-paste rationale.

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

new_string: same but `this.diag.rejected.rateLimited++` → `this.diag.rejected.concurrencyLimited++` (NOT `rateLimited.maybeAct` — this is the exact conflation the ticket exists to split apart: a token-bucket flood vs. an inflight-capacity issue, mechanism split, different remediation)

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

Purpose: today an undecodable maybeAct body throws out of the handler, which `registerRpcHandler`
aborts the stream for — no diagnostic counter moves at all. This wraps the decode in try/catch,
counts it under `diag.rejected.malformed` (same bucket a structurally-invalid-but-decodable message
already falls into via `parseRouteAndMaybeAct` returning `undefined`), and replies with the same
static empty-anchor reject the malformed-structure path already returns, instead of aborting.

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

6. `test/inflight-concurrency.spec.ts`: assert on `diag.rejected.concurrencyLimited` (not
   `rateLimited.maybeAct` — that would silently re-merge the two counters this ticket splits
   apart). Drop/rewrite the comment about the shared counter being unambiguous by construction —
   it relied on sizing fan-out to stay inside the token bucket so no too-fast rejection mixed into
   the tally; once split that constraint is no longer load-bearing.
7. `test/profile.behavior.spec.ts`: update every read of `diag.rejected.rateLimited` to the keyed
   shape (`diag.rejected.rateLimited.<protocol>`); if any site sums across protocols, sum the
   record's values there instead.
8. `docs/fret.md` — three sites name the old flat counter, update all three:
   - departure-notice section: "The only local signal is `diag.rejected.rateLimited`" → name the
     specific keyed field, `rateLimited.leave`.
   - concurrency-cap bullet under *Operating profiles*: "a bucket rejection and an inflight
     rejection both increment `diag.rejected.rateLimited` and differ only in `retry_after_ms`" —
     this sentence becomes **false** under the new design; rewrite to say they increment different
     fields (`rateLimited.maybeAct` vs `concurrencyLimited`), which is the fix.
   - security section's rate-limiting bullet mentioning `diag.rejected.rateLimited` generically —
     update to describe the per-protocol keyed shape.
   - Do not touch the other five `rejected.*` fields (`payloadTooLarge`, `timestampBounds`,
     `ttlExpired`, `identityMismatch`, `malformed`) — already unambiguous, out of scope.
9. `cd packages/fret && npx tsc --noEmit && yarn test` (targeted specs first, then full suite)
   before handoff to review/.
