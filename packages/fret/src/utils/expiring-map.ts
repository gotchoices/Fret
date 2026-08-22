/**
 * Source of "now" in unix ms.
 *
 * Injectable so expiry can be driven from a caller-controlled clock. The wall clock is the
 * only default a production caller wants, but a *test* that steps it explicitly is testing
 * the expiry rule rather than the host's scheduler accuracy — a sleep-based test asserts on
 * `setTimeout` overshoot, which is unbounded under load and is not a property of this class.
 */
export type Clock = () => number;

export interface ExpiringMapOptions {
	/**
	 * Hard maximum retained entries. Clamped to ≥ 1: a capacity of 0 would make the map evict
	 * whatever it just inserted, and throwing from a constructor gives the caller nothing it can
	 * usefully do. A non-finite capacity (including `Infinity`) clamps to 1 too — "unbounded" is
	 * exactly the state this type exists to make unwritable.
	 */
	capacity: number;
	/** Entry lifetime in ms, measured from the last write of that key. Clamped to ≥ 0. */
	ttlMs: number;
	/** Injectable for deterministic tests; defaults to `Date.now`. */
	now?: Clock;
}

interface Entry<V> {
	value: V;
	expiresAt: number;
}

/**
 * A `Map` with one constant entry lifetime and a stated hard capacity.
 *
 * Exists so "a bookkeeping map whose memory ceiling is an emergent property of some other
 * subsystem's settings" is not writable at the call sites that use it: both bounds are
 * constructor arguments, and neither depends on how often a caller remembers to prune.
 *
 * Two rules make it correct and cheap:
 *
 * - **A write to an existing key deletes before re-inserting.** JavaScript `Map` keeps a
 *   re-`set` key at its *original* iteration position, so without the delete a just-refreshed
 *   entry still looks like the oldest one and would be chosen as the next eviction victim.
 * - **A single constant TTL means insertion order *is* expiry order,** so the entry nearest to
 *   expiry is the first key in `Map` iteration order and eviction is O(1) with no scan.
 *
 * NOTE: that O(1) eviction depends on every entry sharing one TTL. A future caller wanting
 * per-entry lifetimes breaks the insertion-order ⇒ expiry-order equivalence and needs a real
 * nearest-expiry search, not a first-key delete — do not add a per-entry `ttlMs` parameter here
 * without replacing {@link evictNearestExpiry}.
 */
export class ExpiringMap<V> {
	private readonly entries = new Map<string, Entry<V>>();
	private readonly clock: Clock;
	readonly capacity: number;
	readonly ttlMs: number;

	constructor(opts: ExpiringMapOptions) {
		this.capacity = normalizeCapacity(opts.capacity);
		this.ttlMs = normalizeTtl(opts.ttlMs);
		this.clock = opts.now ?? Date.now;
	}

	/**
	 * Retained entries, which is what the capacity bounds — an expired entry still occupies memory
	 * until a {@link sweep}, a lookup, or an eviction removes it, so it is counted here.
	 */
	get size(): number {
		return this.entries.size;
	}

	/** `undefined` once expired; deletes the expired entry as a side effect. */
	get(key: string): V | undefined {
		return this.live(key)?.value;
	}

	has(key: string): boolean {
		return this.live(key) !== undefined;
	}

	/** Refresh-or-insert. A refresh never evicts; an insert at capacity evicts one entry. */
	set(key: string, value: V): void {
		// Refreshing an existing key never grows the map, so it must never trigger eviction.
		// Deleting first also moves the re-`set` key to the newest iteration slot, so a
		// just-refreshed entry is never mistaken for the oldest.
		if (this.entries.has(key)) this.entries.delete(key);
		else if (this.entries.size >= this.capacity) this.evictNearestExpiry();
		this.entries.set(key, { value, expiresAt: this.clock() + this.ttlMs });
	}

	delete(key: string): boolean {
		return this.entries.delete(key);
	}

	/**
	 * Snapshot of the live (non-expired) keys.
	 *
	 * An array rather than an iterator so a caller can delete from the map while walking the
	 * result — which `ProbeBackoff.prune` does — without relying on `Map`'s
	 * delete-during-iteration semantics being what it wanted.
	 */
	keys(): string[] {
		const now = this.clock();
		const out: string[] = [];
		for (const [key, entry] of this.entries) {
			if (entry.expiresAt >= now) out.push(key);
		}
		return out;
	}

	clear(): void {
		this.entries.clear();
	}

	/** Drop every expired entry. Returns how many were dropped. */
	sweep(): number {
		const now = this.clock();
		let dropped = 0;
		// A full scan rather than an early break at the first live entry: the scan is what stays
		// correct if the clock steps backwards (see the NOTE on `evictNearestExpiry`), and every
		// caller runs it on an existing periodic tick over a map bounded at a few thousand entries.
		// The *eviction* path is the one that must stay O(1), and it does not come through here.
		for (const [key, entry] of this.entries) {
			if (entry.expiresAt < now) {
				this.entries.delete(key);
				dropped++;
			}
		}
		return dropped;
	}

	/** The entry, or `undefined` if absent or expired — dropping an expired one on the way out. */
	private live(key: string): Entry<V> | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		// `<`, not `<=`: an entry is still live *at* its expiry instant.
		if (entry.expiresAt < this.clock()) {
			this.entries.delete(key);
			return undefined;
		}
		return entry;
	}

	private evictNearestExpiry(): void {
		// Insertion order and expiry order agree (constant `ttlMs`, and `set` re-inserts a refreshed
		// key at the newest slot with a fresh expiry), so the first entry is the one nearest to
		// expiry — and if anything at all is expired, it is expired. Evicting it therefore needs no
		// scan, and never sacrifices a live entry while a dead one remains.
		// NOTE: that agreement assumes the clock is non-decreasing. A backwards step can leave a
		// live entry ahead of an expired one, so one eviction picks the wrong victim; it
		// self-corrects on the next insert. If wall-clock steps ever matter here, construct with a
		// monotonic `Clock` rather than reintroducing a scan.
		const first = this.entries.keys().next();
		if (!first.done) this.entries.delete(first.value);
	}
}

function normalizeCapacity(capacity: number): number {
	if (!Number.isFinite(capacity)) return 1;
	return Math.max(1, Math.floor(capacity));
}

function normalizeTtl(ttlMs: number): number {
	if (!Number.isFinite(ttlMs)) return 0;
	return Math.max(0, ttlMs);
}
