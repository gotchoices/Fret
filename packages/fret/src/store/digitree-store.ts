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
	accessCount: number;
	successCount: number;
	failureCount: number;
	avgLatencyMs: number;
	metadata?: Record<string, any>;
}

export interface SerializedPeerEntry {
	id: string;
	coord: string; // base64url
	relevance: number;
	lastAccess: number;
	state: PeerState;
	membership?: MembershipState; // optional for back-compat with older snapshots
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

export class DigitreeStore {
	private readonly byKey: BTree<string, PeerEntry>;
	private readonly byId: Map<string, string>; // id -> key

	constructor() {
		this.byKey = new BTree<string, PeerEntry>((e: PeerEntry) => makeKey(e));
		this.byId = new Map();
	}

	insert(entry: PeerEntry): void {
		const key = makeKey(entry);
		this.byKey.insert(entry);
		this.byId.set(entry.id, key);
	}

	upsert(id: string, coord: Uint8Array): PeerEntry {
		const now = Date.now();
		const prevKey = this.byId.get(id);
		// Membership is durable across re-inserts: upsert runs network-agnostically
		// on every peerStore/connect/snapshot signal, so resetting it would wipe a
		// hard-won classification every stabilization tick. Carry the prior label
		// forward; new entries default to 'unknown'.
		let membership: MembershipState = 'unknown';
		if (prevKey) {
			const path = this.byKey.find(prevKey);
			if (path.on) {
				const prev = this.byKey.at(path);
				if (prev) membership = prev.membership;
				this.byKey.deleteAt(path);
			}
			this.byId.delete(id);
		}
		const entry: PeerEntry = {
			id,
			coord,
			relevance: 0,
			lastAccess: now,
			state: 'disconnected',
			membership,
			accessCount: 0,
			successCount: 0,
			failureCount: 0,
			avgLatencyMs: 0
		};
		this.insert(entry);
		return entry;
	}

	update(id: string, patch: Partial<PeerEntry>): void {
		const key = this.byId.get(id);
		if (!key) return;
		const path = this.byKey.find(key);
		const cur = this.byKey.at(path);
		if (!cur) return;
		const next: PeerEntry = { ...cur, ...patch };
		this.byKey.updateAt(path, next);
		if (makeKey(cur) !== makeKey(next)) {
			this.byKey.deleteAt(path);
			this.insert(next);
		}
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
			accessCount: e.accessCount,
			successCount: e.successCount,
			failureCount: e.failureCount,
			avgLatencyMs: e.avgLatencyMs,
			...(e.metadata ? { metadata: e.metadata } : {}),
		}));
	}

	importEntries(entries: SerializedPeerEntry[]): number {
		let count = 0;
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
				accessCount: s.accessCount,
				successCount: s.successCount,
				failureCount: s.failureCount,
				avgLatencyMs: s.avgLatencyMs,
				...(s.metadata ? { metadata: s.metadata } : {}),
			};
			this.insert(entry);
			count++;
		}
		return count;
	}
}
