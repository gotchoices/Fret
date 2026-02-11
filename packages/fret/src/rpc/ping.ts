import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { PROTOCOL_PING, encodeJson, decodeJson } from './protocols.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:ping');

export interface PingResponseV1 {
	ok: boolean;
	ts: number;
	size_estimate?: number;
	confidence?: number;
}

export type SizeEstimateProvider = () => { size_estimate?: number; confidence?: number } | Promise<{ size_estimate?: number; confidence?: number }>;

export function registerPing(
	node: Libp2p,
	protocol = PROTOCOL_PING,
	getSizeEstimate?: SizeEstimateProvider
): void {
	void node.handle(protocol, async (stream: Stream) => {
		const response: PingResponseV1 = { ok: true, ts: Date.now() };

		// Add network size hint if provider available
		if (getSizeEstimate) {
			try {
				const sizeInfo = await getSizeEstimate();
				if (sizeInfo.size_estimate !== undefined) {
					response.size_estimate = sizeInfo.size_estimate;
					response.confidence = sizeInfo.confidence;
				}
			} catch (err) {
				log.error('getSizeEstimate failed - %e', err);
			}
		}

		stream.send(await encodeJson(response));
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
		const bytes = await readAll(stream);
		const rttMs = Math.max(0, Date.now() - start);
		if (bytes.length === 0) return { ok: false, rttMs };
		try {
			const res = await decodeJson<PingResponseV1>(bytes);
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

function toBytes(chunk: Uint8Array | { subarray(): Uint8Array }): Uint8Array {
	if (chunk instanceof Uint8Array) return chunk;
	return chunk.subarray();
}

async function readAll(stream: Stream): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	for await (const chunk of stream) parts.push(toBytes(chunk));
	let len = 0;
	for (const p of parts) len += p.length;
	const out = new Uint8Array(len);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}
