import { sha256 } from 'multiformats/hashes/sha2';
import { toString as u8ToString } from 'uint8arrays/to-string';
import type { NeighborSnapshotV1 } from '../index.js';

/**
 * What a stabilization pass already knows about each near neighbour, so it can skip the ping
 * and the snapshot fetch it would otherwise spend on every one of them every pass.
 *
 * Two facts per peer, both stamped with the **pass sequence number** rather than the clock:
 *
 * - `heardSeq` — the pass during which the last RPC evidence of life arrived (the peer answered
 *   one of our RPCs, or called one of ours). A ping is redundant while that is recent.
 * - `digest` / `digestSeq` — the fingerprint of the snapshot content this node last **merged**
 *   from the peer, and the pass in which it was last confirmed unchanged. A fetch is redundant
 *   while the peer's ping reply still carries the same fingerprint.
 *
 * Pass numbers, not `Date.now()`: hand-driven passes in a spec land inside one millisecond
 * (15 ms on Windows), where a clock cannot tell pass k from pass k+1, and a window measured in
 * passes scales with the loop's interval for free when the interval backs off. Evidence arriving
 * between pass k's start and pass k+1's start is stamped k.
 *
 * **Invariant: a cached digest is always the fingerprint of content this node actually merged.**
 * That is what makes every race benign — a fetch and an announce for one peer interleaving can
 * cache the older of two digests, which costs one extra fetch on the next mismatch, but can
 * never make the node skip content it has not seen.
 *
 * A plain `Map`, not routing-table fields: the heard stamp is written on every inbound RPC, and
 * a store write per inbound RPC is a B+tree replace on the hot path this exists to cool. Bounded
 * by routing-table membership through {@link prune}; run-scoped through {@link clear}.
 */
export class NearExchange {
	private seq = 0;
	private readonly peers = new Map<string, NearPeerMemory>();

	/** The current pass number; 0 before the first pass. */
	get passSeq(): number {
		return this.seq;
	}

	/** Open the next pass. Returns its number. */
	beginPass(): number {
		return ++this.seq;
	}

	/** RPC evidence of life from `id` arrived in the current pass. */
	noteHeard(id: string): void {
		this.entry(id).heardSeq = this.seq;
	}

	/** `digest` fingerprints content just merged from `id` — or re-confirmed by its ping reply. */
	confirmDigest(id: string, digest: string): void {
		const e = this.entry(id);
		e.digest = digest;
		e.digestSeq = this.seq;
	}

	/** The fingerprint of the content last merged from `id`, if any. */
	digestOf(id: string): string | undefined {
		return this.peers.get(id)?.digest;
	}

	/**
	 * Whether the current pass may skip pinging `id` outright. The caller supplies the connection
	 * check (rule 1); this answers rules 2 and 3:
	 *
	 * 2. proof of life arrived during or after the previous pass — our own answered ping counts,
	 *    so a neighbour that never calls us is still pinged every other pass at most;
	 * 3. a digest is cached and was confirmed within {@link NEAR_PROBE_MAX_SKIPS} passes.
	 *
	 * Rule 3 exists because a skipped probe yields no fingerprint: without it a neighbour that
	 * pings *us* every pass would suppress our probes forever and its content changes would never
	 * be seen. With it every neighbour's content is re-checked at least every fourth pass.
	 */
	canSkipProbe(id: string): boolean {
		const e = this.peers.get(id);
		if (e === undefined || e.digest === undefined) return false;
		return e.heardSeq >= this.seq - 1 && this.seq - e.digestSeq <= NEAR_PROBE_MAX_SKIPS;
	}

	/** Drop every peer `keep` rejects — called beside the other per-pass prunes. */
	prune(keep: (id: string) => boolean): void {
		for (const id of this.peers.keys()) if (!keep(id)) this.peers.delete(id);
	}

	/** Forget every peer. The pass counter is deliberately kept: a cleared map already makes the next pass probe and fetch everyone. */
	clear(): void {
		this.peers.clear();
	}

	private entry(id: string): NearPeerMemory {
		let e = this.peers.get(id);
		if (e === undefined) {
			e = { heardSeq: -1, digestSeq: -1 };
			this.peers.set(id, e);
		}
		return e;
	}
}

/** What {@link NearExchange} remembers per peer; `-1` means "never". */
interface NearPeerMemory {
	heardSeq: number;
	digest?: string;
	digestSeq: number;
}

/**
 * Most consecutive passes a near neighbour's probe may be skipped before it is pinged again
 * regardless of recent traffic — the bound rule 3 of {@link NearExchange.canSkipProbe} enforces.
 * 3 means at least one probe per four passes: 6 s at the 1.5 s base interval. The skip is consulted
 * only while the loop is at that base — a pass the idle backoff delayed probes every near target
 * (see `probeAndFetch`), so a backed-off loop re-checks each neighbour once per interval.
 */
export const NEAR_PROBE_MAX_SKIPS = 3;

/**
 * Characters in a digest {@link snapshotDigest} emits: 16 bytes of SHA-256, base64url, unpadded.
 * The *acceptance* width is the parsers' `MAX_SNAPSHOT_DIGEST_CHARS` (`rpc/validate.ts`), wider
 * on purpose so a longer digest can be introduced here without a parser change.
 */
export const SNAPSHOT_DIGEST_CHARS = 22;

/** The snapshot fields a digest covers — exactly the ones a receiver acts on. */
export type SnapshotDigestInput = Pick<NeighborSnapshotV1, 'successors' | 'predecessors' | 'sample' | 'metadata' | 'hints'>;

/**
 * Fingerprint of the content a receiver acts on in a snapshot: SHA-256 over a canonical JSON
 * encoding, truncated to 16 bytes and base64url-encoded (22 characters).
 *
 * Covered, in this order: `successors` and `predecessors` as emitted (ring order, stable on a
 * stable ring); the sample's **ids only, sorted** — `coord` is never read by the receiver (it is
 * re-hashed from the id), `relevance` drifts every pass, and the selection order follows sparsity
 * scores that wobble; the emitted `metadata` or `null`; and `hints` as `[id, record]` pairs sorted
 * by id, so a re-sealed self record (a relay reservation landing) changes the digest and the
 * neighbour refetches.
 *
 * Not covered: `timestamp`, `size_estimate`, `confidence`, `sig`, `v`, `from` (the cache is keyed
 * by peer). The digest carries no authority — equality means "skip the fetch", anything else means
 * "fetch" — so collision resistance is not needed against an honest peer, and a dishonest peer can
 * already send any snapshot it likes.
 *
 * `await`ed because the hasher is async in browsers.
 */
export async function snapshotDigest(content: SnapshotDigestInput): Promise<string> {
	// NOTE: the sample's id *set* is chosen by sparsity score. If it flaps on a quiet large ring the
	// digest changes every pass and the fetch skip never fires — correct, just a smaller saving. If
	// `diag.nearExchangeSkipped.fetches` stays near zero on such a ring, exclude or quantize the
	// sample here.
	const sampleIds = (content.sample ?? []).map((s) => s.id).sort();
	const hints = (content.hints ?? [])
		.map((h): [string, string] => [h.id, h.record])
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	// NOTE: `metadata` is hashed in `JSON.stringify` key order — stable for one sender reusing one
	// object, but a `setMetadata` with the same keys reordered changes the digest and costs the
	// neighbours one extra fetch. Sort keys here if that ever shows up.
	const canonical = JSON.stringify([
		content.successors,
		content.predecessors,
		sampleIds,
		content.metadata ?? null,
		hints,
	]);
	const digest = await sha256.encode(new TextEncoder().encode(canonical));
	return u8ToString(digest.subarray(0, 16), 'base64url');
}
