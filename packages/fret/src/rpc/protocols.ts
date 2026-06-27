import type { Libp2p } from 'libp2p';
import type { Connection, PeerId, Stream } from '@libp2p/interface';

export function makeProtocols(networkName = 'default') {
	const prefix = `/optimystic/${networkName}/fret/1.0.0`;
	return {
		PROTOCOL_NEIGHBORS: `${prefix}/neighbors`,
		PROTOCOL_NEIGHBORS_ANNOUNCE: `${prefix}/neighbors/announce`,
		PROTOCOL_MAYBE_ACT: `${prefix}/maybeAct`,
		PROTOCOL_LEAVE: `${prefix}/leave`,
		PROTOCOL_PING: `${prefix}/ping`,
	};
}

// Backward compatibility: default export uses 'default' network
export const PROTOCOL_NEIGHBORS = '/optimystic/default/fret/1.0.0/neighbors';
export const PROTOCOL_NEIGHBORS_ANNOUNCE = '/optimystic/default/fret/1.0.0/neighbors/announce';
export const PROTOCOL_MAYBE_ACT = '/optimystic/default/fret/1.0.0/maybeAct';
export const PROTOCOL_LEAVE = '/optimystic/default/fret/1.0.0/leave';
export const PROTOCOL_PING = '/optimystic/default/fret/1.0.0/ping';

export async function encodeJson(obj: unknown): Promise<Uint8Array> {
	const text = JSON.stringify(obj);
	return new TextEncoder().encode(text);
}

export async function decodeJson<T = unknown>(bytes: Uint8Array): Promise<T> {
	// guard against binary frames or empty buffers from underlying muxers
	if (bytes.byteLength === 0) throw new Error('empty response');
	// strip any leading/trailing nulls/whitespace
	let start = 0;
	let end = bytes.byteLength;
	while (start < end && (bytes[start] === 0 || bytes[start] === 9 || bytes[start] === 10 || bytes[start] === 13 || bytes[start] === 32)) start++;
	while (end > start && (bytes[end - 1] === 0 || bytes[end - 1] === 9 || bytes[end - 1] === 10 || bytes[end - 1] === 13 || bytes[end - 1] === 32)) end--;
	if (end <= start) throw new Error('whitespace response');
	const text = new TextDecoder().decode(bytes.subarray(start, end));
	return JSON.parse(text) as T;
}

export function toBytes(chunk: Uint8Array | { subarray(): Uint8Array }): Uint8Array {
	if (chunk instanceof Uint8Array) return chunk;
	return chunk.subarray();
}

export async function readAllBounded(
	stream: AsyncIterable<Uint8Array | { subarray(): Uint8Array }>,
	maxBytes: number,
	timeoutMs = 5000
): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	let len = 0;
	const iter = stream[Symbol.asyncIterator]();
	const deadline = Date.now() + timeoutMs;
	// Short idle timeout after first data arrives — works around muxer
	// implementations that fail to propagate remote-close EOF.
	const idleMs = 100;

	while (true) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		const chunkTimeout = len > 0 ? Math.min(remaining, idleMs) : remaining;

		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<IteratorResult<any>>(r => {
			timer = setTimeout(() => r({ done: true, value: undefined }), chunkTimeout);
		});
		const next = iter.next();
		next.catch(() => {}); // Prevent unhandled rejection if timeout wins
		const result = await Promise.race([next, timeout]);
		clearTimeout(timer);

		if (result.done) break;

		const bytes = toBytes(result.value);
		len += bytes.length;
		if (len > maxBytes) throw new Error(`payload too large: ${len} exceeds ${maxBytes} byte limit`);
		parts.push(bytes);
	}

	const out = new Uint8Array(len);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

export function validateTimestamp(ts: number, maxDriftMs = 300_000): boolean {
	return Math.abs(Date.now() - ts) <= maxDriftMs;
}

/**
 * True for a circuit-relay ("limited") connection. libp2p stamps a relayed
 * connection with `limits` (per-circuit data/duration caps); we additionally
 * sniff the multiaddr for `/p2p-circuit` as a fallback for transports/versions
 * that don't populate `limits`.
 */
function isLimitedConnection(c: Connection): boolean {
	if ((c as { limits?: unknown }).limits != null) return true;
	const addr = c.remoteAddr?.toString?.();
	return addr != null && addr.includes('/p2p-circuit');
}

/**
 * Open an RPC stream to `pid`, preferring a DIRECT open connection and falling
 * back to a limited (circuit-relay) one.
 *
 * `runOnLimitedConnection: true` is REQUIRED for the relayed path — libp2p
 * rejects a stream over a limited connection without it — and is a harmless
 * no-op on a direct connection. Preferring a direct connection avoids riding a
 * circuit that the relay can reset once a per-circuit cap or reservation lapses
 * (and which briefly coexists with the upgraded direct link after DCUtR).
 *
 * When `requireExisting` is set the caller skips dialing if no connection
 * exists (neighbors fetch/announce reduce churn this way) and `undefined` is
 * returned; otherwise we `dialProtocol`.
 */
export async function openRpcStream(
	node: Libp2p,
	pid: PeerId,
	protocols: string[],
	opts: { requireExisting?: boolean } = {}
): Promise<Stream | undefined> {
	const open = node.getConnections(pid)
		.filter(c => c?.status === 'open' && typeof c?.newStream === 'function');
	// Prefer a direct connection; fall back to the limited one only when it is
	// the only open path (the steady state for browsers and NATed peers).
	const chosen = open.find(c => !isLimitedConnection(c)) ?? open[0];
	const streamOpts = { runOnLimitedConnection: true, negotiateFully: false } as const;
	if (chosen) return chosen.newStream(protocols, streamOpts);
	if (opts.requireExisting) return undefined;
	return node.dialProtocol(pid, protocols, streamOpts);
}
