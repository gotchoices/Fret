import type { PeerDiscovery, PeerDiscoveryEvents, PeerInfo, Startable } from '@libp2p/interface';
import { peerDiscoverySymbol } from '@libp2p/interface';
import { TypedEventEmitter } from 'main-event';
import { peerIdFromString } from '@libp2p/peer-id';
import type { DigitreeStore } from '../store/digitree-store.js';
import { createLogger } from '../logger.js';

const log = createLogger('service:peer-discovery');

export interface FretPeerDiscoveryConfig {
	/** Interval (ms) between scan ticks that emit discovered peers. Default: 5000. */
	emissionIntervalMs?: number;
	/** Max peers to emit per tick. Default: 20. */
	batchSize?: number;
	/** Time (ms) before a previously emitted peer can be re-emitted. Default: 600_000 (10 min). */
	debounceMs?: number;
}

/**
 * libp2p PeerDiscovery backed by FRET's Digitree.
 *
 * Periodically scans the store for live (non-dead) peers and emits `peer`
 * events. Recently emitted peers are debounced to avoid flooding the
 * discovery pipeline.
 */
export class FretPeerDiscovery extends TypedEventEmitter<PeerDiscoveryEvents> implements PeerDiscovery, Startable {
	private readonly store: DigitreeStore;
	private readonly emissionIntervalMs: number;
	private readonly batchSize: number;
	private readonly debounceMs: number;
	private readonly emitted = new Map<string, number>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;

	get [peerDiscoverySymbol](): PeerDiscovery {
		return this;
	}

	get [Symbol.toStringTag](): string {
		return '@optimystic/fret-peer-discovery';
	}

	constructor(store: DigitreeStore, cfg?: FretPeerDiscoveryConfig) {
		super();
		this.store = store;
		this.emissionIntervalMs = cfg?.emissionIntervalMs ?? 5000;
		this.batchSize = cfg?.batchSize ?? 20;
		this.debounceMs = cfg?.debounceMs ?? 600_000;
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

	private scan(): void {
		const now = Date.now();
		let count = 0;
		for (const entry of this.store.list()) {
			if (count >= this.batchSize) break;
			if (entry.state === 'dead') continue;
			const prev = this.emitted.get(entry.id);
			if (prev !== undefined && prev > now) continue;
			try {
				const id = peerIdFromString(entry.id);
				const info: PeerInfo = { id, multiaddrs: [] };
				this.safeDispatchEvent('peer', { detail: info });
				this.emitted.set(entry.id, now + this.debounceMs);
				count++;
			} catch (err) {
				log.error('scan emit failed for %s - %e', entry.id, err);
			}
		}
		this.pruneExpired(now);
	}

	private pruneExpired(now: number): void {
		if (this.emitted.size <= 4096) return;
		for (const [id, exp] of this.emitted) {
			if (exp <= now) this.emitted.delete(id);
		}
	}
}
