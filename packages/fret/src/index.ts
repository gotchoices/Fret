import type { SerializedPeerEntry, SerializedTable } from './store/digitree-store.js';

export type FretMode = 'active' | 'passive';

export interface FretConfig {
	k: number;
	m: number;
	capacity: number;
	profile: 'edge' | 'core';
	bootstraps?: string[];
	networkName?: string;
}

export interface NeighborSnapshotV1 {
	v: 1;
	from: string;
	timestamp: number;
	successors: string[];
	predecessors: string[];
	sample?: Array<{ id: string; coord: string; relevance: number }>;
	size_estimate?: number;
	confidence?: number;
	sig: string;
	metadata?: Record<string, any>;
}

export interface RouteAndMaybeActV1 {
	v: 1;
	key: string;
	want_k: number;
	wants?: number;
	ttl: number;
	min_sigs: number;
	digest?: string;
	activity?: string;
	breadcrumbs?: string[];
	correlation_id: string;
	timestamp: number;
	signature: string;
}

export interface NearAnchorV1 {
	v: 1;
	anchors: string[];
	cohort_hint: string[];
	estimated_cluster_size: number;
	confidence: number;
}

export interface BusyResponseV1 {
	v: 1;
	busy: true;
	retry_after_ms: number;
}

export interface ReportEvent {
	peerId: string;
	type: 'good' | 'bad';
	reason?: string;
}

/** Callback for performing an activity (pend/commit) when in-cluster. */
export type ActivityHandler = (
	activity: string,
	cohort: string[],
	minSigs: number,
	correlationId: string
) => Promise<{ commitCertificate: string }>;

/** Progressive result events emitted by iterative lookup. */
export interface RouteProgress {
	type: 'probing' | 'forwarding' | 'near_anchor' | 'activity_sent' | 'complete' | 'exhausted';
	hop?: number;
	peerId?: string;
	nearAnchor?: NearAnchorV1;
	result?: { commitCertificate: string };
	ttlRemaining?: number;
}

/** Options for initiating an iterative lookup. */
export interface LookupOptions {
	wantK: number;
	minSigs: number;
	activity?: string;
	digest?: string;
	ttl?: number;
	maxAttempts?: number;
}

export interface FretService {
	start(): Promise<void>;
	stop(): Promise<void>;
	setMode(mode: FretMode): void;
	ready(): Promise<void>;
	neighborDistance(selfId: string, key: Uint8Array, k: number): number;
	getNeighbors(key: Uint8Array, direction: 'left' | 'right' | 'both', wants: number): string[];
	assembleCohort(key: Uint8Array, wants: number, exclude?: Set<string>): string[];
	expandCohort(current: string[], key: Uint8Array, step: number, exclude?: Set<string>): string[];
	routeAct(msg: RouteAndMaybeActV1): Promise<NearAnchorV1 | { commitCertificate: string }>;
	report(evt: ReportEvent): void;
	setMetadata(metadata: Record<string, any>): void;
	getMetadata(peerId: string): Record<string, any> | undefined;
	listPeers(): Array<{ id: string; metadata?: Record<string, any> }>;

	// Network size estimation
	reportNetworkSize(estimate: number, confidence: number, source?: string): void;
	getNetworkSizeEstimate(): { size_estimate: number; confidence: number; sources: number };
	getNetworkChurn(): number;
	detectPartition(): boolean;

	// Activity handler for in-cluster actions
	setActivityHandler(handler: ActivityHandler): void;

	// Iterative lookup (client-side driver)
	iterativeLookup(key: Uint8Array, options: LookupOptions): AsyncGenerator<RouteProgress>;

	// Routing table persistence
	exportTable(): SerializedTable;
	importTable(table: SerializedTable): number;
}

export type { SerializedPeerEntry, SerializedTable };
export { FretService as FretServiceImpl } from './service/fret-service.js';
import { FretService as FretServiceClass } from './service/fret-service.js';
export { seedDiscovery } from './service/discovery.js';
export { Libp2pFretService, fretService } from './service/libp2p-fret-service.js';
export { hashKey, hashPeerId } from './ring/hash.js';
export { shouldIncludePayload, computeNearRadius } from './service/payload-heuristic.js';
export { DedupCache } from './service/dedup-cache.js';
export { validateTimestamp, readAllBounded } from './rpc/protocols.js';

export function createFret(node: any, cfg?: Partial<FretConfig>): FretService {
	return new FretServiceClass(node, cfg) as FretService;
}
