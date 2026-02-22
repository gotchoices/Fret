import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { PROTOCOL_PING, encodeJson, decodeJson, readAllBounded } from './protocols.js';
import type { BusyResponseV1 } from '../index.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:ping');

export interface PingResponseV1 {
	ok: boolean;
	ts: number;
	size_estimate?: number;
	confidence?: number;
}

export type SizeEstimateProvider = () => { size_estimate?: number; confidence?: number } | BusyResponseV1 | Promise<{ size_estimate?: number; confidence?: number } | BusyResponseV1>;

function isBusy(res: unknown): res is BusyResponseV1 {
	return typeof res === 'object' && res !== null && 'busy' in res && (res as any).busy === true;
}

export function registerPing(
	node: Libp2p,
	protocol = PROTOCOL_PING,
	getSizeEstimate?: SizeEstimateProvider
): void {
	void node.handle(protocol, async (stream: Stream) => {
		if (getSizeEstimate) {
			try {
				const sizeInfo = await getSizeEstimate();
				if (isBusy(sizeInfo)) {
					stream.send(await encodeJson(sizeInfo));
					await stream.close();
					return;
				}
				const response: PingResponseV1 = { ok: true, ts: Date.now() };
				if (sizeInfo.size_estimate !== undefined) {
					response.size_estimate = sizeInfo.size_estimate;
					response.confidence = sizeInfo.confidence;
				}
				stream.send(await encodeJson(response));
				await stream.close();
				return;
			} catch (err) {
				log.error('getSizeEstimate failed - %e', err);
			}
		}

		stream.send(await encodeJson({ ok: true, ts: Date.now() } satisfies PingResponseV1));
		await stream.close();
	});
}

export async function sendPing(node: Libp2p, peer: string, protocol = PROTOCOL_PING): Promise<{ ok: boolean; rttMs: number; size_estimate?: number; confidence?: number }> {
	const start = Date.now();
	const pid = peerIdFromString(peer);
	let stream: Stream | undefined;
	try {
		const conns = node.getConnections(pid);
		if (conns.length > 0) {
			stream = await conns[0].newStream([protocol]);
		} else {
			stream = await node.dialProtocol(pid, [protocol]);
		}
		const bytes = await readAllBounded(stream, 1024);
		const rttMs = Math.max(0, Date.now() - start);
		if (bytes.length === 0) return { ok: false, rttMs };
		try {
			const res = await decodeJson<PingResponseV1 | BusyResponseV1>(bytes);
			if (isBusy(res)) return { ok: false, rttMs };
			return {
				ok: Boolean(res.ok),
				rttMs,
				size_estimate: res.size_estimate,
				confidence: res.confidence
			};
		} catch (err) {
			log.error('sendPing decode failed - %e', err);
			return { ok: false, rttMs };
		}
	} finally {
		if (stream != null) {
			try { await stream.close(); } catch { }
		}
	}
}

