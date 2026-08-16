import type { Libp2p } from 'libp2p';
import type { Connection, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import {
	PROTOCOL_MAYBE_ACT,
	RPC_TIMEOUT_MS,
	encodeJson,
	decodeJson,
	readAllBounded,
	openRpcStream,
	releaseRpcStream,
} from './protocols.js';
import { deadline } from '../utils/deadline.js';
import type { RouteAndMaybeActV1, NearAnchorV1, BusyResponseV1 } from '../index.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:maybeAct');

export async function registerMaybeAct(
	node: Libp2p,
	handle: (msg: RouteAndMaybeActV1, from: string) => Promise<NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }>,
	protocol = PROTOCOL_MAYBE_ACT,
	maxBytes = 512 * 1024
): Promise<void> {
	// No inbound `from` on RouteAndMaybeAct, but thread the transport-authenticated
	// sender id through to `handle` for future per-peer rate limiting / diagnostics.
	await node.handle(protocol, async (stream: Stream, connection: Connection) => {
		try {
			const bytes = await readAllBounded(stream, maxBytes);
			const msg = await decodeJson<RouteAndMaybeActV1>(bytes);
			const res = await handle(msg, connection.remotePeer.toString());
			stream.send(await encodeJson(res));
			await stream.close();
		} catch (err) {
			log.error('maybeAct handler error - %e', err);
		}
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
): Promise<NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }> {
	const pid = peerIdFromString(peerIdStr);
	const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;
	const d = deadline(timeoutMs, opts.signal);
	let stream: Stream | undefined;
	try {
		stream = await openRpcStream(node, pid, [protocol], { signal: d.signal });
		stream!.send(await encodeJson(msg));
		// Half-close: this is the write-side flush the responder waits on, not cleanup — the
		// read below depends on it, so it stays inside the `try`.
		await stream!.close();
		const bytes = await readAllBounded(stream!, 512 * 1024, timeoutMs, { signal: d.signal });
		return await decodeJson(bytes);
	} finally {
		await releaseRpcStream(stream, d.signal);
		d.cancel();
	}
}

