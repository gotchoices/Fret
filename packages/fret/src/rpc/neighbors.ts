import type { Libp2p } from 'libp2p';
import {
	PROTOCOL_NEIGHBORS,
	PROTOCOL_NEIGHBORS_ANNOUNCE,
	decodeJson,
	registerJsonHandler,
} from './protocols.js';
import { rpcRequest } from './request.js';
import { makeSnapshotParser } from './validate.js';
import type { Parser } from './validate.js';
import type { RpcOutcome } from './outcome.js';
import type { NeighborSnapshotV1, BusyResponseV1 } from '../index.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:neighbors');

export async function registerNeighbors(
	node: Libp2p,
	getSnapshot: () => NeighborSnapshotV1 | BusyResponseV1 | Promise<NeighborSnapshotV1 | BusyResponseV1>,
	onAnnounce?: (from: string, snapshot: NeighborSnapshotV1) => void,
	protocols = { PROTOCOL_NEIGHBORS, PROTOCOL_NEIGHBORS_ANNOUNCE },
	maxBytes = 128 * 1024,
	onIdentityMismatch?: (claimed: string, actual: string) => void,
	onInbound?: (from: string) => void,
	// Trailing and defaulted so existing positional callers keep compiling (TypeScript forbids a
	// required parameter after an optional one). The `Infinity` caps mean "validate the shape,
	// truncate nothing": the default copies no cap numbers from anywhere, and
	// `Array.prototype.slice(0, Infinity)` is well-defined. `FretService` always supplies
	// `makeSnapshotParser(this.mergeSnapshotCaps())`, so production truncation is unchanged.
	snapshotParser: Parser<NeighborSnapshotV1> = makeSnapshotParser({
		successors: Number.POSITIVE_INFINITY,
		predecessors: Number.POSITIVE_INFINITY,
		sample: Number.POSITIVE_INFINITY,
	}),
	onMalformed?: (reason: 'decode' | 'parse') => void
): Promise<void> {
	// The request carries no inbound `from`, but the connection's remote peer is
	// transport-authenticated — and reaching this handler at all means the remote dialed
	// *this network's* namespaced protocol. `onInbound` hands that proof to the caller.
	// Reply-only: this protocol reads no request body, so it takes the body-less overload of
	// `registerJsonHandler`. Encoding, errors and stream release belong to the seam, not these
	// bodies — including the close, which it performs under its own budget so a remote that stops
	// reading cannot hold the handler open.
	await registerJsonHandler(node, protocols.PROTOCOL_NEIGHBORS, {
		// Not an `async` arrow: it hands back `getSnapshot()`'s own promise. Same reasoning as
		// ping — this protocol reads no request body, so the reply is the first thing on the
		// stream and an extra async hop is pure latency before the caller's first read.
		serve: (connection) => {
			onInbound?.(connection.remotePeer.toString());
			return getSnapshot();
		},
	});

	if (onAnnounce) {
		await registerJsonHandler(node, protocols.PROTOCOL_NEIGHBORS_ANNOUNCE, {
			maxBytes,
			parse: snapshotParser,
			onMalformed,
			serve: (snap, connection) => {
				// The snapshot's self-reported `from` must match the transport-authenticated
				// remote peer — otherwise a connected peer can impersonate another and poison
				// the routing table via a forged sample/successor set. Returning `undefined`
				// drops without replying — a normal outcome, not a failure, so the seam closes
				// and never aborts. The parser has already vouched that `from` parses as a peer
				// id, so this compares two well-formed ids.
				const actual = connection.remotePeer.toString();
				if (snap.from !== actual) {
					onIdentityMismatch?.(snap.from, actual);
					// NOTE: debug-gated (@libp2p/logger emits only under DEBUG). If mismatch logging
					// is ever routed to an always-on sink, a hostile peer can spam it — rate-limit then.
					log.error('announce identity mismatch: claimed %s actual %s - dropping', snap.from, actual);
					return undefined;
				}
				onAnnounce(snap.from, snap);
				return { ok: true };
			},
		});
	}
}
/**
 * Fetch `peerIdOrStr`'s neighbor snapshot. Connection-only (dial `'never'`): no existing
 * connection yields `skipped` — nothing attempted, nothing fabricated. Every failure mode is
 * its own `RpcOutcome` variant; the decoded snapshot is not shape-validated beyond "JSON
 * object" (parity with the cast this replaced).
 */
export async function fetchNeighbors(
	node: Libp2p,
	peerIdOrStr: string,
	protocol = PROTOCOL_NEIGHBORS,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<RpcOutcome<NeighborSnapshotV1>> {
	return rpcRequest(node, peerIdOrStr, protocol, {
		...opts,
		dial: 'never',
		maxBytes: 128 * 1024,
		decode: (b) => decodeJson<NeighborSnapshotV1>(b),
	});
}

/**
 * Push our snapshot to `peerIdOrStr`.
 *
 * Connection-only by default (announcing is maintenance; dialing for it adds churn). Callers
 * that deliberately target *non-connected* peers — the "tell peers we just learned about"
 * paths, whose whole point is reaching someone we are not talking to yet — pass `dial: true`.
 * Those callers own the reachability check: dialing a peer libp2p holds no address for can
 * only fail (FRET's wire format carries peer ids, never multiaddrs).
 */
export async function announceNeighbors(
	node: Libp2p,
	peerIdOrStr: string,
	snapshot: NeighborSnapshotV1,
	protocol = PROTOCOL_NEIGHBORS_ANNOUNCE,
	opts: { dial?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<RpcOutcome<undefined>> {
	// Write-only: `ok` proves the body reached the transport, nothing more. No swallow — the
	// caller sees every outcome now.
	return rpcRequest(node, peerIdOrStr, protocol, {
		signal: opts.signal,
		timeoutMs: opts.timeoutMs,
		dial: opts.dial === true ? 'always' : 'never',
		body: snapshot,
	});
}
