import type { Libp2p } from 'libp2p';
import type { Connection, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { PROTOCOL_MAYBE_ACT, encodeJson, decodeJson, readAllBounded, openRpcStream } from './protocols.js';
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

export async function sendMaybeAct(
	node: Libp2p,
	peerIdStr: string,
	msg: RouteAndMaybeActV1,
	protocol = PROTOCOL_MAYBE_ACT
): Promise<NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }> {
	const pid = peerIdFromString(peerIdStr);
	let stream: Stream | undefined;
	try {
		stream = await openRpcStream(node, pid, [protocol]);
		stream!.send(await encodeJson(msg));
		await stream!.close();
		const bytes = await readAllBounded(stream!, 512 * 1024);
		return await decodeJson(bytes);
	} finally {
		if (stream != null) {
			try { await stream.close(); } catch {}
		}
	}
}

