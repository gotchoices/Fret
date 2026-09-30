import { BTree, type Path } from 'digitree';
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
	metadata?: Record<string, unknown>;
	/**
	 * This peer's most recent **verified** signed address record — the marshaled libp2p
	 * `RecordEnvelope` bytes, exactly as accepted — and `confirmedAt`, the *local* clock time it
	 * was accepted (from a received hint, or mirrored from libp2p's own identify-stored record).
	 *
	 * Opaque to the store: it never parses the bytes, so it stays network- and libp2p-agnostic
	 * (the same rule as `membership`). The service forwards the record to other peers while the
	 * peer is connected or `confirmedAt` is recent, and orders records by the envelope's own
	 * sequence number — never by `confirmedAt`, which is our clock, not the signer's. Preserved
	 * across `upsert` like every other mutable field; written only through `update`. Not
	 * serialized yet — the persisted-table ticket adds that.
	 */
	addressRecord?: { envelope: Uint8Array; confirmedAt: number };
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
	metadata?: Record<string, unknown>;
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

/** A cursor into the ordered tree. Aliased so the walk signatures below stay readable. */
type EntryPath = Path<string, PeerEntry>;

/**
 * Tree keys, cached against the *coordinate array* an entry carries.
 *
 * `digitree` derives an entry's key on demand rather than storing it, and calls the extractor
 * once per binary-search probe inside a leaf node — measured 5 calls per `find`, 6 per seek.
 * Uncached, every one of those calls runs `coordToHex` (a 32-iteration loop building a
 * 64-character string) plus a concatenation, which measured ~83% of a `find` (20 000 `find`
 * calls over a 2048-entry store: 39.0 ms rebuilding vs 4.4 ms cached). `find` is not a rare
 * call — `remove`, `put`, and the seek that starts every ring walk each perform one.
 *
 * The cache key is the **coordinate array's object identity**, guarded by the entry's id, and
 * that choice is the whole point rather than an implementation detail. Keying on the *entry*
 * object instead covers only the read side: every write path hands `put` a freshly spread
 * entry (`{ ...prev, coord, lastAccess }` in `upsert`, `{ ...cur, ...patch }` in `update`), so
 * a write was a guaranteed miss — it rebuilt the hex, allocated the key, and inserted a fresh
 * weak-table record that was garbage before the next write. That cost is not the rebuild; it
 * is the weak table. Measured on the 300-peer bounded-store simulation in
 * `test/message-bus.spec.ts` (3.4M writes, 66M extractor calls): 25–35 s per run keyed on the
 * entry, 9 s with the cache removed outright, and 3.3–4.3 s keyed on the coordinate — an
 * entry-keyed cache was several times *worse* than no cache at all, because the misses it
 * could not avoid each left a record behind for the collector to walk.
 *
 * A coordinate array, by contrast, is stable across writes wherever one exists: `upsert` reuses
 * the caller's array (a peer's ring coordinate, hashed once), and `update` spreads the current
 * entry, so an entry whose coordinate did not change carries the same array through. So the
 * ordinary write is a hit, and the table holds one record per live coordinate rather than one
 * per write.
 *
 * The id guard is what keeps that sound: two entries may legitimately share a coordinate array
 * (the same bytes handed to two ids), and the key embeds the id. A mismatch simply rebuilds,
 * which is the uncached cost and never a wrong key. A genuine re-key hands in a different
 * array and misses the same way.
 *
 * Deliberately not a field on `PeerEntry`: a key field would be carried across a coordinate
 * change by the spread and be silently stale — the re-key case this store's write seam exists
 * to handle — it would widen an exported public interface, and a non-enumerable symbol
 * property that dodged the spread would cost a `defineProperty` per write plus a shape
 * transition on the hottest object in the package. Arrays leave the cache with the garbage
 * collector, so there is no eviction path to maintain and no ceiling to state.
 *
 * NOTE: the cache rests on one invariant, and that invariant is already load-bearing at HEAD:
 * an entry's `id`, and the bytes of the `coord` it holds, are never mutated in place while it
 * sits in the tree. Because `digitree` re-derives keys from entries on demand, in-place
 * mutation already scrambles tree order *without* the cache — so the cache is exactly as safe
 * as the status quo, no safer and no less. Verified by grep across `src/` and `test/` at the
 * time of writing: every write path replaces the entry object and every coordinate is built
 * fresh by a decoder or a hash. `test/digitree.neighbors.spec.ts` pins the re-key path and
 * `test/digitree.invariants.spec.ts` asserts tree order against the coordinates the entries
 * actually carry, so a stale key fails there.
 */
const keyCache = new WeakMap<Uint8Array, { id: string; key: string }>();

function makeKey(entry: PeerEntry): string {
	const cached = keyCache.get(entry.coord);
	if (cached !== undefined && cached.id === entry.id) return cached.key;
	const key = `${coordToHex(entry.coord)}|${entry.id}`;
	keyCache.set(entry.coord, { id: entry.id, key });
	return key;
}

/**
 * The routing table: an ordered B+Tree of peer entries plus an index from peer id to that
 * entry.
 *
 * The tree key embeds the ring coordinate (`hex(coord)|id`), so **changing a peer's
 * coordinate changes its tree key** — an update is a re-key, not an in-place edit. Every
 * read above this class rests on one invariant:
 *
 * > Exactly one tree entry exists per peer id, and `byId` maps that id to that very entry
 * > object.
 *
 * Nothing outside this class may write to either structure. All mutation funnels through
 * the private {@link DigitreeStore.put} seam (and its delete half, {@link
 * DigitreeStore.remove}), which is what makes the invariant hold by construction rather
 * than by each write path re-deriving the bookkeeping — and getting it wrong differently.
 * `test/digitree.invariants.spec.ts` fails for any write path that bypasses the seam.
 */
export class DigitreeStore {
	private readonly byKey: BTree<string, PeerEntry>;
	/**
	 * id -> the *entry object* the tree holds for that id, rather than its tree key.
	 *
	 * Holding the entry is what makes `getById` free. A key has to be turned back into an
	 * entry by a tree `find`, and `find` is this store's dominant cost: `digitree` derives a
	 * key from an entry on demand and calls the extractor once per binary-search probe, so
	 * every id-keyed read — and every write, which resolves the previous entry before
	 * replacing it — paid a full descent to learn something this map already held. Nothing is
	 * lost by dropping the key: it is recoverable from the entry through {@link makeKey},
	 * whose cache is warm for any entry the tree already holds.
	 */
	private readonly byId: Map<string, PeerEntry>;
	// O(1) per-label tallies over the entries currently in the store, maintained only at the
	// write seam (`put`) and the delete seam (`remove`) below. A tally over a field the store
	// already owns is bookkeeping, not policy — the store still never branches on `membership`
	// or `state`, it just counts them. NOTE: correctness assumes every write goes through those
	// two seams; an entry mutated any other way (none exists today — verified by grep) would
	// desync the counts silently.
	private readonly membershipCounts = new Map<MembershipState, number>();
	private readonly stateCounts = new Map<PeerState, number>();

	constructor() {
		this.byKey = new BTree<string, PeerEntry>((e: PeerEntry) => makeKey(e));
		this.byId = new Map();
	}

	// NOTE: a would-be negative count is folded into delete rather than raised. Unreachable while
	// every write goes through `put`/`remove` (pinned by the property test in
	// test/digitree.invariants.spec.ts, which recounts after every op); if a future write path
	// ever lands outside those seams, make this throw so the desync is loud rather than a
	// silently-clamped zero.
	private bumpCount<K>(counts: Map<K, number>, key: K, delta: number): void {
		const next = (counts.get(key) ?? 0) + delta;
		if (next <= 0) counts.delete(key);
		else counts.set(key, next);
	}

	private tally(entry: PeerEntry, delta: number): void {
		this.bumpCount(this.membershipCounts, entry.membership, delta);
		this.bumpCount(this.stateCounts, entry.state, delta);
	}

	/** How many entries currently carry membership label `m`. O(1). */
	countByMembership(m: MembershipState): number {
		return this.membershipCounts.get(m) ?? 0;
	}

	/** How many entries currently carry state `s`. O(1). */
	countByState(s: PeerState): number {
		return this.stateCounts.get(s) ?? 0;
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
		const prevEntry = this.byId.get(entry.id);
		if (prevEntry !== undefined) {
			// `makeKey` over an entry the tree already holds is a cache hit, so recovering the
			// previous key costs nothing and the tree is touched only on a genuine re-key.
			const prevKey = makeKey(prevEntry);
			if (prevKey !== key) {
				const prev = this.byKey.find(prevKey);
				if (prev.on) this.byKey.deleteAt(prev);
			}
		}
		// insert-or-replace at `key`: unlike `insert` it has no conflict outcome to discard,
		// and unlike `updateAt` it needs no caller-held path — it takes its own `find` after
		// the delete above, so nothing here can act on a path the tree already invalidated.
		this.byKey.upsert(entry);
		this.byId.set(entry.id, entry);
		if (prevEntry) this.tally(prevEntry, -1);
		this.tally(entry, 1);
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
		return this.byId.get(id);
	}

	remove(id: string): void {
		const prev = this.byId.get(id);
		if (!prev) return;
		const p = this.byKey.find(makeKey(prev));
		if (p.on) {
			this.tally(this.byKey.at(p)!, -1);
			this.byKey.deleteAt(p);
		}
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

	/**
	 * The one directional ring walk: yields matching entries in ring order from `start`,
	 * wrapping past the end of the ring, and visiting at most `maxScan` entries.
	 *
	 * Every ordered read in this class is a thin consumer of this generator — the five public
	 * walks differ only in where they start, which way they step, what they collect, and when
	 * they stop, so those are the four things left to the caller.
	 *
	 * `start` is taken raw: an off-end path (a coord past the last entry, an empty tree, a
	 * cursor sitting on the final entry) is wrapped here rather than by each caller, and a wrap
	 * that lands off as well means the tree is empty and the walk ends.
	 *
	 * `maxScan` counts every entry *visited*, match or miss, so it bounds a filtered walk that
	 * matches nothing — the guard that makes a zero-match walk terminate instead of circling the
	 * wrap-around forever. Callers that must terminate on ring size pass `size()`; the two
	 * neighbor walks pass `Infinity` when unfiltered, where the ring-lapped exit in
	 * {@link collectRing} is what stops them and today's behavior is byte-for-byte preserved.
	 *
	 * NOTE: this holds a live tree `Path` across every `yield`, and digitree paths are invalid
	 * after any mutation. Being a generator makes that reachable in a way the previous inline
	 * loops were not — a consumer can now run arbitrary code, including a write, between
	 * entries. Every consumer today materializes eagerly and mutates nothing, so it is sound as
	 * written; keep it private and keep it that way. If a walk ever needs to interleave with
	 * writes, snapshot the ids first and re-seek per entry rather than resuming a stale path.
	 */
	private *walkRing(
		start: EntryPath,
		direction: 'next' | 'prior',
		maxScan: number,
		filter?: (e: PeerEntry) => boolean
	): Generator<PeerEntry, void, undefined> {
		const step = direction === 'next'
			? (p: EntryPath) => this.byKey.next(p)
			: (p: EntryPath) => this.byKey.prior(p);
		const wrapTo = direction === 'next'
			? () => this.byKey.first()
			: () => this.byKey.last();
		let p = start;
		let scanned = 0;
		while (scanned < maxScan) {
			if (!p.on) {
				p = wrapTo();
				if (!p.on) return;
			}
			const e = this.byKey.at(p)!;
			scanned++;
			if (!filter || filter(e)) yield e;
			p = step(p);
		}
	}

	/**
	 * Collects up to `count` distinct ids from a directional walk, stopping early on the first
	 * id already collected — a repeat proves the walk has lapped the ring, because the store
	 * guarantees exactly one tree entry per peer id (see the class doc, and the property test
	 * in test/digitree.invariants.spec.ts). Without it an unfiltered walk keeps circling a ring
	 * smaller than `count`, re-collecting the same ids until it has `count` of them — cost
	 * O(count) rather than O(ring size). Measured on a 4-entry ring, 2000 walks: `count` 4 →
	 * 3.5 ms, 20 → 3.9 ms, 200 → 19.9 ms, 2000 → 98.9 ms, all returning the same 4 ids.
	 * Production `count` reaches ~30 (`assembleCohort` asks for `wants * 2 + excludeSet.size`),
	 * so it was a bounded ~7× lap factor on a young ring — waste, not catastrophe, and bounded
	 * only by an accident of today's callers.
	 *
	 * Sets are insertion-ordered, so `Array.from(set)` yields byte-for-byte the ordering an
	 * `Array.from(new Set(out))` over the raw walk would: this changes cost, not results.
	 *
	 * NOTE: two soundness conditions, neither obvious.
	 * (1) One-entry-per-id is what makes a repeat mean "lapped". Before that invariant landed
	 *     (`store-index-tree-invariant`) a duplicated id could appear mid-walk with no wrap, and
	 *     this exit would silently truncate the walk. If that invariant is ever weakened, this
	 *     exit must go with it.
	 * (2) A supplied `filter` must be **pure** (same entry, same answer), because the exit fires
	 *     only on a *matching* entry and so relies on the first match re-matching after a lap.
	 *     Every caller today passes `isLiveMember` or a plain field comparison. Note this
	 *     condition is dormant as the code stands: with a filter `maxScan` is `size()` and
	 *     {@link walkRing} counts every entry visited, match or miss, so a walk is cut off at
	 *     exactly one lap and can never reach a repeat. The exit is therefore reachable **only**
	 *     on the unfiltered path today, and `maxScan` is what makes that so — the purity
	 *     condition goes live the moment `maxScan` is weakened or removed, which is why it is
	 *     recorded here.
	 * The `maxScan` guard stays: it is the guard for the *filtered zero-match* case, where
	 * nothing is ever collected and the early exit therefore never fires. Neither subsumes the
	 * other — deleting either one reopens a spin.
	 */
	private collectRing(
		start: EntryPath,
		direction: 'next' | 'prior',
		count: number,
		filter?: (e: PeerEntry) => boolean
	): string[] {
		const out = new Set<string>();
		if (count <= 0) return [];
		const maxScan = filter ? this.size() : Number.POSITIVE_INFINITY;
		for (const e of this.walkRing(start, direction, maxScan, filter)) {
			if (out.has(e.id)) break; // lapped the ring — every reachable id is already collected
			out.add(e.id);
			if (out.size >= count) break;
		}
		return Array.from(out);
	}

	successorOfCoord(coord: Uint8Array, filter?: (e: PeerEntry) => boolean): PeerEntry | undefined {
		const start = this.ceilPath(coordToHex(coord));
		for (const e of this.walkRing(start, 'next', this.size(), filter)) return e;
		return undefined;
	}

	predecessorOfCoord(coord: Uint8Array, filter?: (e: PeerEntry) => boolean): PeerEntry | undefined {
		const start = this.floorPath(coordToHex(coord));
		for (const e of this.walkRing(start, 'prior', this.size(), filter)) return e;
		return undefined;
	}

	neighborsRight(coord: Uint8Array, count: number, filter?: (e: PeerEntry) => boolean): string[] {
		return this.collectRing(this.ceilPath(coordToHex(coord)), 'next', count, filter);
	}

	neighborsLeft(coord: Uint8Array, count: number, filter?: (e: PeerEntry) => boolean): string[] {
		return this.collectRing(this.floorPath(coordToHex(coord)), 'prior', count, filter);
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
		let next = cursor;
		const maxScan = this.size();
		if (count <= 0 || maxScan === 0) return { entries, next };
		// Strictly-after is a property of the *start path*, not of the walker: `next` of the
		// cursor's path is the first entry after it whether the path landed *on* that key or in
		// the crack where it used to be — so a cursor whose entry has since been evicted resumes
		// at the right ring position instead of restarting the sweep.
		const start = cursor ? this.byKey.next(this.byKey.find(cursor.key)) : this.byKey.first();
		for (const e of this.walkRing(start, 'next', maxScan, filter)) {
			entries.push(e);
			next = { key: makeKey(e) };
			if (entries.length >= count) break;
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
				// NOTE: a snapshot taken before frequency credit was narrowed to proven contact
				// carries an accessCount that also counted mentions, so a restored entry can be
				// over-credited. Self-correcting — the next scoring call rewrites relevance from
				// the live counters — so it is left as-is; revisit only if a persisted table ever
				// needs to survive a scoring-rule change without a re-score.
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
