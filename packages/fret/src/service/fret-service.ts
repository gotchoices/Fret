import type { Startable, PeerId, PeerInfo } from '@libp2p/interface';
import type {
	FretService as IFretService,
	FretMode,
	FretConfig,
	ReportEvent,
	RouteAndMaybeActV1,
	NearAnchorV1,
	BusyResponseV1,
	NeighborSnapshotV1,
	SerializedTable,
	ActivityHandler,
	RouteProgress,
	LookupOptions,
} from '../index.js';
import { DigitreeStore, type PeerEntry } from '../store/digitree-store.js';
import { hashKey, hashPeerId, coordToBase64url } from '../ring/hash.js';
import type { Libp2p } from 'libp2p';
import { makeProtocols, validateTimestamp } from '../rpc/protocols.js';
import { registerNeighbors, fetchNeighbors, announceNeighbors } from '../rpc/neighbors.js';
import { registerMaybeAct, sendMaybeAct } from '../rpc/maybe-act.js';
import { registerLeave, sendLeave } from '../rpc/leave.js';
import { registerPing, sendPing } from '../rpc/ping.js';
import { fromString as u8FromString } from 'uint8arrays/from-string';
import { estimateSizeAndConfidence } from '../estimate/size-estimator.js';
import { TokenBucket } from '../utils/token-bucket.js';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { chooseNextHop, type NextHopOptions } from '../selector/next-hop.js';
import { DedupCache } from './dedup-cache.js';
import { shouldIncludePayload, computeNearRadius } from './payload-heuristic.js';
import { xorDistance } from '../ring/distance.js';
import {
    createSparsityModel,
    normalizedLogDistance,
    touch as scoreTouch,
    recordSuccess as scoreSuccess,
    recordFailure as scoreFailure,
    type SparsityModel,
} from '../store/relevance.js';
import { createLogger } from '../logger.js';

const log = createLogger('service:fret');

function isBusy(res: unknown): res is BusyResponseV1 {
	return typeof res === 'object' && res !== null && 'busy' in res && (res as any).busy === true;
}

interface WithPeerStore {
	peerStore?: { getPeers?: () => Array<{ id: PeerId }> };
}

export class FretService implements IFretService, Startable {
	private mode: FretMode = 'passive';
	private readonly store = new DigitreeStore();
	private readonly cfg: FretConfig;
	private readonly node: Libp2p;
	private stabilizing = false;
	private inflightAct = 0;
	private readonly bucketNeighbors: TokenBucket;
	private readonly bucketMaybeAct: TokenBucket;
	private readonly bucketDiscovery: TokenBucket;
	private readonly announcedIds = new Map<string, number>();
	private postBootstrapAnnounced = false;
	private readonly sparsity: SparsityModel = createSparsityModel();
	private cachedSelfCoord: Uint8Array | null = null;
	private preconnectRunning = false;
	private readonly protocols: ReturnType<typeof import('../rpc/protocols.js').makeProtocols>;
	private metadata?: Record<string, any>;
	private activityHandler?: ActivityHandler;
	private readonly dedupCache = new DedupCache<NearAnchorV1 | { commitCertificate: string }>();
	private readonly backoffMap = new Map<string, { until: number; factor: number }>();
	private readonly bucketPing: TokenBucket;
	private readonly bucketLeave: TokenBucket;
	private readonly diag = {
		peersDiscovered: 0,
		snapshotsFetched: 0,
		announcementsSent: 0,
		pingsSent: 0,
		pingsOk: 0,
		pingsFail: 0,
		maybeActForwarded: 0,
		evictions: 0,
		rejected: {
			payloadTooLarge: 0,
			timestampBounds: 0,
			ttlExpired: 0,
			rateLimited: 0,
		},
	};

	// Network size observation tracking
	private networkObservations: Array<{
		estimate: number;
		confidence: number;
		timestamp: number;
		source: string;
	}> = [];
	private readonly maxObservations = 100;
	private readonly observationWindowMs = 300000; // 5 minutes

	constructor(node: Libp2p, cfg?: Partial<FretConfig>) {
		this.node = node;
		this.cfg = {
			k: cfg?.k ?? 15,
			m: cfg?.m ?? Math.ceil((cfg?.k ?? 15) / 2),
			capacity: cfg?.capacity ?? 2048,
			profile: cfg?.profile ?? 'core',
			bootstraps: cfg?.bootstraps ?? [],
			networkName: cfg?.networkName ?? 'default',
		};
		// Create network-specific protocols
		this.protocols = makeProtocols(this.cfg.networkName);
		// Discovery rate differs by profile
		this.bucketDiscovery = new TokenBucket(
			this.cfg.profile === 'core' ? 50 : 10,
			this.cfg.profile === 'core' ? 25 : 3
		);
		this.bucketNeighbors = new TokenBucket(
			this.cfg.profile === 'core' ? 20 : 8,
			this.cfg.profile === 'core' ? 10 : 4
		);
		this.bucketMaybeAct = new TokenBucket(
			this.cfg.profile === 'core' ? 32 : 8,
			this.cfg.profile === 'core' ? 16 : 4
		);
		this.bucketPing = new TokenBucket(
			this.cfg.profile === 'core' ? 30 : 10,
			this.cfg.profile === 'core' ? 15 : 5
		);
		this.bucketLeave = new TokenBucket(
			this.cfg.profile === 'core' ? 20 : 8,
			this.cfg.profile === 'core' ? 10 : 4
		);
	}

	public getDiagnostics(): Readonly<typeof this.diag> {
		return this.diag;
	}

	private async selfCoord(): Promise<Uint8Array> {
		if (this.cachedSelfCoord) return this.cachedSelfCoord;
		this.cachedSelfCoord = await hashPeerId(this.node.peerId);
		return this.cachedSelfCoord;
	}

	private enforceCapacity(): void {
		const cap = Math.max(1, this.cfg.capacity);
		if (this.store.size() <= cap) return;
		// Protect immediate neighbors around self
		const self = this.cachedSelfCoord;
		if (!self) return;
		const protectedIds = this.store.protectedIdsAround(self, Math.max(2, this.cfg.m));
		// Evict the lowest relevance non-protected entries until under cap
		const entries = this.store.list();
		entries.sort((a, b) => a.relevance - b.relevance);
		for (const e of entries) {
			if (this.store.size() <= cap) break;
			if (protectedIds.has(e.id)) continue;
			this.store.remove(e.id);
		}
	}

	private async applyTouch(id: string, coord: Uint8Array): Promise<void> {
		const entry = this.store.getById(id) ?? this.store.upsert(id, coord);
		const x = normalizedLogDistance(await this.selfCoord(), coord);
		const next = scoreTouch(entry, x, this.sparsity);
		this.store.update(id, {
			lastAccess: next.lastAccess,
			relevance: next.relevance,
			accessCount: next.accessCount
		});
	}

	private async applySuccess(id: string, coord: Uint8Array, latencyMs: number): Promise<void> {
		const entry = this.store.getById(id) ?? this.store.upsert(id, coord);
		const x = normalizedLogDistance(await this.selfCoord(), coord);
		const next = scoreSuccess(entry, latencyMs, x, this.sparsity);
		this.store.update(id, {
			lastAccess: next.lastAccess,
			relevance: next.relevance,
			successCount: next.successCount,
			avgLatencyMs: next.avgLatencyMs
		});
	}

	private async applyFailure(id: string, coord: Uint8Array): Promise<void> {
		const entry = this.store.getById(id) ?? this.store.upsert(id, coord);
		const x = normalizedLogDistance(await this.selfCoord(), coord);
		const next = scoreFailure(entry, x, this.sparsity);
		this.store.update(id, {
			lastAccess: next.lastAccess,
			relevance: next.relevance,
			failureCount: next.failureCount
		});
	}

	async start(): Promise<void> {
		await this.seedFromPeerStore();
		this.registerRpcHandlers();
		await this.proactiveAnnounceOnStart();
		this.startStabilizationLoop();
		if (this.mode === 'active') void this.preconnectNeighbors();
		// One-time post-bootstrap announce when first remote connects
		this.node.addEventListener('peer:connect', async (evt: any) => {
			if (this.postBootstrapAnnounced) return;
			this.postBootstrapAnnounced = true;
			try { await this.announceNeighborsBounded(8); } catch (err) { log.error('postBootstrap announce failed - %e', err) }
		});
		this.node.addEventListener('peer:connect', async (evt: any) => {
			try {
				// libp2p v3: evt.detail is the PeerId directly, not { id: PeerId }
				const id = evt?.detail?.toString?.();
				if (!id) return;
				const coord = this.store.getById(id)?.coord ?? (await hashPeerId(peerIdFromString(id)));
				this.store.upsert(id, coord);
				this.store.setState(id, 'connected');
				await this.applyTouch(id, coord);
			} catch (err) { log.error('peer:connect handler failed - %e', err) }
		});
		this.node.addEventListener('peer:disconnect', async (evt: any) => {
			try {
				// libp2p v3: evt.detail is the PeerId directly, not { id: PeerId }
				const id = evt?.detail?.toString?.();
				if (!id) return;
				const coord = this.store.getById(id)?.coord ?? (await hashPeerId(peerIdFromString(id)));
				this.store.setState(id, 'disconnected');
				await this.applyFailure(id, coord);
			} catch (err) { log.error('peer:disconnect handler failed - %e', err) }
		});
	}

	async stop(): Promise<void> {
		this.stabilizing = false;
		try { await this.sendLeaveToNeighbors(); } catch (err) { console.warn('sendLeaveToNeighbors failed', err); }
	}

	setMode(mode: FretMode): void {
		this.mode = mode;
		if (mode === 'active' && !this.preconnectRunning) this.startActivePreconnectLoop();
	}

	async ready(): Promise<void> {}

	private maxBytesNeighbors(): number { return this.cfg.profile === 'core' ? 128 * 1024 : 64 * 1024; }
	private maxBytesMaybeAct(): number { return this.cfg.profile === 'core' ? 512 * 1024 : 256 * 1024; }

	// RPC registration
	private registerRpcHandlers(): void {
		registerNeighbors(
			this.node,
			async () => this.handleNeighborsRequest(),
			(from, snap) => {
				void this.mergeAnnounceSnapshot(from, snap);
			},
			this.protocols,
			this.maxBytesNeighbors()
		);
		registerMaybeAct(this.node, async (msg) => this.handleMaybeAct(msg), this.protocols.PROTOCOL_MAYBE_ACT, this.maxBytesMaybeAct());
		registerLeave(this.node, async (notice) => this.handleLeave(notice), this.protocols.PROTOCOL_LEAVE);
		registerPing(
			this.node,
			this.protocols.PROTOCOL_PING,
			() => this.handlePingRequest()
		);
	}

	private async handleNeighborsRequest(): Promise<NeighborSnapshotV1 | BusyResponseV1> {
		if (!this.bucketNeighbors.tryTake()) {
			this.diag.rejected.rateLimited++;
			return { v: 1, busy: true, retry_after_ms: this.bucketNeighbors.retryAfterMs() };
		}
		return await this.snapshot();
	}

	private handlePingRequest(): { size_estimate?: number; confidence?: number } | BusyResponseV1 {
		if (!this.bucketPing.tryTake()) {
			this.diag.rejected.rateLimited++;
			return { v: 1, busy: true, retry_after_ms: this.bucketPing.retryAfterMs() } satisfies BusyResponseV1;
		}
		return this.getNetworkSizeEstimate();
	}

	private async handleMaybeAct(
		msg: RouteAndMaybeActV1
	): Promise<NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }> {
		// Breadcrumb loop detection: reject if self already visited
		const selfId = this.node.peerId.toString();
		if (msg.breadcrumbs?.includes(selfId)) return await this.nearAnchorOnly(msg);

		// Correlation-ID dedup: return cached result if seen before
		if (msg.correlation_id) {
			const cached = this.dedupCache.get(msg.correlation_id);
			if (cached) return cached;
		}

		// Timestamp freshness: reject messages outside ±5 min window
		if (!validateTimestamp(msg.timestamp)) {
			this.diag.rejected.timestampBounds++;
			return await this.nearAnchorOnly(msg);
		}

		// Quick guards
		if (msg.ttl <= 0) { this.diag.rejected.ttlExpired++; return await this.nearAnchorOnly(msg); }
		if (msg.activity && msg.activity.length > 128 * 1024) { this.diag.rejected.payloadTooLarge++; return await this.nearAnchorOnly(msg); }
		if (!this.bucketMaybeAct.tryTake()) { this.diag.rejected.rateLimited++; return { v: 1, busy: true, retry_after_ms: this.bucketMaybeAct.retryAfterMs() }; }
		const limit = this.cfg.profile === 'core' ? 16 : 4;
		if (this.inflightAct >= limit) { this.diag.rejected.rateLimited++; return { v: 1, busy: true, retry_after_ms: 500 }; }
		this.inflightAct++;
		try {
			const result = await this.routeAct(msg);
			// Cache result for dedup
			if (msg.correlation_id) this.dedupCache.set(msg.correlation_id, result);
			return result;
		} catch (err) {
			log.error('routeAct failed - %e', err);
			return await this.nearAnchorOnly(msg);
		} finally {
			this.inflightAct--;
		}
	}

	private isConnected(id: string): boolean {
		try {
			return this.node.getConnections(peerIdFromString(id)).length > 0;
		} catch {
			return false;
		}
	}

	private hasAddresses(id: string): boolean {
		try {
			// libp2p >=2 exposes getMultiaddrsForPeer
			const addrs = (this.node as any).getMultiaddrsForPeer?.(peerIdFromString(id)) ?? [];
			return Array.isArray(addrs) && addrs.length > 0;
		} catch {
			return false;
		}
	}

	private async proactiveAnnounceOnStart(): Promise<void> {
		try {
			await this.announceNeighborsBounded(8);
		} catch (err) {
			console.warn('proactiveAnnounceOnStart failed', err);
		}
	}

	private async announceNeighborsBounded(maxCount: number): Promise<void> {
		const selfCoord = await hashPeerId(this.node.peerId);
		const selfStr = this.node.peerId.toString();
		const ids = Array.from(new Set([
			...this.getNeighbors(selfCoord, 'right', this.cfg.m),
			...this.getNeighbors(selfCoord, 'left', this.cfg.m)
		])).filter((id) => id !== selfStr).slice(0, maxCount);
		const snap = await this.snapshot();
		for (const id of ids) {
			if (this.isConnected(id) || this.hasAddresses(id)) {
				try { await announceNeighbors(this.node, id, snap, this.protocols.PROTOCOL_NEIGHBORS_ANNOUNCE); this.diag.announcementsSent++; } catch (err) { console.warn('announce failed', id, err); }
			}
		}
	}

	private async preconnectNeighbors(): Promise<void> {
		try {
			const selfCoord = await hashPeerId(this.node.peerId);
			const selfStr = this.node.peerId.toString();
			const ids = Array.from(new Set([
				...this.getNeighbors(selfCoord, 'right', Math.min(6, this.cfg.m)),
				...this.getNeighbors(selfCoord, 'left', Math.min(6, this.cfg.m))
			])).filter((id) => id !== selfStr);
			for (const id of ids) {
				if (this.isConnected(id) || this.hasAddresses(id)) {
					try { await sendPing(this.node, id, this.protocols.PROTOCOL_PING); this.diag.pingsSent++; } catch (err) { log.error('preconnectNeighbors ping failed for %s - %e', id, err) }
				}
			}
		} catch (err) { log.error('preconnectNeighbors outer failed - %e', err) }
	}

	private startActivePreconnectLoop(): void {
		if (this.preconnectRunning) return;
		this.preconnectRunning = true;
		const tick = async () => {
			if (!this.preconnectRunning || this.mode !== 'active') { this.preconnectRunning = false; return; }
			try {
				const selfCoord = await this.selfCoord();
				const selfStr = this.node.peerId.toString();
				const budget = this.cfg.profile === 'core' ? 6 : 3;
				const ids = Array.from(new Set([
					...this.getNeighbors(selfCoord, 'right', Math.min(12, this.cfg.m)),
					...this.getNeighbors(selfCoord, 'left', Math.min(12, this.cfg.m))
				])).filter((id) => id !== selfStr).slice(0, budget);
				for (const id of ids) {
					if (this.isConnected(id) || this.hasAddresses(id)) {
					try { await sendPing(this.node, id, this.protocols.PROTOCOL_PING); this.diag.pingsSent++; } catch (err) { log.error('active preconnect ping failed for %s - %e', id, err) }
				}
			}
			} catch (err) { log.error('active preconnect tick failed - %e', err) }
			setTimeout(tick, 1000);
		};
		void tick();
	}

	private computeReplacements(selfCoord: Uint8Array, spNeighborIds: Set<string>, selfStr: string): string[] {
		const maxReplacements = 6;
		const wider = Array.from(new Set([
			...this.store.neighborsRight(selfCoord, this.cfg.m * 2),
			...this.store.neighborsLeft(selfCoord, this.cfg.m * 2),
		])).filter((id) => id !== selfStr && !spNeighborIds.has(id));
		wider.sort((a, b) => {
			const connA = this.isConnected(a) ? 1 : 0;
			const connB = this.isConnected(b) ? 1 : 0;
			if (connA !== connB) return connB - connA;
			return (this.store.getById(b)?.relevance ?? 0) - (this.store.getById(a)?.relevance ?? 0);
		});
		return wider.slice(0, maxReplacements);
	}

	private async sendLeaveToNeighbors(): Promise<void> {
		try {
			const selfCoord = await hashPeerId(this.node.peerId);
			const selfStr = this.node.peerId.toString();
			const ids = Array.from(new Set([
				...this.getNeighbors(selfCoord, 'right', this.cfg.m),
				...this.getNeighbors(selfCoord, 'left', this.cfg.m)
			])).filter((id) => id !== selfStr).slice(0, 8);
			const spSet = new Set(ids);
			const replacements = this.computeReplacements(selfCoord, spSet, selfStr);
			const notice = { v: 1, from: this.node.peerId.toString(), replacements: replacements.length > 0 ? replacements : undefined, timestamp: Date.now() } as const;
			for (const id of ids) {
				try { await sendLeave(this.node, id, notice, this.protocols.PROTOCOL_LEAVE); } catch (err) { log.error('sendLeave failed for %s - %e', id, err) }
			}
			// Bounded fan-out beyond S/P (connected peers only)
			const fanOut = this.cfg.profile === 'core' ? 4 : 2;
			const expanded = this.expandCohort(ids, selfCoord, fanOut, new Set([selfStr]));
			const extra = expanded.filter((id) => !spSet.has(id) && this.isConnected(id)).slice(0, fanOut);
			for (const id of extra) {
				try { await sendLeave(this.node, id, notice, this.protocols.PROTOCOL_LEAVE); } catch (err) { log.error('sendLeave fan-out failed for %s - %e', id, err) }
			}
		} catch (err) { log.error('sendLeaveToNeighbors outer failed - %e', err) }
	}

	private async handleLeave(notice: { from: string; replacements?: string[]; timestamp: number }): Promise<void> {
		if (!this.bucketLeave.tryTake()) { this.diag.rejected.rateLimited++; return; }
		if (!validateTimestamp(notice.timestamp)) { this.diag.rejected.timestampBounds++; return; }
		const peerId = notice.from;
		try {
			let coord: Uint8Array | null = null;
			const entry = this.store.getById(peerId);
			if (entry) coord = entry.coord;
			else {
				try {
					coord = await hashPeerId(peerIdFromString(peerId));
				} catch (e) {
					console.warn('handleLeave: could not hash departing peer id', peerId, e);
				}
			}
			// remove leaving peer from the store
			this.store.remove(peerId);
			if (!coord) return;
			// Merge suggested replacements from notice with locally computed ones
			const suggested = (notice.replacements ?? []).filter((id) => {
				try { peerIdFromString(id); return true; } catch { return false; }
			});
			const base = Array.from(
				new Set([
					...this.store.neighborsRight(coord, this.cfg.m),
					...this.store.neighborsLeft(coord, this.cfg.m),
				])
			);
			const expanded = this.expandCohort(base, coord, Math.max(2, Math.ceil(this.cfg.m / 2)));
			const baseSet = new Set(base);
			const localNew = expanded.filter((id) => !baseSet.has(id));
			// Suggested first (departing peer vouched for them), then locally discovered
			const selfStr = this.node.peerId.toString();
			const seen = new Set([peerId, selfStr, ...base]);
			const newIds: string[] = [];
			for (const id of suggested) {
				if (!seen.has(id)) { newIds.push(id); seen.add(id); }
			}
			for (const id of localNew) {
				if (!seen.has(id)) { newIds.push(id); seen.add(id); }
			}
			// proactively warm a bounded number of replacements and merge their neighbor views
			const warm = newIds.slice(0, Math.min(newIds.length, 6));
			for (const id of warm) {
				try {
					await sendPing(this.node, id, this.protocols.PROTOCOL_PING);
					if (!this.isConnected(id)) {
						const snap = await this.snapshot();
						await announceNeighbors(this.node, id, snap, this.protocols.PROTOCOL_NEIGHBORS_ANNOUNCE);
					}
				} catch (err) {
					console.warn('warm/announce failed for', id, err);
				}
			}
			await this.mergeNeighborSnapshots(warm.slice(0, 4));
			// Announce replacement info to immediate neighbors
			void this.announceReplacementsToNeighbors(coord);
		} catch (err) {
			console.error('handleLeave failed for', peerId, err);
		}
	}

	private async announceReplacementsToNeighbors(aroundCoord: Uint8Array): Promise<void> {
		const selfStr = this.node.peerId.toString();
		const neighbors = Array.from(new Set([
			...this.store.neighborsRight(aroundCoord, this.cfg.m),
			...this.store.neighborsLeft(aroundCoord, this.cfg.m),
		])).filter((id) => id !== selfStr && this.isConnected(id)).slice(0, 4);
		const snap = await this.snapshot();
		for (const id of neighbors) {
			try {
				await announceNeighbors(this.node, id, snap, this.protocols.PROTOCOL_NEIGHBORS_ANNOUNCE);
			} catch (err) {
				log.error('announceReplacementsToNeighbors failed for %s - %e', id, err);
			}
		}
	}

	private async mergeAnnounceSnapshot(from: string, snap: NeighborSnapshotV1): Promise<void> {
		if (!validateTimestamp(snap.timestamp)) { this.diag.rejected.timestampBounds++; return; }
		try {
			const self = peerIdFromString(from);
			const selfCoord = await hashPeerId(self);
			const discovered: string[] = [];
			if (!this.store.getById(from)) discovered.push(from);
			this.store.upsert(from, selfCoord);
			await this.applyTouch(from, selfCoord);

			if (snap.metadata) {
				// Update metadata via store.update to avoid mutating frozen entries
				this.store.update(from, { metadata: snap.metadata });
			}

			for (const pid of [...(snap.successors ?? []), ...(snap.predecessors ?? [])]) {
				try {
					const coord = await hashPeerId(peerIdFromString(pid));
					if (!this.store.getById(pid)) discovered.push(pid);
					this.store.upsert(pid, coord);
					await this.applyTouch(pid, coord);
				} catch (err) {
					console.warn('mergeAnnounceSnapshot: failed for', pid, err);
				}
			}
			// merge bounded sample if present
			for (const s of snap.sample ?? []) {
					try {
					const coord = u8FromString(s.coord, 'base64url');
					if (!this.store.getById(s.id)) discovered.push(s.id);
					this.store.upsert(s.id, coord);
					await this.applyTouch(s.id, coord);
					} catch (err) { log.error('mergeAnnounceSnapshot sample upsert failed for %s - %e', s.id, err) }
			}
			this.enforceCapacity();
			this.emitDiscovered(discovered);
		} catch (err) {
			console.warn('mergeAnnounceSnapshot failed for', from, err);
		}
	}

	// Seeding and stabilization
	private async seedFromPeerStore(): Promise<void> {
		try {
			const peers = (this.node as unknown as WithPeerStore).peerStore?.getPeers?.() ?? [];
			const discovered: string[] = [];
			for (const p of peers) {
				try {
					const coord = await hashPeerId(p.id);
					const pidStr = p.id.toString();
					if (!this.store.getById(pidStr)) discovered.push(pidStr);
					this.store.upsert(pidStr, coord);
				} catch (err) {
					console.warn('failed to add peer from peerStore', p?.id?.toString?.(), err);
				}
			}
			try {
				const coord = await hashPeerId(this.node.peerId);
				const selfStr = this.node.peerId.toString();
				if (!this.store.getById(selfStr)) discovered.push(selfStr);
				this.store.upsert(selfStr, coord);
			} catch (err) {
				console.error('failed to add self to store', err);
			}
			this.enforceCapacity();
			this.emitDiscovered(discovered);
		} catch (err) {
			console.error('seedFromPeerStore failed:', err);
		}
	}

	private startStabilizationLoop(): void {
		if (this.stabilizing) return;
		this.stabilizing = true;
		const tick = async () => {
			if (!this.stabilizing) return;
			try {
				await this.seedFromPeerStore();
				await this.seedFromBootstraps();
				await this.stabilizeOnce();
			} catch (err) {
				console.error('stabilize tick failed:', err);
			} finally {
				const delay = this.mode === 'active' ? 300 : 1500;
				setTimeout(tick, delay);
			}
		};
		tick();
	}

	private async seedFromBootstraps(): Promise<void> {
		if (!this.cfg.bootstraps || this.cfg.bootstraps.length === 0) return;
		const discovered: string[] = [];
		for (const bootstrapEntry of this.cfg.bootstraps.slice(0, 8)) {
			try {
				let id = bootstrapEntry;
				// If it's a multiaddr, extract the peer ID using proper parsing
				if (bootstrapEntry.startsWith('/')) {
					try {
						const ma = multiaddr(bootstrapEntry);
						const p2p = ma.getComponents().find((c) => c.name === 'p2p');
						if (p2p?.value) id = p2p.value;
					} catch {
						// Not a valid multiaddr, assume it's already a peer ID
					}
				}
				const pid = peerIdFromString(id);
				const coord = await hashPeerId(pid);
				if (!this.store.getById(id)) discovered.push(id);
				this.store.upsert(id, coord);
				await this.applyTouch(id, coord);
			} catch (err) {
				console.warn('seedFromBootstraps failed for', bootstrapEntry, err);
			}
		}
		this.enforceCapacity();
		this.emitDiscovered(discovered);
	}

	private async stabilizeOnce(): Promise<void> {
		const selfCoord = await hashPeerId(this.node.peerId);
		const selfStr = this.node.peerId.toString();
		const nearAll = this.getNeighbors(selfCoord, 'both', Math.max(2, this.cfg.m));
		const near = nearAll.filter((id) => id !== selfStr && (this.isConnected(id) || this.hasAddresses(id)));
		await this.probeNeighborsLatency(near.slice(0, 4));
		await this.mergeNeighborSnapshots(near.slice(0, 4));
	}

	private async probeNeighborsLatency(ids: string[]): Promise<void> {
		for (const id of ids) {
			try {
				const res = await sendPing(this.node, id, this.protocols.PROTOCOL_PING);
				this.diag.pingsSent++;
				if (res.ok) {
					const coord = this.store.getById(id)?.coord ?? (await hashPeerId(peerIdFromString(id)));
					await this.applySuccess(id, coord, res.rttMs);
					this.diag.pingsOk++;
				} else {
					const coord = this.store.getById(id)?.coord ?? (await hashPeerId(peerIdFromString(id)));
					await this.applyFailure(id, coord);
					this.diag.pingsFail++;
				}
			} catch (err) {
				// benign during churn - do not warn each tick
				// console.warn('ping failed for', id, err);
				try {
					const coord = this.store.getById(id)?.coord ?? (await hashPeerId(peerIdFromString(id)));
					await this.applyFailure(id, coord);
					this.diag.pingsFail++;
				} catch {}
			}
		}
	}

	private async mergeNeighborSnapshots(ids: string[]): Promise<void> {
		const announced: string[] = [];
		for (const id of ids) {
			try {
				const snap: NeighborSnapshotV1 = await fetchNeighbors(this.node, id, this.protocols.PROTOCOL_NEIGHBORS);
				this.diag.snapshotsFetched++;
				const capSucc = this.cfg.profile === 'core' ? 16 : 8;
				const capPred = this.cfg.profile === 'core' ? 16 : 8;
				const succList = (snap.successors ?? []).slice(0, capSucc);
				const predList = (snap.predecessors ?? []).slice(0, capPred);
				for (const pid of [...succList, ...predList]) {
					try {
						const coord = await hashPeerId(peerIdFromString(pid));
						if (!this.store.getById(pid)) announced.push(pid);
						this.store.upsert(pid, coord);
						await this.applyTouch(pid, coord);
					} catch (err) {
						console.warn('failed to merge neighbor', pid, err);
					}
				}
				const capSample = this.cfg.profile === 'core' ? 8 : 6;
		for (const s of (snap.sample ?? []).slice(0, capSample)) {
			try {
						const coord = u8FromString(s.coord, 'base64url');
						if (!this.store.getById(s.id)) announced.push(s.id);
						this.store.upsert(s.id, coord);
						await this.applyTouch(s.id, coord);
				} catch (err) { log.error('mergeNeighborSnapshots sample upsert failed for %s - %e', s.id, err) }
				}
			} catch (err) {
				console.warn('fetchNeighbors failed for', id, err);
			}
		}
		this.enforceCapacity();
		this.emitDiscovered(announced);
	}

	// Snapshots
	private async snapshot(): Promise<NeighborSnapshotV1> {
		const selfCoord = await hashPeerId(this.node.peerId);
		const { n, confidence } = estimateSizeAndConfidence(this.store, this.cfg.m);
		const capSucc = this.cfg.profile === 'core' ? 12 : 6;
		const capPred = this.cfg.profile === 'core' ? 12 : 6;
		const capSample = this.cfg.profile === 'core' ? 8 : 6;
		const rawSucc = this.getNeighbors(selfCoord, 'right', this.cfg.m);
		const rawPred = this.getNeighbors(selfCoord, 'left', this.cfg.m);
		const successors = rawSucc.slice(0, capSucc);
		const predecessors = rawPred.slice(0, capPred);
		const sampleIds = Array.from(new Set([...successors.slice(0, 4), ...predecessors.slice(0, 4)])).slice(0, capSample);
		const sample = await Promise.all(sampleIds.map(async (id) => {
			const entry = this.store.getById(id);
			if (!entry) return { id, coord: '', relevance: 0 } as { id: string; coord: string; relevance: number };
			return { id, coord: coordToBase64url(entry.coord), relevance: entry.relevance } as { id: string; coord: string; relevance: number };
		}));
		return {
			v: 1,
			from: this.node.peerId.toString(),
			timestamp: Date.now(),
			successors,
			predecessors,
			sample,
			size_estimate: n,
			confidence,
			sig: '',
			metadata: this.metadata,
		};
	}

	// Cohort/neighbors
	neighborDistance(selfId: string, hashedCoord: Uint8Array, k: number): number {
		const exclude = new Set<string>();
		const wants = Math.max(1, k);
		const cohort = this.assembleCohort(hashedCoord, wants, exclude);
		const idx = cohort.findIndex((id) => id === selfId);
		return idx >= 0 ? idx : Number.POSITIVE_INFINITY;
	}

	getNeighbors(
		hashedCoord: Uint8Array,
		direction: 'left' | 'right' | 'both',
		wants: number
	): string[] {
		const ids: string[] = [];
		if (direction === 'right' || direction === 'both')
			ids.push(...this.store.neighborsRight(hashedCoord, wants));
		if (direction === 'left' || direction === 'both')
			ids.push(...this.store.neighborsLeft(hashedCoord, wants));
		return Array.from(new Set(ids)).slice(0, wants);
	}

	private nextSuccessor(cur: PeerEntry, arr: PeerEntry[]): PeerEntry | undefined {
		const idx = arr.findIndex((e) => e.id === cur.id);
		return arr[(idx + 1) % arr.length];
	}
	private nextPredecessor(cur: PeerEntry, arr: PeerEntry[]): PeerEntry | undefined {
		const idx = arr.findIndex((e) => e.id === cur.id);
		return arr[(idx - 1 + arr.length) % arr.length];
	}

	assembleCohort(hashedCoord: Uint8Array, wants: number, exclude?: Set<string>): string[] {
		const out: string[] = [];
		const ex = exclude ?? new Set<string>();
		const succIds = this.store.neighborsRight(hashedCoord, wants * 2);
		const predIds = this.store.neighborsLeft(hashedCoord, wants * 2);
		let si = 0,
			pi = 0;
		while (out.length < wants && (si < succIds.length || pi < predIds.length)) {
			if (out.length % 2 === 0 && si < succIds.length) {
				const id = succIds[si++];
				if (id && !ex.has(id)) out.push(id);
			} else if (pi < predIds.length) {
				const id = predIds[pi++];
				if (id && !ex.has(id)) out.push(id);
			} else if (si < succIds.length) {
				const id = succIds[si++];
				if (id && !ex.has(id)) out.push(id);
			}
		}
		return Array.from(new Set(out)).slice(0, wants);
	}

	expandCohort(
		current: string[],
		hashedCoord: Uint8Array,
		step: number,
		exclude?: Set<string>
	): string[] {
		const base = new Set(current);
		const next = this.assembleCohort(hashedCoord, current.length + step, exclude);
		for (const id of next) base.add(id);
		return Array.from(base);
	}

	// Routing
	private async nearAnchorOnly(msg: RouteAndMaybeActV1): Promise<NearAnchorV1> {
		const keyBytes = u8FromString(msg.key, 'base64url');
		const coord = await hashKey(keyBytes);
		const right = this.getNeighbors(coord, 'right', this.cfg.m);
		const left = this.getNeighbors(coord, 'left', this.cfg.m);
		const anchors = this.pickAnchors([...right.slice(0, 3), ...left.slice(0, 3)]);
		return {
			v: 1,
			anchors,
			cohort_hint: Array.from(new Set([...right.slice(0, 2), ...left.slice(0, 2)])),
			estimated_cluster_size: this.cfg.k,
			confidence: 0.5,
		};
	}

	// Discovery event emission
	private emitDiscovered(ids: string[]): void {
		if (ids.length === 0) return;
		const now = Date.now();
		const ttl = this.cfg.profile === 'core' ? 10 * 60_000 : 30 * 60_000;
		const target = this.node as unknown as { dispatchEvent?: (evt: Event) => void };
		let emitted = 0;
		for (const id of Array.from(new Set(ids))) {
			const exp = this.announcedIds.get(id) ?? 0;
			if (exp > now) continue;
			if (!this.bucketDiscovery.tryTake()) break;
			try {
				const pid = peerIdFromString(id);
				target.dispatchEvent?.(new CustomEvent('peer:discovery', { detail: { id: pid, multiaddrs: [] } as PeerInfo }));
				this.announcedIds.set(id, now + ttl);
				emitted++;
			} catch (err) {
				console.warn('emitDiscovered failed for', id, err);
			}
		}
		// Optionally prune old entries to cap memory
		if (emitted > 0 && this.announcedIds.size > 4096) {
			for (const [k, v] of this.announcedIds) { if (v <= now) this.announcedIds.delete(k); }
		}
	}

	private pickAnchors(candidates: string[]): string[] {
		const unique = Array.from(new Set(candidates));
		if (unique.length === 0) return [];
		const linkQ = (_id: string) => 0.5; // neutral until reputation is enabled
		// Without a specific target here, prefer connected-first by using self coord as proxy
		// Compute self coord once
		const selfCoord = new Uint8Array(32);
		const first = chooseNextHop(this.store, selfCoord, unique, (id) => this.isConnected(id), linkQ);
		const rest = unique.filter((id) => id !== first);
		const second = chooseNextHop(this.store, selfCoord, rest, (id) => this.isConnected(id), linkQ);
		return [first, second].filter((x): x is string => Boolean(x));
	}

	async routeAct(msg: RouteAndMaybeActV1): Promise<NearAnchorV1 | { commitCertificate: string }> {
		const keyBytes = u8FromString(msg.key, 'base64url');
		const coord = await hashKey(keyBytes);
		const selfId = this.node.peerId.toString();
		const selfCoord = await this.selfCoord();
		const { n, confidence } = estimateSizeAndConfidence(this.store, this.cfg.m);

		// In-cluster test
		const distIdx = this.neighborDistance(selfId, coord, Math.max(2, msg.want_k ?? this.cfg.k));
		const inCluster = distIdx <= 1;

		if (inCluster) {
			// In-cluster with activity → perform via callback
			if (msg.activity && this.activityHandler) {
				const cohort = this.assembleCohort(coord, msg.want_k ?? this.cfg.k);
				const result = await this.activityHandler(
					msg.activity, cohort, msg.min_sigs, msg.correlation_id
				);
				return result;
			}
			// In-cluster without activity → return NearAnchor inviting resend
			return this.buildNearAnchor(coord, n, confidence);
		}

		// Not in-cluster: forward if TTL allows
		if (msg.ttl > 0) {
			const exclude = new Set([...(msg.breadcrumbs ?? []), selfId]);
			const candidates = this.assembleCohort(coord, Math.max(4, this.cfg.m))
				.filter((id) => !exclude.has(id));

			const hopOpts = this.buildNextHopOptions(n, confidence);
			const linkQ = (id: string) => this.linkQuality(id);
			const next = chooseNextHop(
				this.store, coord, candidates,
				(id) => this.isConnected(id), linkQ, hopOpts
			);

			if (next) {
				const fwd: RouteAndMaybeActV1 = {
					...msg,
					ttl: msg.ttl - 1,
					breadcrumbs: [...(msg.breadcrumbs ?? []), selfId]
				};
				try {
					this.diag.maybeActForwarded++;
					const result = await sendMaybeAct(this.node, next, fwd, this.protocols.PROTOCOL_MAYBE_ACT);
					if (isBusy(result)) {
						this.recordBackoff(next);
					} else {
						const nextCoord = this.store.getById(next)?.coord ?? (await hashPeerId(peerIdFromString(next)));
						await this.applySuccess(next, nextCoord, 0);
						this.clearBackoff(next);
						return result;
					}
				} catch (err) {
					log.error('forward maybeAct failed to %s - %e', next, err);
					this.recordBackoff(next);
				}
			}
		}

		// Fallback: return NearAnchor with best hints
		return this.buildNearAnchor(coord, n, confidence);
	}

	private buildNearAnchor(coord: Uint8Array, n: number, confidence: number): NearAnchorV1 {
		const right = this.getNeighbors(coord, 'right', this.cfg.m);
		const left = this.getNeighbors(coord, 'left', this.cfg.m);
		const anchors = this.pickAnchors([...right.slice(0, 4), ...left.slice(0, 4)]);
		return {
			v: 1,
			anchors,
			cohort_hint: Array.from(new Set([...right.slice(0, 4), ...left.slice(0, 4)])),
			estimated_cluster_size: Math.max(this.cfg.k, n),
			confidence,
		};
	}

	private buildNextHopOptions(sizeEstimate: number, confidence: number): NextHopOptions {
		return {
			nearRadius: computeNearRadius(sizeEstimate, this.cfg.k),
			confidence,
			backoffPenalty: (id) => this.getBackoffPenalty(id),
		};
	}

	private linkQuality(id: string): number {
		const entry = this.store.getById(id);
		if (!entry) return 0;
		const total = entry.successCount + entry.failureCount;
		if (total === 0) return 0.5;
		return entry.successCount / total;
	}

	private recordBackoff(id: string): void {
		const existing = this.backoffMap.get(id);
		const factor = existing ? Math.min(existing.factor * 2, 32) : 1;
		const baseMs = 1000;
		this.backoffMap.set(id, { until: Date.now() + baseMs * factor, factor });
	}

	private clearBackoff(id: string): void {
		this.backoffMap.delete(id);
	}

	private getBackoffPenalty(id: string): number {
		const bo = this.backoffMap.get(id);
		if (!bo) return 0;
		if (bo.until < Date.now()) {
			this.backoffMap.delete(id);
			return 0;
		}
		return Math.min(1, bo.factor / 32);
	}

	report(_evt: ReportEvent): void {
		// no-op until reputation is enabled
	}

	/**
	 * Add an external network size observation (e.g., from cluster messages, peer queries)
	 */
	reportNetworkSize(estimate: number, confidence: number, source: string = 'external'): void {
		const now = Date.now();
		this.networkObservations.push({
			estimate,
			confidence,
			timestamp: now,
			source
		});

		// Trim old observations
		const cutoff = now - this.observationWindowMs;
		this.networkObservations = this.networkObservations.filter(o => o.timestamp > cutoff);

		// Keep only most recent observations
		if (this.networkObservations.length > this.maxObservations) {
			this.networkObservations = this.networkObservations.slice(-this.maxObservations);
		}
	}

	/**
	 * Get enhanced network size estimate combining FRET's estimate with external observations
	 */
	getNetworkSizeEstimate(): { size_estimate: number; confidence: number; sources: number } {
		// Get FRET's own estimate
		const fretEstimate = estimateSizeAndConfidence(this.store, this.cfg.m);

		// Add FRET estimate as an observation
		const now = Date.now();
		const allObservations = [
			{
				estimate: fretEstimate.n,
				confidence: fretEstimate.confidence,
				timestamp: now,
				source: 'fret'
			},
			...this.networkObservations
		];

		if (allObservations.length === 0) {
			return { size_estimate: 0, confidence: 0, sources: 0 };
		}

		// Weight recent observations more heavily with exponential decay
		let totalWeight = 0;
		let weightedSum = 0;
		let confidenceSum = 0;

		for (const obs of allObservations) {
			const age = now - obs.timestamp;
			const recencyWeight = Math.exp(-age / (this.observationWindowMs / 3));
			const weight = recencyWeight * obs.confidence;

			weightedSum += obs.estimate * weight;
			confidenceSum += obs.confidence * recencyWeight;
			totalWeight += weight;
		}

		if (totalWeight === 0) {
			return { size_estimate: 0, confidence: 0, sources: 0 };
		}

		const estimate = Math.round(weightedSum / totalWeight);
		const avgConfidence = confidenceSum / allObservations.length;

		return {
			size_estimate: estimate,
			confidence: Math.min(1, avgConfidence),
			sources: allObservations.length
		};
	}

	/**
	 * Calculate recent rate of change in network size estimates
	 * Returns change per minute
	 */
	getNetworkChurn(): number {
		if (this.networkObservations.length < 2) {
			return 0;
		}

		const now = Date.now();
		const halfWindow = this.observationWindowMs / 2;
		const cutoff = now - halfWindow;

		const recentObs = this.networkObservations.filter(o => o.timestamp > cutoff);
		const olderObs = this.networkObservations.filter(o => o.timestamp <= cutoff);

		if (recentObs.length === 0 || olderObs.length === 0) {
			return 0;
		}

		const recentAvg = recentObs.reduce((sum, o) => sum + o.estimate, 0) / recentObs.length;
		const olderAvg = olderObs.reduce((sum, o) => sum + o.estimate, 0) / olderObs.length;

		// Return change per minute
		const changePerMs = (recentAvg - olderAvg) / halfWindow;
		return changePerMs * 60000;
	}

	/**
	 * Detect if we're likely in a network partition based on sudden drop
	 */
	detectPartition(): boolean {
		if (this.networkObservations.length < 10) {
			return false; // Not enough data
		}

		const current = this.getNetworkSizeEstimate();
		if (current.confidence < 0.3) {
			return false; // Not confident enough
		}

		// Get estimate from 30 seconds ago
		const thirtySecondsAgo = Date.now() - 30000;
		const oldObs = this.networkObservations.filter(o => o.timestamp < thirtySecondsAgo);

		if (oldObs.length < 3) {
			return false;
		}

		const oldAvg = oldObs.slice(-5).reduce((sum, o) => sum + o.estimate, 0) / Math.min(5, oldObs.length);

		// Detect sudden drop of more than 50%
		const dropRatio = current.size_estimate / oldAvg;
		if (dropRatio < 0.5) {
			return true;
		}

		// Also check churn rate
		const churn = Math.abs(this.getNetworkChurn());
		const churnThreshold = current.size_estimate * 0.1; // 10% per minute is suspicious

		return churn > churnThreshold;
	}

	setActivityHandler(handler: ActivityHandler): void {
		this.activityHandler = handler;
	}

	async *iterativeLookup(key: Uint8Array, options: LookupOptions): AsyncGenerator<RouteProgress> {
		const coord = await hashKey(key);
		const selfId = this.node.peerId.toString();
		const selfCoord = await this.selfCoord();
		const ttl = options.ttl ?? 8;
		const maxAttempts = options.maxAttempts ?? ttl + 2;
		const correlationId = `${selfId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		let hop = 0;
		let currentActivity = options.activity;
		let bestAnchors: string[] = [];

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const { n, confidence } = estimateSizeAndConfidence(this.store, this.cfg.m);

			// Decide whether to include payload
			const distToKey = xorDistance(selfCoord, coord);
			const includePayload = currentActivity
				? shouldIncludePayload(distToKey, n, confidence, options.wantK)
				: false;

			// Pick candidates: use anchors from prior hints if available, else local cohort
			const exclude = new Set([selfId]);
			const candidates = bestAnchors.length > 0
				? bestAnchors.filter((id) => !exclude.has(id))
				: this.assembleCohort(coord, Math.max(4, this.cfg.m)).filter((id) => !exclude.has(id));

			if (candidates.length === 0) {
				yield { type: 'exhausted', hop };
				return;
			}

			const hopOpts = this.buildNextHopOptions(n, confidence);
			const linkQ = (id: string) => this.linkQuality(id);
			const target = chooseNextHop(
				this.store, coord, candidates,
				(id) => this.isConnected(id), linkQ, hopOpts
			);

			if (!target) {
				yield { type: 'exhausted', hop };
				return;
			}

			yield { type: 'probing', hop, peerId: target, ttlRemaining: ttl - hop };

			const msg: RouteAndMaybeActV1 = {
				v: 1,
				key: coordToBase64url(key),
				want_k: options.wantK,
				ttl: ttl - hop,
				min_sigs: options.minSigs,
				digest: options.digest,
				activity: includePayload ? currentActivity : undefined,
				breadcrumbs: [selfId],
				correlation_id: correlationId,
				timestamp: Date.now(),
				signature: '',
			};

			try {
				const result = await sendMaybeAct(this.node, target, msg, this.protocols.PROTOCOL_MAYBE_ACT);

				if (isBusy(result)) {
					this.recordBackoff(target);
					continue;
				}

				if ('commitCertificate' in result) {
					yield { type: 'complete', hop, result, peerId: target };
					return;
				}

				// NearAnchor response
				const anchor = result as NearAnchorV1;
				yield { type: 'near_anchor', hop, nearAnchor: anchor, peerId: target };

				// If we have activity but didn't include it, resend with activity to the anchor
				if (currentActivity && !includePayload && anchor.anchors.length > 0) {
					const actTarget = anchor.anchors[0]!;
					yield { type: 'activity_sent', hop: hop + 1, peerId: actTarget };

					const actMsg: RouteAndMaybeActV1 = {
						...msg,
						activity: currentActivity,
						ttl: 1,
						breadcrumbs: [selfId, target],
					};

					try {
						const actResult = await sendMaybeAct(
							this.node, actTarget, actMsg, this.protocols.PROTOCOL_MAYBE_ACT
						);
						if (isBusy(actResult)) {
							this.recordBackoff(actTarget);
						} else if ('commitCertificate' in actResult) {
							yield { type: 'complete', hop: hop + 1, result: actResult, peerId: actTarget };
							return;
						} else {
							bestAnchors = (actResult as NearAnchorV1).anchors;
						}
					} catch (err) {
						log.error('activity send to anchor %s failed - %e', actTarget, err);
						this.recordBackoff(actTarget);
					}
				} else {
					bestAnchors = anchor.anchors;
				}

				// Update hints for next iteration
				if (anchor.cohort_hint.length > 0) {
					for (const hint of anchor.cohort_hint) {
						try {
							const hCoord = this.store.getById(hint)?.coord ?? (await hashPeerId(peerIdFromString(hint)));
							this.store.upsert(hint, hCoord);
						} catch {}
					}
				}

				hop++;
			} catch (err) {
				log.error('iterativeLookup hop %d to %s failed - %e', hop, target, err);
				this.recordBackoff(target);
				bestAnchors = bestAnchors.filter((id) => id !== target);
				hop++;
			}
		}

		yield { type: 'exhausted', hop };
	}

	setMetadata(metadata: Record<string, any>): void {
		this.metadata = metadata;
	}

	getMetadata(peerId: string): Record<string, any> | undefined {
		const entry = this.store.getById(peerId);
		return entry?.metadata;
	}

	listPeers(): Array<{ id: string; metadata?: Record<string, any> }> {
		return this.store.list().map(entry => ({
			id: entry.id,
			metadata: entry.metadata
		}));
	}

	exportTable(): SerializedTable {
		return {
			v: 1,
			peerId: this.node.peerId.toString(),
			timestamp: Date.now(),
			entries: this.store.exportEntries(),
		};
	}

	importTable(table: SerializedTable): number {
		const count = this.store.importEntries(table.entries);
		this.enforceCapacity();
		return count;
	}
}
