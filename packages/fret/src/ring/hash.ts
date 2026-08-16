import type { PeerId } from '@libp2p/interface';
import { sha256 } from 'multiformats/hashes/sha2';
import { toString as u8ToString } from 'uint8arrays/to-string';
import { fromString as u8FromString } from 'uint8arrays/from-string';

export const RING_BITS = 256;
export const COORD_BYTES = 32;

export type RingCoord = Uint8Array;

export async function hashPeerId(peerId: PeerId): Promise<RingCoord> {
	// Use raw multihash bytes of peerId as input
	const bytes = peerId.toMultihash().bytes;
	const digest = await sha256.encode(bytes);
	return digest;
}

export async function hashKey(key: Uint8Array): Promise<RingCoord> {
	const digest = await sha256.encode(key);
	return digest;
}

/** Byte value → its fixed-width hex pair. Built once; see {@link coordToHex}. */
const HEX_PAIR: readonly string[] = Array.from(
	{ length: 256 },
	(_, b) => b.toString(16).padStart(2, '0')
);

/**
 * Fixed-length 64 hex chars — the encoding the routing store's tree key is built from.
 *
 * This is the hottest pure function in FRET: `DigitreeStore` embeds the hex coordinate in
 * every tree key, so it runs once per store write *and* once per ring walk (each walk seeks
 * by `hex(coord)`), which puts it under neighbor exchange, cohort assembly, next-hop
 * selection and size estimation alike. Formatting each byte with
 * `toString(16).padStart(2, '0')` allocates two throwaway strings per byte — 64 per
 * coordinate — and measured **38% of total CPU** in the N=100 simulation spec. The lookup
 * table is therefore load-bearing rather than a micro-optimization: the output is identical,
 * but the per-byte allocations are gone.
 */
export function coordToHex(coord: RingCoord): string {
	let s = '';
	for (let i = 0; i < coord.length; i++) s += HEX_PAIR[coord[i]!];
	return s;
}

const HEX_COORD_RE = new RegExp(`^[0-9a-fA-F]{${COORD_BYTES * 2}}$`);

export function hexToCoord(hex: string): RingCoord {
	if (!HEX_COORD_RE.test(hex)) {
		throw new Error(`hexToCoord: expected ${COORD_BYTES * 2} hex chars, got ${JSON.stringify(hex)}`);
	}
	const out = new Uint8Array(COORD_BYTES);
	for (let i = 0; i < COORD_BYTES; i++) {
		out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

export function coordToBase64url(coord: RingCoord): string {
	return u8ToString(coord, 'base64url');
}

export function base64urlToCoord(s: string): RingCoord {
	const coord = u8FromString(s, 'base64url');
	if (coord.length !== COORD_BYTES) {
		throw new Error(`base64urlToCoord: expected ${COORD_BYTES} bytes, got ${coord.length}`);
	}
	return coord;
}
