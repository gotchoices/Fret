import type { PeerDiscovery, PeerDiscoveryEvents, PeerInfo, Startable } from '@libp2p/interface';
import { peerDiscoverySymbol } from '@libp2p/interface';
import { TypedEventEmitter } from 'main-event';
import { peerIdFromString } from '@libp2p/peer-id';
import type { DigitreeStore } from '../store/digitree-store.js';
import { ExpiringMap } from '../utils/expiring-map.js';
import { isLiveMember } from './live-member.js';
import { createLogger } from '../logger.js';

const log = createLogger('service:peer-discovery');

/**
 * What one scan tick needs.
 *
 * Resolved lazily, per tick: libp2p reads `peerDiscoverySymbol` off a service while
 * *constructing* the node, which is before `Libp2pFretService.setLibp2p` can supply the node
 * that the FRET store hangs off. So the discovery object must be constructible before its
 * store exists.
 */
export interface DiscoverySnapshotSource {
	store: DigitreeStore;
	/**
	 * This node's own peer id. Never emitted — libp2p logs an error when a discovery
	 * mechanism reports self, and self is always labelled `member`.
	 */
	selfId: string;
}

/**
 * A bare store means "no self id known, emit every matching entry"; a thunk returning `null`
 * means "not ready yet" (node constructed, service not started) and the tick is a no-op.
 */
export type FretPeerDiscoveryInput = DigitreeStore | (() => DiscoverySnapshotSource | null);

export interface FretPeerDiscoveryConfig {
	/** Interval (ms) between scan ticks that emit discovered peers. Default: 5000. */
	emissionIntervalMs?: number;
	/** Max peers to emit per tick. Default: 20. */
	batchSize?: number;
	/** Time (ms) before a previously emitted peer can be re-emitted. Default: 600_000 (10 min). */
	debounceMs?: number;
	/**
	 * Hard maximum peers held in the re-emission debounce map. Default: 4096.
	 *
	 * `Libp2pFretService` supplies a profile-tuned value (Core 4096 / Edge 1024); this default is
	 * for a `FretPeerDiscovery` constructed directly.
	 */
	maxTracked?: number;
}

/**
 * libp2p PeerDiscovery backed by FRET's Digitree — the single path by which FRET announces a
 * peer to libp2p. Reaches libp2p's own peerStore via `peerDiscoverySymbol` on
 * `Libp2pFretService`; dispatching `peer:discovery` straight at the node object (which two
 * now-deleted paths did) only reaches application listeners, never libp2p's internals.
 * An emission creates the peerStore entry (and, first time, makes libp2p re-dispatch
 * `peer:discovery` on the node) but never causes a dial — see the multiaddr NOTE in `scan`.
 *
 * Periodically scans the store for live (non-dead) member peers and emits `peer` events.
 * Recently emitted peers are debounced to avoid flooding the discovery pipeline.
 */
export class FretPeerDiscovery extends TypedEventEmitter<PeerDiscoveryEvents> implements PeerDiscovery, Startable {
	private readonly input: FretPeerDiscoveryInput;
	private readonly emissionIntervalMs: number;
	private readonly batchSize: number;
	private readonly debounceMs: number;
	/**
	 * Peers debounced against re-emission. **Presence alone means "recently emitted"** — the value
	 * is the emission timestamp, kept for diagnostics only. Both bounds are stated at
	 * construction: capacity `maxTracked`, lifetime `debounceMs`.
	 */
	private readonly emitted: ExpiringMap<number>;
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;

	get [peerDiscoverySymbol](): PeerDiscovery {
		return this;
	}

	get [Symbol.toStringTag](): string {
		return '@optimystic/fret-peer-discovery';
	}

	constructor(input: FretPeerDiscoveryInput, cfg?: FretPeerDiscoveryConfig) {
		super();
		this.input = input;
		this.emissionIntervalMs = cfg?.emissionIntervalMs ?? 5000;
		this.batchSize = cfg?.batchSize ?? 20;
		this.debounceMs = cfg?.debounceMs ?? 600_000;
		// The cap can bind before the debounce lapses — see the profile sizing note in
		// `Libp2pFretService`.
		// NOTE: that note claims a wrong eviction costs "one extra emission". Measured, that is
		// false whenever the live-member population exceeds this capacity: because `scan` restarts
		// at ring index 0 every tick, the evict/re-emit churn never advances past roughly
		// `capacity + batchSize` entries, so every member beyond that ring position is emitted
		// *never*, not twice. Tracked as `tickets/fix/bug-discovery-scan-starves-ring-tail`.
		this.emitted = new ExpiringMap<number>({
			capacity: cfg?.maxTracked ?? 4096,
			ttlMs: this.debounceMs,
		});
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.scan();
		this.timer = setInterval(() => this.scan(), this.emissionIntervalMs);
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.emitted.clear();
	}

	/** `null` when the source is not ready yet; `selfId` is `null` when the input is a bare store. */
	private resolveSource(): { store: DigitreeStore; selfId: string | null } | null {
		if (typeof this.input !== 'function') return { store: this.input, selfId: null };
		try {
			const src = this.input();
			return src ? { store: src.store, selfId: src.selfId } : null;
		} catch (err) {
			log.error('discovery source resolution failed - %e', err);
			return null;
		}
	}

	// NOTE: emits at most `batchSize` peers per tick (20 per 5s by default), so a large restored
	// routing table surfaces slowly — a full 2048-entry table takes ~8.5 min to drain.
	// NOTE: that "drains" only holds while the live-member population fits in `emitted`'s
	// capacity. Above it, restarting at ring index 0 every tick means the scan never advances
	// past roughly `capacity + batchSize` entries and the rest of the ring is emitted never —
	// a permanent, coordinate-determined bias, not a delay. Shipped Edge defaults
	// (`maxTracked` 1024 against a routing-table capacity of 2048) can reach it. The fix is a
	// resumable cursor; tracked as `tickets/fix/bug-discovery-scan-starves-ring-tail`.
	private scan(): void {
		const source = this.resolveSource();
		if (!source) return;
		const { store, selfId } = source;
		const now = Date.now();
		let count = 0;
		for (const entry of store.list()) {
			if (count >= this.batchSize) break;
			// Ring-scoped, through the *same* predicate every other ring-shaped read uses (see
			// `isLiveMember`): only live same-network peers are surfaced to libp2p's discovery
			// pipeline, so a foreign, unclassified, or dead peer is never re-seeded into peer
			// selection upstream. The whole store is re-scanned each tick, so a peer is emitted as
			// soon as the classification probe labels it `member` — or as soon as the dead re-probe
			// arm resurrects it.
			if (!isLiveMember(entry)) continue;
			// Self is seeded `member` and lives in the store, so without this every debounce
			// window would produce one "discovery mechanism discovered self" error from libp2p.
			if (selfId !== null && entry.id === selfId) continue;
			// Presence *is* the debounce: the map's TTL is `debounceMs`, so an entry still present
			// is still inside its window.
			if (this.emitted.has(entry.id)) continue;
			try {
				const id = peerIdFromString(entry.id);
				// NOTE: multiaddrs are deliberately empty — FRET discovery is peerStore-relative
				// by design. FRET's wire format carries no addresses at all (see *Dialability* in
				// docs/fret.md), and the only addresses available locally are the ones libp2p's
				// peerStore already holds, so filling them in would merge a peerStore's contents
				// into itself. Changing this needs address hints on the wire — see the backlog
				// ticket `feat-address-hints-in-neighbor-exchange`.
				const info: PeerInfo = { id, multiaddrs: [] };
				this.safeDispatchEvent('peer', { detail: info });
				this.emitted.set(entry.id, now);
				count++;
			} catch (err) {
				log.error('scan emit failed for %s - %e', entry.id, err);
			}
		}
		// Unconditional: the old `size > 4096` early return meant that after any burst the map held
		// up to 4096 mostly-expired entries forever and never shrank. Sweeping on this tick — the
		// map's own 5 s cadence — is what keeps it bounded by live population rather than by peak.
		this.emitted.sweep();
	}
}
