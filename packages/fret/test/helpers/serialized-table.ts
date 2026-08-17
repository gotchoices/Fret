import type { SerializedPeerEntry, SerializedTable } from '../../src/store/digitree-store.js'
import { COORD_BYTES, coordToBase64url } from '../../src/ring/hash.js'

/**
 * One `SerializedTable` record, with the fields a snapshot always carries filled in and the
 * rest overridable.
 *
 * `coord` takes either a full ring coordinate or a single byte, which is written at index 0.
 * The byte form is enough whenever a spec only needs a handful of peers in a known order and
 * does not care where they sit relative to *self*; a spec that does care (capacity protection
 * around self, say) builds its coordinates from self's own with `ringOffset` and passes them
 * whole.
 *
 * Shared rather than copied because two specs now drive `FretService.importTable` — the
 * persistence round-trip and the capacity/eviction cases — and a second copy of the record
 * shape drifts from this one the moment `SerializedPeerEntry` gains a field.
 */
export function serializedPeer(
	id: string,
	coord: Uint8Array | number,
	over: Partial<SerializedPeerEntry> = {}
): SerializedPeerEntry {
	let bytes: Uint8Array
	if (typeof coord === 'number') {
		bytes = new Uint8Array(COORD_BYTES)
		bytes[0] = coord
	} else {
		bytes = coord
	}
	return {
		id,
		coord: coordToBase64url(bytes),
		relevance: 1,
		lastAccess: 0,
		state: 'connected',
		membership: 'member',
		accessCount: 0,
		successCount: 0,
		failureCount: 0,
		avgLatencyMs: null,
		...over,
	}
}

export function tableOf(entries: SerializedPeerEntry[], peerId = 'exporter'): SerializedTable {
	return { v: 1, peerId, timestamp: Date.now(), entries }
}
