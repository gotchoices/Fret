import { BTree } from 'digitree';
import { coordToBase64url, base64urlToCoord } from '../ring/hash.js';

export type PeerState = 'connected' | 'disconnected' | 'dead';

/**
 * Whether a known peer belongs to *this* node's FRET network.
 *
 * The routing store is populated from network-agnostic libp2p signals (peerStore,
 * peer:connect, bootstraps, neighbor snapshots), so it can hold peers that share the
 * transport but participate in a *different* control network and never serve this
 * network's namespaced FRET protocols. This tri-state labels each peer accordingly.
 *
 * - `unknown`: freshly discovered, not yet classified (default on insert).
 * - `member`: confirmed to serve this network's FRET protocol.
 * - `foreign`: confirmed NOT to serve it (belongs to another network).
 *
 * The store only stores and exposes the label; it never branches on it. Callers
 * (e.g. ring gating) read it via their own predicate.
 */
export type MembershipState = 'unknown' | 'member' | 'foreign';

export interface PeerEntry {
	id: string;
	coord: Uint8Array;
	relevance: number;
	lastAccess: number;
	state: PeerState;
	membership: MembershipState;
	/**
	 * Consecutive "could not negotiate this protocol" handshake failures against this peer.
	 *
	 * A single failure is weak evidence — the remote may simply not have registered its
	 * handlers yet, or be mid-restart — so callers demote to `foreign` only after a run of
	 * them, and reset the counter on any positive proof of membership. Like `membership`,
	 * the store only stores and exposes the count; it never branches on it.
	 */
	negotiateFailures: number;
	/**
	 * Unix ms of the last handshake failure that was *counted* toward `negotiateFailures`.
	 *
	 * A run of failures only means "persistently absent" if the observations are separated in
	 * time; concurrent RPCs to one restarting peer all fail in the same instant and are one
	 * observation, not a run. Callers use this to space counted failures apart. Not serialized —
	 * unlike the count it carries no diagnostic value across a restart. 0 = never counted.
	 */
	lastNegotiateFailureAt: number;
	accessCount: number;
	successCount: number;
	failureCount: number;
	avgLatencyMs: number;
	metadata?: Record<string, any>;
}

/**
 * A patch applied to an existing entry by {@link DigitreeStore.update}.
 *
 * `id` is excluded deliberately: it is the identity the store's id index is keyed on, so
 * re-writing it through a patch could only ever leave the two structures disagreeing. The
 * coordinate *is* patchable — that is a re-key, which the store handles (see `put`).
 */
export type PeerPatch = Partial<Omit<PeerEntry, 'id'>>;

export interface SerializedPeerEntry {
	id: string;
	coord: string; // base64url
	relevance: number;
	lastAccess: number;
	state: PeerState;
	membership?: MembershipState; // optional for back-compat with older snapshots
	negotiateFailures?: number; // optional; exported for diagnostics, reset on import
	accessCount: number;
	successCount: number;
	failureCount: number;
	avgLatencyMs: number;
	metadata?: Record<string, any>;
}

export interface SerializedTable {
	v: 1;
	peerId: string;
	timestamp: number;
	entries: SerializedPeerEntry[];
}

function coordToHex(coord: Uint8Array): string {
	let s = '';
	for (let i = 0; i < coord.length; i++) s += coord[i]!.toString(16).padStart(2, '0');
	return s;
}

function makeKey(entry: PeerEntry): string {
	return `${coordToHex(entry.coord)}|${entry.id}`;
}

/**
 * The routing table: an ordered B+Tree of peer entries plus an index from peer id to that
 * entry's tree key.
 *
 * The tree key embeds the ring coordinate (`hex(coord)|id`), so **changing a peer's
 * coordinate changes its tree key** — an update is a re-key, not an in-place edit. Every
 * read above this class rests on one invariant:
 *
 * > Exactly one tree entry exists per peer id, and `byId` maps that id to that entry's
 * > current key.
 *
 * Nothing outside this class may write to either structure. All mutation funnels through
 * the private {@link DigitreeStore.put} seam (and its delete half, {@link
 * DigitreeStore.remove}), which is what makes the invariant hold by construction rather
 * than by each write path re-deriving the bookkeeping — and getting it wrong differently.
 * `test/digitree.invariants.spec.ts` fails for any write path that bypasses the seam.
 */
export class DigitreeStore {
	private readonly byKey: BTree<string, PeerEntry>;
	private readonly byId: Map<string, string>; // id -> key

	constructor() {
		this.byKey = new BTree<string, PeerEntry>((e: PeerEntry) => makeKey(e));
		this.byId = new Map();
	}

	/**
	 * The single write seam over both structures: places `entry` as the one and only tree
	 * entry for its id, and points `byId` at it.
	 *
	 * If the id already has an entry under a *different* key, its coordinate changed and the
	 * old entry must be dropped first — otherwise the tree keeps both under different keys
	 * and the id is duplicated in every ring walk while `byId` can only see one of them.
	 */
	private put(entry: PeerEntry): PeerEntry {
		const key = makeKey(entry);
		const prevKey = this.byId.get(entry.id);
		if (prevKey !== undefined && prevKey !== key) {
			const prev = this.byKey.find(prevKey);
			if (prev.on) this.byKey.deleteAt(prev);
		}
		// insert-or-replace at `key`: unlike `insert` it has no conflict outcome to discard,
		// and unlike `updateAt` it needs no caller-held path — it takes its own `find` after
		// the delete above, so nothing here can act on a path the tree already invalidated.
		this.byKey.upsert(entry);
		this.byId.set(entry.id, key);
		return entry;
	}

	upsert(id: string, coord: Uint8Array): PeerEntry {
		const now = Date.now();
		// upsert's contract is "ensure an entry exists", not "reset to defaults".
		// On a hit, preserve all mutable stats (relevance, health counters, state,
		// membership, metadata) and only refresh coord/lastAccess. New ids get defaults.
		const prev = this.getById(id);
		if (prev) return this.put({ ...prev, coord, lastAccess: now });
		return this.put({
			id,
			coord,
			relevance: 0,
			lastAccess: now,
			state: 'disconnected',
			membership: 'unknown',
			negotiateFailures: 0,
			lastNegotiateFailureAt: 0,
			accessCount: 0,
			successCount: 0,
			failureCount: 0,
			avgLatencyMs: 0
		});
	}

	update(id: string, patch: PeerPatch): void {
		const cur = this.getById(id);
		if (!cur) return;
		// A coord in the patch re-keys the entry; `put` owns that, so there is nothing to
		// special-case here.
		this.put({ ...cur, ...patch });
	}

	getById(id: string): PeerEntry | undefined {
		const key = this.byId.get(id);
		if (!key) return undefined;
		const p = this.byKey.find(key);
		return p.on ? this.byKey.at(p) : undefined;
	}

	remove(id: string): void {
		const key = this.byId.get(id);
		if (!key) return;
		const p = this.byKey.find(key);
		if (p.on) this.byKey.deleteAt(p);
		this.byId.delete(id);
	}

	list(): PeerEntry[] {
		const out: PeerEntry[] = [];
		for (const p of this.byKey.ascending(this.byKey.first())) out.push(this.byKey.at(p)!);
		return out;
	}

	size(): number {
		return this.byId.size;
	}

	setState(id: string, state: PeerState): void {
		this.update(id, { state });
	}

	setMembership(id: string, membership: MembershipState): void {
		this.update(id, { membership });
	}

	protectedIdsAround(coord: Uint8Array, breadth: number, filter?: (e: PeerEntry) => boolean): Set<string> {
		const ids = new Set<string>();
		for (const id of this.neighborsRight(coord, breadth, filter)) ids.add(id);
		for (const id of this.neighborsLeft(coord, breadth, filter)) ids.add(id);
		return ids;
	}

	private ceilPath(hexCoord: string) {
		// find first >= hexCoord by seeking hexCoord + "|\x00"
		const seek = `${hexCoord}|\x00`;
		let p = this.byKey.find(seek);
		if (!p.on) p = this.byKey.next(p);
		return p;
	}

	private floorPath(hexCoord: string) {
		// find last < hexCoord by seeking hexCoord + "|\uffff" then prior
		const seek = `${hexCoord}|\uffff`;
		let p = this.byKey.find(seek);
		if (!p.on) p = this.byKey.prior(p);
		return p;
	}

	// The ordered-walk methods below take an optional `filter` predicate. The store stays
	// network-agnostic — it never names `membership`; callers (e.g. ring gating in
	// FretService) supply the predicate. When a filter is given the walk *skips and keeps
	// advancing* on a miss rather than stopping, and a bounded-scan guard caps total
	// entries visited at `size()` (one full traversal) so a ring with zero matching
	// entries can't spin forever on the wrap-around. With no filter (the default) the
	// behavior is byte-for-byte unchanged: simulator and direct-store callers are unaffected.
	//
	// NOTE: a filtered walk is worst-case O(size()) when matching entries are sparse near
	// the coord (e.g. a large, mostly-foreign shared-infra ring) — it skip-scans past every
	// non-match. Fine while rings are member-dominated; if a large mostly-foreign ring shows
	// up as slow here, maintain a member-only secondary index and walk that instead of
	// skip-scanning the full ordered index.

	successorOfCoord(coord: Uint8Array, filter?: (e: PeerEntry) => boolean): PeerEntry | undefined {
		const hex = coordToHex(coord);
		let p = this.ceilPath(hex);
		p = p.on ? p : this.byKey.first();
		if (!filter) return p.on ? this.byKey.at(p) : undefined;
		const maxScan = this.size();
		let scanned = 0;
		while (scanned < maxScan) {
			if (!p.on) {
				p = this.byKey.first();
				if (!p.on) return undefined;
			}
			const e = this.byKey.at(p)!;
			scanned++;
			if (filter(e)) return e;
			p = this.byKey.next(p);
		}
		return undefined;
	}

	predecessorOfCoord(coord: Uint8Array, filter?: (e: PeerEntry) => boolean): PeerEntry | undefined {
		const hex = coordToHex(coord);
		let p = this.floorPath(hex);
		p = p.on ? p : this.byKey.last();
		if (!filter) return p.on ? this.byKey.at(p) : undefined;
		const maxScan = this.size();
		let scanned = 0;
		while (scanned < maxScan) {
			if (!p.on) {
				p = this.byKey.last();
				if (!p.on) return undefined;
			}
			const e = this.byKey.at(p)!;
			scanned++;
			if (filter(e)) return e;
			p = this.byKey.prior(p);
		}
		return undefined;
	}

	neighborsRight(coord: Uint8Array, count: number, filter?: (e: PeerEntry) => boolean): string[] {
		const out: string[] = [];
		const hex = coordToHex(coord);
		let p = this.ceilPath(hex);
		p = p.on ? p : this.byKey.first();
		const maxScan = filter ? this.size() : Number.POSITIVE_INFINITY;
		let i = 0;
		let scanned = 0;
		while (i < count && scanned < maxScan) {
			if (!p.on) {
				p = this.byKey.first();
				if (!p.on) break;
			}
			const e = this.byKey.at(p)!;
			scanned++;
			if (!filter || filter(e)) {
				out.push(e.id);
				i++;
			}
			p = this.byKey.next(p);
		}
		return Array.from(new Set(out));
	}

	neighborsLeft(coord: Uint8Array, count: number, filter?: (e: PeerEntry) => boolean): string[] {
		const out: string[] = [];
		const hex = coordToHex(coord);
		let p = this.floorPath(hex);
		p = p.on ? p : this.byKey.last();
		const maxScan = filter ? this.size() : Number.POSITIVE_INFINITY;
		let i = 0;
		let scanned = 0;
		while (i < count && scanned < maxScan) {
			if (!p.on) {
				p = this.byKey.last();
				if (!p.on) break;
			}
			const e = this.byKey.at(p)!;
			scanned++;
			if (!filter || filter(e)) {
				out.push(e.id);
				i++;
			}
			p = this.byKey.prior(p);
		}
		return Array.from(new Set(out));
	}

	exportEntries(): SerializedPeerEntry[] {
		return this.list().map((e) => ({
			id: e.id,
			coord: coordToBase64url(e.coord),
			relevance: e.relevance,
			lastAccess: e.lastAccess,
			state: e.state,
			membership: e.membership,
			negotiateFailures: e.negotiateFailures,
			accessCount: e.accessCount,
			successCount: e.successCount,
			failureCount: e.failureCount,
			avgLatencyMs: e.avgLatencyMs,
			...(e.metadata ? { metadata: e.metadata } : {}),
		}));
	}

	/**
	 * Restores serialized entries, replacing by id: a snapshot record for an id already in the
	 * store wins, including a coordinate move (the snapshot is the more recent view of that
	 * peer, and a stale duplicate would otherwise linger in the tree unreachable by id).
	 *
	 * @returns the number of *distinct ids stored* — not the number of input records, so a
	 * snapshot carrying an id twice reports 1.
	 */
	importEntries(entries: SerializedPeerEntry[]): number {
		const stored = new Set<string>();
		for (const s of entries) {
			const coord = base64urlToCoord(s.coord);
			const entry: PeerEntry = {
				id: s.id,
				coord,
				relevance: s.relevance,
				lastAccess: s.lastAccess,
				state: 'disconnected',
				// A persisted table is same-network by construction; default a missing
				// field to 'unknown' for back-compat with snapshots predating membership.
				membership: s.membership ?? 'unknown',
				// Handshake history cannot survive a restart — the remote may have restarted
				// too. Reset for the same reason `state` is forced to 'disconnected'.
				negotiateFailures: 0,
				lastNegotiateFailureAt: 0,
				accessCount: s.accessCount,
				successCount: s.successCount,
				failureCount: s.failureCount,
				avgLatencyMs: s.avgLatencyMs,
				...(s.metadata ? { metadata: s.metadata } : {}),
			};
			this.put(entry);
			stored.add(entry.id);
		}
		return stored.size;
	}
}
