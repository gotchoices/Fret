import { BTree } from 'digitree';
import { COORD_BYTES, coordToBase64url, coordToHex, base64urlToCoord } from '../ring/hash.js';

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
	/**
	 * Consecutive failures to *reach* this peer at all, since the last proof that it is alive.
	 *
	 * A strike is a failed contact — the outbound RPC threw (dial failure, no known address,
	 * stream/read timeout, transport error). A negotiation refusal is deliberately *not* one:
	 * the dial succeeded and the remote answered, so it is alive, and that error is membership
	 * evidence instead (see `negotiateFailures`). A run of these is what marks a peer `dead`;
	 * any proof of life — a completed RPC in either direction, or a fresh connection — resets it
	 * to 0. Like `membership`, the store only stores and exposes the count; it never branches on it.
	 */
	contactFailures: number;
	/**
	 * Unix ms of the last contact failure that was *counted* toward `contactFailures`.
	 *
	 * Same reasoning as `lastNegotiateFailureAt`: several callers failing against one peer in the
	 * same instant are one observation, not a run, so callers space counted failures apart. Not
	 * serialized — it describes a live attempt and says nothing after a restart. 0 = never counted.
	 */
	lastContactFailureAt: number;
	accessCount: number;
	successCount: number;
	failureCount: number;
	/**
	 * EMA of measured round-trip latency in ms, or `null` when this peer has never been
	 * measured.
	 *
	 * `null` rather than `0` because a genuine 0 ms sample is ordinary, not exotic: pings are
	 * timed with `Date.now()`, whose granularity is ~15 ms on Windows, so a localhost or
	 * same-process peer routinely rounds to 0. Overloading `0` to mean "unmeasured" made a
	 * fast peer score *worse* than a mediocre one, and made "I have no measurement" writable
	 * as a number — so callers with nothing to report wrote a fabricated 0 that decayed real
	 * measurements away. Neither mistake is expressible now.
	 */
	avgLatencyMs: number | null;
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

/**
 * An opaque resume position in ring-coordinate order, minted by {@link DigitreeStore.walkFrom}
 * and only ever consumed by it.
 *
 * `key` is the store's internal tree key, whose format (`hex(coord)|id`) is deliberately private
 * to this class — see the class doc. A caller that built a cursor itself would be a second copy
 * of the key rule living outside its owner, and would silently scramble every resumed walk the
 * moment that format changed.
 */
export interface RingCursor {
	readonly key: string;
}

/** One page of a resumable ring walk — see {@link DigitreeStore.walkFrom}. */
export interface RingWalkPage {
	entries: PeerEntry[];
	/**
	 * Where to resume: strictly after the last entry of {@link entries}, or the cursor that was
	 * passed in when the page came back empty — nothing matched, so the position did not move.
	 */
	next: RingCursor | null;
}

export interface SerializedPeerEntry {
	id: string;
	coord: string; // base64url
	relevance: number;
	lastAccess: number;
	state: PeerState;
	membership?: MembershipState; // optional for back-compat with older snapshots
	negotiateFailures?: number; // optional; exported for diagnostics, reset on import
	contactFailures?: number; // optional; exported for diagnostics, reset on import
	accessCount: number;
	successCount: number;
	failureCount: number;
	avgLatencyMs: number | null; // null = never measured; absent in pre-nullable snapshots → null
	metadata?: Record<string, any>;
}

export interface SerializedTable {
	v: 1;
	peerId: string;
	timestamp: number;
	entries: SerializedPeerEntry[];
}

/**
 * The tree key embeds the coordinate as hex, so a coordinate of the wrong width produces a
 * key of the wrong length and sorts into an arbitrary ring position — silently scrambling
 * every ordered read that rests on it. Rejecting at the single write seam makes the bad
 * state unrepresentable in the store regardless of which decode path produced the bytes.
 */
function assertCoordWidth(coord: Uint8Array): void {
	if (coord.length !== COORD_BYTES) {
		throw new Error(`DigitreeStore: ring coordinate must be ${COORD_BYTES} bytes, got ${coord.length}`);
	}
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
		assertCoordWidth(entry.coord);
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
			contactFailures: 0,
			lastContactFailureAt: 0,
			accessCount: 0,
			successCount: 0,
			failureCount: 0,
			avgLatencyMs: null
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

	/**
	 * One page of a resumable walk in ring-coordinate order.
	 *
	 * Starts **strictly after** `cursor` (at the ring start when `null`), wraps past the end of
	 * the ring, skips filter misses, and visits at most `size()` entries — one full lap — so a
	 * ring where nothing matches terminates rather than spinning on the wrap-around, exactly as
	 * the filtered walks above do.
	 *
	 * Strictly-after is what makes a *paged sweep* cover the whole ring. Resuming at the cursor
	 * instead re-yields that entry, which costs a slot on every page and, at `count: 1`, never
	 * advances at all. The wrap is what keeps strictly-after correct on a one-entry ring, where
	 * "strictly after X, wrapping" is X itself — so a single-peer ring still re-yields its peer.
	 *
	 * Returns entries rather than ids (unlike {@link neighborsRight}) so the caller gets its next
	 * cursor without a second {@link getById} per page.
	 */
	walkFrom(cursor: RingCursor | null, count: number, filter?: (e: PeerEntry) => boolean): RingWalkPage {
		const entries: PeerEntry[] = [];
		const maxScan = this.size();
		if (count <= 0 || maxScan === 0) return { entries, next: cursor };
		// `next` of the cursor's path is the first entry strictly after it whether the path landed
		// *on* that key or in the crack where it used to be — so a cursor whose entry has since been
		// evicted resumes at the right ring position instead of restarting the sweep.
		let p = cursor ? this.byKey.next(this.byKey.find(cursor.key)) : this.byKey.first();
		let next = cursor;
		let scanned = 0;
		while (entries.length < count && scanned < maxScan) {
			if (!p.on) {
				p = this.byKey.first();
				if (!p.on) break;
			}
			const e = this.byKey.at(p)!;
			scanned++;
			if (!filter || filter(e)) {
				entries.push(e);
				next = { key: makeKey(e) };
			}
			p = this.byKey.next(p);
		}
		return { entries, next };
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
			contactFailures: e.contactFailures,
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
	 * A record whose coordinate is malformed rejects the whole snapshot, and does so *before*
	 * any entry is written: a corrupted persisted table is better refused loudly than admitted
	 * as ring state, but a mid-loop throw would leave a half-imported table behind (and skip
	 * the caller's capacity enforcement, which runs after the call returns).
	 *
	 * @returns the number of *distinct ids stored* — not the number of input records, so a
	 * snapshot carrying an id twice reports 1.
	 */
	importEntries(entries: SerializedPeerEntry[]): number {
		const decoded = entries.map((s) => ({ s, coord: base64urlToCoord(s.coord) }));
		const stored = new Set<string>();
		for (const { s, coord } of decoded) {
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
				// Likewise unreachability: a peer we could not contact before the restart may be
				// reachable now. `state` is already forced to 'disconnected', so resetting the
				// counter alongside it is what stops an imported table from re-killing that peer
				// on its very next failure.
				contactFailures: 0,
				lastContactFailureAt: 0,
				accessCount: s.accessCount,
				successCount: s.successCount,
				failureCount: s.failureCount,
				// A snapshot predating the nullable field has no latency to restore.
				// Pre-nullable snapshots wrote 0 for "never measured", which is ambiguous and
				// reads back as a genuine 0 ms — accepted, since the next ping overwrites it and
				// a coercion would instead discard real 0 ms measurements.
				avgLatencyMs: s.avgLatencyMs ?? null,
				...(s.metadata ? { metadata: s.metadata } : {}),
			};
			this.put(entry);
			stored.add(entry.id);
		}
		return stored.size;
	}
}
