import type { Libp2p } from 'libp2p';
import type { PrivateKey } from '@libp2p/interface';
import type { SerializedAddressRecord, SerializedPeerEntry, SerializedTable } from './store/digitree-store.js';
import { FretService as FretServiceClass } from './service/fret-service.js';

export type FretMode = 'active' | 'passive';

export interface FretConfig {
	k: number;
	m: number;
	capacity: number;
	profile: 'edge' | 'core';
	bootstraps?: string[];
	networkName?: string;
	/**
	 * Consecutive failed contact attempts before a peer is marked `dead` (default 3).
	 *
	 * A "failed contact" is failure to reach the peer at all — not a peer that answered and
	 * refused, which is membership evidence instead. Failures closer together than the service's
	 * spacing window count once, so the run is genuinely spread over time.
	 */
	deadAfterFailures?: number;
	/**
	 * This node's libp2p private key — the key `node.peerId` was derived from.
	 *
	 * Used to seal this node's own signed address record (a libp2p `PeerRecord` envelope) for the
	 * `hints` field of its outgoing neighbour snapshots, so peers that only ever hear of this node
	 * through FRET can still dial it. libp2p hands the key to services as the `privateKey`
	 * component, so `Libp2pFretService` fills this in automatically; a caller constructing the core
	 * service directly passes it here. The constructor throws if the key does not derive
	 * `node.peerId`. Absent → this node advertises no record for itself (logged once at `start()`);
	 * forwarding other peers' records and consuming received ones are unaffected.
	 */
	privateKey?: PrivateKey;
}

/**
 * One signed address record riding on a neighbour snapshot: `record` is the base64url encoding
 * of a marshaled libp2p `RecordEnvelope` over a `PeerRecord` whose signer and payload peer id are
 * both `id`. The receiver verifies all of that before the record touches its peerStore — see
 * `FretService.ingestAddressHints`.
 */
export interface AddressHintV1 {
	id: string;
	record: string;
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
	metadata?: Record<string, unknown>;
	/**
	 * Signed address records for peers this snapshot names (`from`, the id lists, the sample).
	 * Optional and unversioned: a reader that predates it ignores the field. An array rather than
	 * an id-keyed object so it truncates like the other lists and has no `__proto__`-key hazard.
	 */
	hints?: AddressHintV1[];
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
	setMetadata(metadata: Record<string, unknown>): void;
	getMetadata(peerId: string): Record<string, unknown> | undefined;
	listPeers(): Array<{ id: string; metadata?: Record<string, unknown> }>;

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
	importTable(table: SerializedTable): Promise<number>;
}

export type { SerializedAddressRecord, SerializedPeerEntry, SerializedTable };
export { FretServiceClass as FretServiceImpl };
export { FretPeerDiscovery, type DiscoverySnapshotSource, type FretPeerDiscoveryInput, type FretPeerDiscoveryConfig } from './service/peer-discovery.js';
export { Libp2pFretService, fretService } from './service/libp2p-fret-service.js';
export { hashKey, hashPeerId } from './ring/hash.js';
export type { RingCoord } from './ring/hash.js';
export { clockwiseDistance, minDistance, lexLess } from './ring/distance.js';
export { DigitreeStore } from './store/digitree-store.js';
export type { PeerEntry, PeerAddressRecord, PeerPatch, PeerState, MembershipState, RingCursor, RingWalkPage } from './store/digitree-store.js';
export { estimateSizeAndConfidence } from './estimate/size-estimator.js';
export type { SizeEstimate, SizeEstimateOptions } from './estimate/size-estimator.js';
export { assembleCohort } from './service/cohort.js';
export { shouldIncludePayload, computeNearRadius } from './service/payload-heuristic.js';
export { DedupCache, DEDUP_TTL_MS } from './service/dedup-cache.js';
// `openRpcStream` and `releaseRpcStream` are one seam: an opened stream must be released, and the
// release rule (abort once the caller's signal has fired, close otherwise) is the half a consumer
// gets wrong — a bare `close()` is unbounded against a stalled remote. Exporting only the opener
// invites a hand-rolled releaser, which is the class of bug this export exists to retire.
// `sendFramed` and `readFramed` ship together for the same reason: a consumer given only the
// reader hand-rolls the writer, and the framing has to match.
export { validateTimestamp, sendFramed, readFramed, openRpcStream, releaseRpcStream } from './rpc/protocols.js';
// `rpcRequest` is the one owner of the open/write/read/close sequence those four primitives
// compose, so a consumer sending a request never re-derives the order or the release rule. It
// never throws for a network outcome — an unreachable peer, a foreign protocol, a truncated
// reply, a busy answer and a timeout are all variants of the `RpcOutcome` it returns, and only a
// caller bug (a malformed peer id, an unsatisfiable dial policy) throws. Callers that read the
// outcome therefore branch on evidence about the peer rather than on error identity.
export { rpcRequest } from './rpc/request.js';
export type { RpcRequestOptions } from './rpc/request.js';
export type { RpcOutcome } from './rpc/outcome.js';
export type { Stream } from '@libp2p/interface';
// The receive-side mirror of `rpcRequest`: a consumer wrapping its own protocol over the same
// libp2p node has exactly the drop-vs-abort and stream-release problem these two solve, and the
// hand-rolled copy is what leaks streams (a handler that throws mid-message leaves the inbound
// stream open forever, and streams are counted per protocol per connection). `registerRpcHandler`
// owns the budgeted success close and the synchronous error `abort()`; `registerJsonHandler`
// stacks the framed-JSON decode + parse on top of it. Their option interfaces ship with them —
// without those a consumer cannot name what it is passing.
export { registerRpcHandler, registerJsonHandler } from './rpc/protocols.js';
export type { JsonRequestHandlerOpts, JsonReplyOnlyHandlerOpts } from './rpc/protocols.js';
// The wire-shape parsers are exported for the same reason `registerRpcHandler` / `rpcRequest` /
// `openRpcStream` are: a consumer registering its own handler over this node otherwise re-derives
// the shape rules by hand, and a hand-rolled copy is what drifts. They are pure functions with no
// service state behind them. The primitives they are spelled with (peer-id parsing, bounded string
// arrays) stay module-scoped — implementation detail, not surface.
export {
	parseRouteAndMaybeAct,
	parseLeaveNotice,
	makeSnapshotParser,
	parsePingResponse,
	parseNearAnchor,
	parseMaybeActReply,
	sanitizeReplacements,
	// The adapter that wires a `Parser` into `rpcRequest`'s `decode`. It ships with the parsers
	// because passing one in raw is a silent bug rather than a compile error: `rpcRequest` has no
	// `undefined` check, so a returned rejection becomes `{ kind: 'ok', value: undefined }` and
	// `T` infers as `Reply | undefined`. Its error type is exported alongside so a consumer can
	// recognise the rejection by identity, not by message text.
	parseOrThrow,
	ReplyRejectedError,
	isReplyRejectedError,
} from './rpc/validate.js';
export type { Parser, SnapshotCaps } from './rpc/validate.js';


export function createFret(node: Libp2p, cfg?: Partial<FretConfig>): FretService {
	return new FretServiceClass(node, cfg);
}
