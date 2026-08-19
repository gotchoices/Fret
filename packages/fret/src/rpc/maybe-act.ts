import type { Libp2p } from 'libp2p';
import { fromString as u8FromString } from 'uint8arrays/from-string';
import {
	PROTOCOL_MAYBE_ACT,
	encodeJson,
	decodeJson,
	readFramed,
	sendFramed,
	registerRpcHandler,
} from './protocols.js';
import { rpcRequest } from './request.js';
import type { RpcOutcome } from './outcome.js';
import type { RouteAndMaybeActV1, NearAnchorV1, BusyResponseV1 } from '../index.js';

export async function registerMaybeAct(
	node: Libp2p,
	handle: (msg: RouteAndMaybeActV1, from: string) => Promise<NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }>,
	protocol = PROTOCOL_MAYBE_ACT,
	maxBytes = 512 * 1024
): Promise<void> {
	// No inbound `from` on RouteAndMaybeAct, but thread the transport-authenticated
	// sender id through to `handle` for future per-peer rate limiting / diagnostics.
	// Errors and stream release belong to `registerRpcHandler`, not this body — including the
	// close, which the seam performs under its own budget so a remote that stops reading cannot
	// hold the handler open.
	await registerRpcHandler(node, protocol, async (stream, connection) => {
		const bytes = await readFramed(stream, maxBytes);
		const msg = await decodeJson<RouteAndMaybeActV1>(bytes);
		const res = await handle(msg, connection.remotePeer.toString());
		sendFramed(stream, await encodeJson(res));
	});
}

/** Encoded `key` cap — generous against real content keys (≤ 64 raw bytes today). */
const MAX_KEY_CHARS = 1024;
/** Minted ids are `selfId|timestamp|uuid` ≈ 100 chars; the cap bounds the dedup-cache key. */
const MAX_CORRELATION_ID_CHARS = 256;
/** Breadcrumbs grow one per hop and TTL bounds hops; 64 is far past any real route. */
const MAX_BREADCRUMBS = 64;

/**
 * Structural validity of an inbound `RouteAndMaybeAct` — everything downstream code touches
 * without checking, and nothing more. Pure and O(size of the message): no hashing, no ring
 * walks, no libp2p. The caller runs it immediately after taking the rate-limit token (so
 * malformed floods are metered) and before every other guard (which read fields this vouches
 * for — `breadcrumbs?.includes` on a number was a throw the old handler never survived).
 *
 * `key` is checked by actually decoding it, so a caller that passes may decode it once and
 * hand the bytes down — the double-throw where `routeAct` and its `nearAnchorOnly` fallback
 * both choked on the same undecodable key is what made the fallback useless.
 *
 * NOTE: maybeAct-only today; `plan/15-rpc-shared-helper` generalizes this validator to the
 * other wire messages rather than growing a per-handler copy each.
 */
export function validateRouteAndMaybeAct(msg: unknown): msg is RouteAndMaybeActV1 {
	if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return false;
	const m = msg as Record<string, unknown>;
	if (typeof m.key !== 'string' || m.key.length > MAX_KEY_CHARS) return false;
	try { u8FromString(m.key, 'base64url'); } catch { return false; }
	if (!Number.isFinite(m.ttl)) return false;
	if (!Number.isFinite(m.want_k)) return false;
	if (!Number.isFinite(m.min_sigs)) return false;
	if (!Number.isFinite(m.timestamp)) return false;
	if (m.wants !== undefined && !Number.isFinite(m.wants)) return false;
	if (m.breadcrumbs !== undefined) {
		if (!Array.isArray(m.breadcrumbs) || m.breadcrumbs.length > MAX_BREADCRUMBS) return false;
		if (!m.breadcrumbs.every((b) => typeof b === 'string')) return false;
	}
	if (typeof m.correlation_id !== 'string' || m.correlation_id.length > MAX_CORRELATION_ID_CHARS) return false;
	if (m.activity !== undefined && typeof m.activity !== 'string') return false;
	if (m.digest !== undefined && typeof m.digest !== 'string') return false;
	return true;
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
		maxBytes: 512 * 1024,
		decode: (b) => decodeJson<NearAnchorV1 | { commitCertificate: string }>(b),
	});
}

