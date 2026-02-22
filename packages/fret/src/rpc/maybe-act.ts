import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { PROTOCOL_MAYBE_ACT, encodeJson, decodeJson, readAllBounded } from './protocols.js';
import type { RouteAndMaybeActV1, NearAnchorV1, BusyResponseV1 } from '../index.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:maybeAct');

export function registerMaybeAct(
	node: Libp2p,
	handle: (msg: RouteAndMaybeActV1) => Promise<NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }>,
	protocol = PROTOCOL_MAYBE_ACT,
	maxBytes = 512 * 1024
): void {
	void node.handle(protocol, async (stream: Stream) => {
		try {
			const bytes = await readAllBounded(stream, maxBytes);
			const msg = await decodeJson<RouteAndMaybeActV1>(bytes);
			const res = await handle(msg);
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
	const conns = node.getConnections(pid);
	let stream: Stream | undefined;
	try {
		if (conns.length > 0) {
			stream = await conns[0].newStream([protocol]);
		} else {
			stream = await node.dialProtocol(pid, [protocol]);
		}
		stream.send(await encodeJson(msg));
		await stream.close();
		const bytes = await readAllBounded(stream, 512 * 1024);
		return await decodeJson(bytes);
	} finally {
		if (stream != null) {
			try { await stream.close(); } catch {}
		}
	}
}

