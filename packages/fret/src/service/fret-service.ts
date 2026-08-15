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
import { makeProtocols, validateTimestamp, isUnsupportedProtocolError } from '../rpc/protocols.js';
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
import { assembleCohort as assembleCohortOverStore } from './cohort.js';
import {
    createSparsityModel,
    normalizedLogDistance,
    sparsityBonus,
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

/**
 * Ring views are scoped to this network: a peer participates in the ring (neighbor set,
 * cohort, size estimate, sample, discovery) only once confirmed to serve this network's
 * FRET protocol. Self is seeded `member`, so it always passes. `unknown` peers are excluded
 * until the classification probe pass (see `classifyUnknownPeers`) resolves them — typically
 * within ~1 tick — so they are not permanently starved.
 */
const isMember = (e: PeerEntry): boolean => e.membership === 'member';

/**
 * What produced a membership observation, ordered by how much it actually proves.
 *
 * | signal              | strength | what it proves                                         | may set  |
 * |---------------------|----------|--------------------------------------------------------|----------|
 * | `rpc-success`       | strong   | the remote served this network's protocol just now      | member   |
 * | `rpc-inbound`       | strong   | the remote dialed this network's protocol just now      | member   |
 * | `identify-member`   | strong   | the remote advertised our protocol as of capture time   | member   |
 * | `identify-foreign`  | weak     | it advertised none of ours *at capture time* — which    | foreign, |
 * |                     |          | may predate our own handler registration                | from unknown only |
 * | `negotiate-failure` | weak     | it had no answerable handler *at that instant*          | foreign at threshold only |
 *
 * A weaker or staler signal never overrides a stronger, more recent one; the ordering is
 * enforced in one place, `FretService.applyMembershipSignal`.
 */
type MembershipSignal =
	| 'rpc-success'
	| 'rpc-inbound'
	| 'identify-member'
	| 'identify-foreign'
	| 'negotiate-failure';

/**
 * Select sample entries spread across diverse ring positions using sparsity-biased scoring.
 * Excludes self and entries already in successors/predecessors (they're redundant).
 *
 * `filter` scopes the candidate set (FretService passes the member predicate so an outgoing
 * snapshot never advertises a foreign peer to same-network neighbors). Defaults to no filter,
 * leaving the exported standalone unchanged.
 */
export function selectDiverseSample(
	store: DigitreeStore,
	selfCoord: Uint8Array,
	sparsity: SparsityModel,
	excludeIds: Set<string>,
	cap: number,
	filter?: (e: PeerEntry) => boolean,
): Array<{ id: string; coord: string; relevance: number }> {
	// NOTE: scans + scores + sorts the entire store (bounded by capacity C, default 2048) on every
	// snapshot build. Fine at current scale; if C grows or snapshots become hot, switch to a
	// bounded top-k heap (partial selection, no full sort) keyed on sparsity bonus.
	const entries = store.list();
	const candidates: Array<{ entry: PeerEntry; bonus: number }> = [];
	for (const entry of entries) {
		if (excludeIds.has(entry.id)) continue;
		if (filter && !filter(entry)) continue;
		const x = normalizedLogDistance(selfCoord, entry.coord);
		const bonus = sparsityBonus(sparsity, x);
		candidates.push({ entry, bonus });
	}
	candidates.sort((a, b) => b.bonus - a.bonus);
	return candidates.slice(0, cap).map(({ entry }) => ({
		id: entry.id,
		coord: coordToBase64url(entry.coord),
		relevance: entry.relevance,
	}));
}

export class FretService implements IFretService, Startable {
	private mode: FretMode = 'passive';
	private readonly store = new DigitreeStore();
	private readonly cfg: FretConfig;
	private readonly node: Libp2p;
	private stopped = false;
	private started = false;
	/**
	 * Run generation: bumped by both start() and stop(). Each background loop captures the
	 * generation it was armed for and exits when it no longer matches, so a timer left pending
	 * by a stop() cannot be resurrected by the next start() (which would leave two live loops).
	 */
	private runGen = 0;
	private stabilizeTimer: ReturnType<typeof setTimeout> | null = null;
	private preconnectTimer: ReturnType<typeof setTimeout> | null = null;
	/** runGen the active-preconnect loop is armed for; -1 when no loop is armed. */
	private preconnectGen = -1;
	private readonly nodeListeners: Array<{ type: string; handler: (evt: any) => void }> = [];
	private inflightAct = 0;
	private readonly bucketNeighbors: TokenBucket;
	private readonly bucketMaybeAct: TokenBucket;
	private readonly bucketDiscovery: TokenBucket;
	private readonly announcedIds = new Map<string, number>();
	private postBootstrapAnnounced = false;
	private readonly sparsity: SparsityModel = createSparsityModel();
	private cachedSelfCoord: Uint8Array | null = null;
	private readonly protocols: ReturnType<typeof import('../rpc/protocols.js').makeProtocols>;
	private metadata?: Record<string, any>;
	private activityHandler?: ActivityHandler;
	private readonly dedupCache = new DedupCache<NearAnchorV1 | { commitCertificate: string }>();
	private readonly backoffMap = new Map<string, { until: number; factor: number }>();
	private readonly bucketPing: TokenBucket;
	private readonly bucketLeave: TokenBucket;
	private readonly bucketAnnounce: TokenBucket;
	private readonly bucketAnnounceInbound: TokenBucket;
	private readonly announceFanout: number;
	private readonly departureDebounce = new Map<string, number>();
	private static readonly DEPARTURE_DEBOUNCE_MS = 2000;
	/**
	 * Peer ids libp2p currently holds at least one multiaddr for — the backing set for
	 * {@link hasAddresses}.
	 *
	 * The authoritative source is `node.peerStore`, but its `get` is async while every
	 * caller of `hasAddresses` is a synchronous `.filter()` predicate. So the answer is
	 * cached here: rebuilt wholesale from the `peerStore.all()` walk `seedFromPeerStore`
	 * already performs each stabilization tick (bounded by peerStore size, and self-pruning
	 * because it is a replacement rather than a merge), and refreshed per-peer on identify
	 * so a freshly-learned address is usable before the next tick. Not `readonly`: the
	 * rebuild swaps the whole set.
	 */
	private addressKnown = new Set<string>();
	/**
	 * Consecutive failed protocol negotiations before a peer is demoted to `foreign`.
	 *
	 * Delaying the `unknown → foreign` demotion costs nothing in correctness — `unknown` is
	 * already excluded from every ring view — so the whole price is ~2 extra pings per
	 * genuinely-foreign peer, once, spread over the existing backoff schedule (1 s + 2 s + 4 s).
	 * Where identify is available a genuinely foreign peer is still labelled on first sight from
	 * its protocol list, so the common case is unchanged.
	 */
	private static readonly NEGOTIATE_FAILURE_THRESHOLD = 3;
	/**
	 * Minimum spacing between two failures that both count toward the run above.
	 *
	 * Failures that arrive closer together than this are the *same* observation seen by
	 * concurrent callers, not independent evidence. Comfortably below the shortest interval
	 * at which the probe passes can legitimately re-observe a peer (the 1 s first backoff
	 * window), so genuine sequential failures are never swallowed and the ~7 s time-to-label
	 * for a genuinely foreign peer is unchanged.
	 */
	private static readonly NEGOTIATE_FAILURE_MIN_SPACING_MS = 500;
	private firstStabilizeDone = false;
	private readonly diag = {
		peersDiscovered: 0,
		snapshotsFetched: 0,
		announcementsSent: 0,
		announcementsSkipped: 0,
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
			identityMismatch: 0,
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
		this.bucketAnnounce = new TokenBucket(
			this.cfg.profile === 'core' ? 16 : 6,
			this.cfg.profile === 'core' ? 8 : 2
		);
		// Inbound-announce gate: guards *processing* of received announces (bucketAnnounce
		// guards our *outbound* sends). Profile-tuned Edge < Core; checked before any merge.
		// NOTE: capacity/refill are first-cut. On a large Core ring, churn can trigger many
		// legit announces from distinct neighbors at once; if diag.rejected.rateLimited climbs
		// in normal operation, raise these before assuming an attack.
		this.bucketAnnounceInbound = new TokenBucket(
			this.cfg.profile === 'core' ? 20 : 6,
			this.cfg.profile === 'core' ? 10 : 2
		);
		this.announceFanout = this.cfg.profile === 'core' ? 8 : 4;
	}

	public getDiagnostics(): Readonly<typeof this.diag> {
		return this.diag;
	}

	public getStore(): DigitreeStore {
		return this.store;
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
		// Protect only *member* neighbors around self (member-scoped walk). A foreign peer
		// can no longer squat in a protected slot, so with relevance ~0 it becomes a
		// preferred eviction victim — exactly what we want.
		const protectedIds = this.store.protectedIdsAround(self, Math.max(2, this.cfg.m), isMember);
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
			avgLatencyMs: next.avgLatencyMs,
		});
		// Every applySuccess call in this service follows a completed RPC over this
		// network's namespaced protocol (ping or maybeAct), which proves the peer
		// serves this network → confirm membership for free off normal traffic.
		this.applyMembershipSignal(id, 'rpc-success');
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

	/**
	 * Apply one membership observation about `id`, honouring the evidence-strength ordering.
	 *
	 * Every classification in this service routes through here so the ordering is stated once
	 * and a call site added later inherits it instead of re-deriving it. The rule, in one line:
	 * **`member` is only ever set by positive proof, and only ever cleared by repeated direct
	 * proof of absence.** Concretely — promotions always apply (and reset the negotiate-failure
	 * run); an identify list that merely *lacks* our protocol is weak, possibly-stale evidence
	 * and may demote only a peer we have never confirmed; and a single failed protocol
	 * negotiation is evidence, not a verdict, so it demotes only once a run of them accumulates.
	 *
	 * Foreign is never permanent: a later successful namespaced RPC (in either direction) or a
	 * re-identify promotes back to member. We tag and retain rather than evict — an evicted
	 * foreign peer is just re-added by the next peer:connect / peerStore seed and re-probed in
	 * a loop.
	 */
	private applyMembershipSignal(id: string, signal: MembershipSignal): void {
		const e = this.store.getById(id);
		if (!e) return;
		switch (signal) {
			case 'rpc-success':
			case 'rpc-inbound':
			case 'identify-member': {
				// Positive proof outranks whatever label the peer currently carries.
				if (e.membership === 'member' && e.negotiateFailures === 0) return; // already settled
				this.store.update(id, { membership: 'member', negotiateFailures: 0 });
				return;
			}
			case 'identify-foreign': {
				// The protocol list is only what the remote advertised *at capture time*; it can
				// predate our own handler registration, so it must not overturn a confirmed member.
				if (e.membership === 'unknown') this.store.setMembership(id, 'foreign');
				return;
			}
			case 'negotiate-failure': {
				// A *run* means observations separated in time. Concurrent RPCs to one peer all
				// fail in the same instant — several inbound maybeActs forwarding to the same
				// restarting hop, say — and that is one observation, not three. Counting each
				// would let a burst reach the threshold immediately and demote a confirmed member
				// on a single blip, which is the whole failure this guard exists to prevent.
				const now = Date.now();
				if (now - e.lastNegotiateFailureAt < FretService.NEGOTIATE_FAILURE_MIN_SPACING_MS) return;
				// Clamped at the threshold so the counter stays bounded for a peer we keep
				// re-probing; a peer already at the threshold simply stays foreign.
				const failures = Math.min(e.negotiateFailures + 1, FretService.NEGOTIATE_FAILURE_THRESHOLD);
				const patch: Partial<PeerEntry> = { negotiateFailures: failures, lastNegotiateFailureAt: now };
				if (failures >= FretService.NEGOTIATE_FAILURE_THRESHOLD && e.membership !== 'foreign') {
					patch.membership = 'foreign';
				}
				this.store.update(id, patch);
				return;
			}
		}
	}

	/**
	 * Record that `id` dialed one of *our* namespaced protocols — the strongest membership
	 * proof available, since only this network's peers speak them and the sender identity is
	 * transport-authenticated. Upserts first so a peer we have never seen is promoted rather
	 * than dropped, which is what re-admits a NAT'd peer we struggle to dial but that reaches us.
	 *
	 * NOTE: this is the one admission path driven by the *remote* rather than by proof we
	 * gathered ourselves — anyone who knows the network name can dial our ping protocol and
	 * self-admit as `member` (only as themselves; the id is transport-authenticated). Harmless
	 * under the current trust model, where speaking the namespaced protocol *is* membership,
	 * and self-limiting: such a peer answers nothing, so outbound probes demote it again. If
	 * admission control (see the security section of docs/fret.md) ever lands, this site must
	 * consult it rather than promoting unconditionally.
	 */
	private async noteInboundRpc(id: string): Promise<void> {
		if (this.stopped) return;
		try {
			if (!this.store.getById(id)) this.store.upsert(id, await hashPeerId(peerIdFromString(id)));
			this.applyMembershipSignal(id, 'rpc-inbound');
		} catch (err) {
			log.error('noteInboundRpc failed for %s - %e', id, err);
		}
	}

	/**
	 * Classify `id` from a libp2p-reported protocol list (available once identify has
	 * run). Member if any of our namespaced protocols appears; foreign if the list is
	 * non-empty but contains none of them; left unknown if empty (identify pending).
	 * The demotion arm is deliberately weak — see `applyMembershipSignal`.
	 */
	private classifyByProtocols(id: string, protocols: string[] | undefined): void {
		if (!protocols || protocols.length === 0) return; // identify not complete → stay unknown
		const mine = Object.values(this.protocols);
		const signal = protocols.some((p) => mine.includes(p)) ? 'identify-member' : 'identify-foreign';
		this.applyMembershipSignal(id, signal);
	}

	async start(): Promise<void> {
		// Re-entrancy guard: a second start() would double every node listener and
		// re-register every protocol (which the registrar rejects as a duplicate).
		if (this.started) return;
		this.started = true;
		this.runGen++;
		this.stopped = false;
		// Run-scoped flags: a restarted service must announce again, not inherit the
		// "already announced" state of the previous run.
		this.postBootstrapAnnounced = false;
		this.firstStabilizeDone = false;
		await this.seedFromPeerStore();
		await this.registerRpcHandlers();
		// Defer proactive announce to after first stabilization tick (table is richer)
		this.startStabilizationLoop();
		if (this.mode === 'active') {
			this.detach(this.preconnectNeighbors(), 'preconnectNeighbors');
			// stop() disarms the loop, so a restart while still in active mode must re-arm it;
			// otherwise setMode('active') would have to be called again to get warm-up back.
			this.startActivePreconnectLoop();
		}
		// One-time post-bootstrap announce when first remote connects
		this.addNodeListener('peer:connect', async () => {
			if (this.stopped || this.postBootstrapAnnounced) return;
			this.postBootstrapAnnounced = true;
			try { await this.announceNeighborsBounded(8); } catch (err) { log.error('postBootstrap announce failed - %e', err) }
		});
		this.addNodeListener('peer:connect', async (evt: any) => {
			try {
				if (this.stopped) return;
				// libp2p v3: evt.detail is the PeerId directly, not { id: PeerId }
				const id = evt?.detail?.toString?.();
				if (!id) return;
				const coord = this.store.getById(id)?.coord ?? (await hashPeerId(peerIdFromString(id)));
				this.store.upsert(id, coord);
				this.store.setState(id, 'connected');
				await this.applyTouch(id, coord);
			} catch (err) { log.error('peer:connect handler failed - %e', err) }
		});
		this.addNodeListener('peer:disconnect', async (evt: any) => {
			try {
				if (this.stopped) return;
				// libp2p v3: evt.detail is the PeerId directly, not { id: PeerId }
				const id = evt?.detail?.toString?.();
				if (!id) return;
				const coord = this.store.getById(id)?.coord ?? (await hashPeerId(peerIdFromString(id)));
				const wasNear = this.isNearNeighbor(id, coord);
				this.store.setState(id, 'disconnected');
				await this.applyFailure(id, coord);
				// Proactive: announce to neighbors around departed peer if it was a near neighbor
				if (wasNear && !this.stopped) {
					this.detach(this.announceOnDeparture(id, coord), 'announceOnDeparture');
				}
			} catch (err) { log.error('peer:disconnect handler failed - %e', err) }
		});
		// identify-driven membership: once libp2p learns a peer's negotiated protocols
		// it can classify without an outbound probe. peer:update also delivers
		// re-admission — a peer that later starts serving this network re-identifies
		// and is re-evaluated foreign → member. (No-op on transports without identify,
		// e.g. the in-memory test nodes; those rely on the probe pass.)
		this.addNodeListener('peer:identify', async (evt: any) => {
			try {
				if (this.stopped) return;
				const pid: PeerId | undefined = evt?.detail?.peerId;
				const id = pid?.toString?.();
				if (!id) return;
				// Ensure an entry exists to label, but don't reset an existing one.
				if (!this.store.getById(id)) this.store.upsert(id, await hashPeerId(pid!));
				this.classifyByProtocols(id, evt?.detail?.protocols);
				// identify is where a peer's addresses usually arrive; pick them up now rather
				// than at the next stabilization tick, so the peer is dialable immediately.
				await this.refreshAddressKnown(id);
			} catch (err) { log.error('peer:identify handler failed - %e', err) }
		});
		this.addNodeListener('peer:update', async (evt: any) => {
			try {
				if (this.stopped) return;
				const peer = evt?.detail?.peer;
				const pid: PeerId | undefined = peer?.id;
				const id = pid?.toString?.();
				if (!id) return;
				if (!this.store.getById(id)) this.store.upsert(id, await hashPeerId(pid!));
				this.classifyByProtocols(id, peer?.protocols);
				// The event carries the updated Peer record, so its addresses are authoritative
				// here — no peerStore round-trip needed.
				this.setAddressKnown(id, (peer?.addresses?.length ?? 0) > 0);
			} catch (err) { log.error('peer:update handler failed - %e', err) }
		});
	}

	async stop(): Promise<void> {
		// Idempotent, mirroring start(): a second stop() — or one on a service that was
		// never started — must not re-run the leave fan-out to peers we already said
		// goodbye to. (Specs routinely stop a service and then stop it again in afterEach.)
		if (!this.started) return;
		// Mark stopped first so in-flight event handlers and announce loops quiesce
		// before we tear down: opening a stream on a connection that is concurrently
		// closing triggers an uncaught StreamStateError from yamux's window-update
		// microtask, which we cannot catch.
		this.started = false;
		this.runGen++;
		this.stopped = true;
		this.clearLoopTimers();
		this.removeNodeListeners();
		// Unhandle before the leave notices: unhandle only removes *inbound* handlers,
		// while the leave notices go out over our own outbound streams.
		await this.unregisterRpcHandlers();
		try { await this.sendLeaveToNeighbors(); } catch (err) { console.warn('sendLeaveToNeighbors failed', err); }
	}

	/** Cancel any pending loop timers. Ticks already in flight exit on the generation check. */
	private clearLoopTimers(): void {
		if (this.stabilizeTimer != null) { clearTimeout(this.stabilizeTimer); this.stabilizeTimer = null; }
		if (this.preconnectTimer != null) { clearTimeout(this.preconnectTimer); this.preconnectTimer = null; }
		this.preconnectGen = -1;
	}

	/** Attach a logging catch to an intentionally-detached promise so a rejection can never escape. */
	private detach(promise: Promise<unknown>, label: string): void {
		void promise.catch((err) => log.error('%s failed - %e', label, err));
	}

	/** Register a node event listener and track it so stop() can detach it. */
	private addNodeListener(type: string, handler: (evt: any) => void): void {
		this.nodeListeners.push({ type, handler });
		this.node.addEventListener(type as any, handler);
	}

	/** Detach all node event listeners registered via addNodeListener. */
	private removeNodeListeners(): void {
		for (const { type, handler } of this.nodeListeners) {
			this.node.removeEventListener(type as any, handler);
		}
		this.nodeListeners.length = 0;
	}

	setMode(mode: FretMode): void {
		this.mode = mode;
		if (mode === 'active') this.startActivePreconnectLoop();
	}

	async ready(): Promise<void> {}

	private maxBytesNeighbors(): number { return this.cfg.profile === 'core' ? 128 * 1024 : 64 * 1024; }
	private maxBytesMaybeAct(): number { return this.cfg.profile === 'core' ? 512 * 1024 : 256 * 1024; }

	// RPC registration
	private async registerRpcHandlers(): Promise<void> {
		try {
			await Promise.all([
				registerNeighbors(
					this.node,
					async () => this.handleNeighborsRequest(),
					(from, snap) => this.handleAnnounce(from, snap),
					this.protocols,
					this.maxBytesNeighbors(),
					() => { this.diag.rejected.identityMismatch++; },
					(from) => this.detach(this.noteInboundRpc(from), 'noteInboundRpc(neighbors)')
				),
				registerMaybeAct(
					this.node,
					async (msg, from) => {
						this.detach(this.noteInboundRpc(from), 'noteInboundRpc(maybeAct)');
						return await this.handleMaybeAct(msg);
					},
					this.protocols.PROTOCOL_MAYBE_ACT,
					this.maxBytesMaybeAct()
				),
				registerLeave(
					this.node,
					async (notice) => this.handleLeave(notice),
					this.protocols.PROTOCOL_LEAVE,
					() => { this.diag.rejected.identityMismatch++; }
				),
				registerPing(
					this.node,
					this.protocols.PROTOCOL_PING,
					() => this.handlePingRequest(),
					(from) => this.detach(this.noteInboundRpc(from), 'noteInboundRpc(ping)')
				),
			]);
		} catch (err) {
			// A failed registration leaves the service degraded but running; it must not
			// escape as an unhandled rejection (which is process-fatal under Node's default).
			// NOTE: log-and-continue means a registrar failure yields a service that looks
			// started but answers nothing, with no signal to the caller. Acceptable while the
			// only realistic failure is duplicate registration (start() already guards that);
			// revisit if a registrar failure is ever observed in practice, at which point
			// start() should surface a degraded state rather than a silent one.
			log.error('registerRpcHandlers failed - %e', err);
		}
	}

	/** Mirror of registerRpcHandlers so a stopped service stops serving this network's protocols. */
	private async unregisterRpcHandlers(): Promise<void> {
		try {
			await this.node.unhandle(Object.values(this.protocols));
		} catch (err) {
			// The node itself may already be stopping; a failed unhandle is not fatal to shutdown.
			// NOTE: a failure for any *other* reason leaves a stopped service still answering.
			// Not distinguished today because libp2p's registrar unhandle is a map delete that
			// does not throw; revisit if a libp2p version makes it fallible.
			log.error('unregisterRpcHandlers failed - %e', err);
		}
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

	/**
	 * True when libp2p holds at least one multiaddr for `id`, i.e. a dial can plausibly
	 * succeed even though no connection is open.
	 *
	 * FRET's own wire messages carry peer-id strings only and contribute no addresses, so
	 * this is entirely about what libp2p itself learned (identify over a direct connection,
	 * a bootstrap entry, a transport's own discovery). Answered from {@link addressKnown};
	 * see that field for why the peerStore is not read directly here.
	 */
	private hasAddresses(id: string): boolean {
		return this.addressKnown.has(id);
	}

	/**
	 * True when an outbound RPC to `id` can plausibly be delivered: `openRpcStream` reuses an
	 * open connection if there is one, and otherwise dials the *bare peer id* — which only
	 * resolves if libp2p holds an address for it. A peer that is neither is undialable, and
	 * every FRET RPC to it fails with `NoValidAddressesError`.
	 *
	 * The address-set lookup comes first because it is a `Set.has` while `isConnected` parses
	 * the id and walks the connection list; a connected peer almost always has an address, so
	 * the cheap arm short-circuits nearly every call. This predicate runs once per entry
	 * inside the routing ring walk (see {@link dialableCohort}), so the order matters.
	 *
	 * NOTE: "no address" implies "undialable" only while the node has no peer-routing module.
	 * libp2p's dialer falls back to `peerRouting.findPeer` for a bare-id dial with no known
	 * addresses, so a deployment that configures delegated routing (or keeps a DHT alongside
	 * FRET) would find this guard over-restrictive on the routing paths. FRET exists to
	 * replace that lookup, so today there is nothing to fall back to; revisit if FRET is ever
	 * run beside a peer-routing implementation.
	 */
	private isDialable(id: string): boolean {
		return this.hasAddresses(id) || this.isConnected(id);
	}

	/** Record whether libp2p holds an address for `id`, keeping {@link addressKnown} in sync. */
	private setAddressKnown(id: string, known: boolean): void {
		if (known) this.addressKnown.add(id);
		else this.addressKnown.delete(id);
	}

	/**
	 * Refresh one peer's address-known state from the peerStore, so an address learned via
	 * identify is usable immediately rather than at the next stabilization tick.
	 *
	 * "Not in the peerStore" is the ordinary negative answer, not a fault; any *other* failure
	 * is logged rather than swallowed.
	 */
	private async refreshAddressKnown(id: string): Promise<void> {
		try {
			const peer = await this.node.peerStore.get(peerIdFromString(id));
			this.setAddressKnown(id, (peer.addresses?.length ?? 0) > 0);
		} catch (err) {
			if ((err as { name?: string })?.name === 'NotFoundError') { this.addressKnown.delete(id); return; }
			log.error('refreshAddressKnown failed for %s - %e', id, err);
		}
	}

	private async proactiveAnnounceOnStart(): Promise<void> {
		try {
			await this.announceNeighborsBounded(8);
		} catch (err) {
			log.error('proactiveAnnounceOnStart failed - %e', err);
		}
	}

	/**
	 * Single choke point for outbound announces. Every announce target list is chosen to
	 * *prefer* non-connected peers (a connected peer learns via normal exchange), so this
	 * dials — and therefore has to be the place the dialability guard is applied. Checked
	 * before the token bucket so an undialable target does not burn an announce token.
	 *
	 * Confirmed-foreign peers are skipped for the same reason: announce target lists walk the
	 * store unfiltered (so a freshly-connected `unknown` peer is not stalled), but a peer we
	 * already proved does not serve this network can only answer the dial with
	 * `UnsupportedProtocolError`. `unknown` is still announced to — it may yet be a member.
	 */
	private async sendAnnouncementsRateLimited(ids: string[], snap: NeighborSnapshotV1): Promise<void> {
		for (const id of ids) {
			if (this.stopped) break;
			if (!this.isDialable(id)) continue;
			if (this.store.getById(id)?.membership === 'foreign') continue;
			if (!this.bucketAnnounce.tryTake()) { this.diag.announcementsSkipped++; break; }
			try {
				await announceNeighbors(this.node, id, snap, this.protocols.PROTOCOL_NEIGHBORS_ANNOUNCE, { dial: true });
				this.diag.announcementsSent++;
			} catch (err) { log.error('announce failed to %s - %e', id, err); }
		}
	}

	private async announceNeighborsBounded(maxCount?: number): Promise<void> {
		const fanout = maxCount ?? this.announceFanout;
		const selfCoord = await hashPeerId(this.node.peerId);
		const selfStr = this.node.peerId.toString();
		// Announce *targets* walk the store unfiltered (member-scoped `getNeighbors` would drop
		// a freshly-connected peer that is still `unknown`, stalling bootstrap before the probe
		// pass can classify it). Only the snapshot *contents* are member-scoped. Matches the
		// sibling maintenance walks (announceOnDeparture / sendLeaveToNeighbors / etc.).
		const all = Array.from(new Set([
			...this.store.neighborsRight(selfCoord, this.cfg.m),
			...this.store.neighborsLeft(selfCoord, this.cfg.m)
		])).filter((id) => id !== selfStr);
		// Prefer non-connected peers (connected learn via normal exchange)
		const nonConnected = all.filter((id) => !this.isConnected(id) && this.hasAddresses(id));
		const connected = all.filter((id) => this.isConnected(id));
		const ids = [...nonConnected, ...connected].slice(0, fanout);
		await this.sendAnnouncementsRateLimited(ids, await this.snapshot());
	}

	private async preconnectNeighbors(): Promise<void> {
		try {
			const selfCoord = await hashPeerId(this.node.peerId);
			const selfStr = this.node.peerId.toString();
			// Unfiltered store walk: preconnect/warm-up must reach not-yet-classified peers (a
			// ping is itself a classification signal). Ring reads use member-scoped getNeighbors.
			const ids = Array.from(new Set([
				...this.store.neighborsRight(selfCoord, Math.min(6, this.cfg.m)),
				...this.store.neighborsLeft(selfCoord, Math.min(6, this.cfg.m))
			])).filter((id) => id !== selfStr);
			for (const id of ids) {
				if (this.isDialable(id)) {
					try { await sendPing(this.node, id, this.protocols.PROTOCOL_PING); this.diag.pingsSent++; } catch (err) { log.error('preconnectNeighbors ping failed for %s - %e', id, err) }
				}
			}
		} catch (err) { log.error('preconnectNeighbors outer failed - %e', err) }
	}

	private startActivePreconnectLoop(): void {
		// Re-entered from setMode(); one loop per run generation.
		if (this.preconnectGen === this.runGen) return;
		const gen = this.runGen;
		this.preconnectGen = gen;
		/** Exit the loop, releasing the arm slot only if this tick still owns the current run. */
		const release = (): void => { if (gen === this.runGen) this.preconnectGen = -1; };
		const tick = async () => {
			if (this.stopped || gen !== this.runGen || this.mode !== 'active') { release(); return; }
			try {
				const selfCoord = await this.selfCoord();
				const selfStr = this.node.peerId.toString();
				const budget = this.cfg.profile === 'core' ? 6 : 3;
				// Unfiltered store walk (warm-up must reach unclassified peers; ring reads use getNeighbors).
				const ids = Array.from(new Set([
					...this.store.neighborsRight(selfCoord, Math.min(12, this.cfg.m)),
					...this.store.neighborsLeft(selfCoord, Math.min(12, this.cfg.m))
				])).filter((id) => id !== selfStr).slice(0, budget);
				for (const id of ids) {
					if (this.isDialable(id)) {
					try { await sendPing(this.node, id, this.protocols.PROTOCOL_PING); this.diag.pingsSent++; } catch (err) { log.error('active preconnect ping failed for %s - %e', id, err) }
				}
			}
			} catch (err) { log.error('active preconnect tick failed - %e', err) }
			// Re-check after the awaits: a stop() during the tick must not re-arm the timer.
			if (this.stopped || gen !== this.runGen) { release(); return; }
			this.preconnectTimer = setTimeout(tick, 1000);
		};
		this.detach(tick(), 'active preconnect loop');
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
			// Unfiltered store walk: leave notices go to all ring neighbors (matches handleLeave /
			// computeReplacements). Ring reads elsewhere use member-scoped getNeighbors.
			const ids = Array.from(new Set([
				...this.store.neighborsRight(selfCoord, this.cfg.m),
				...this.store.neighborsLeft(selfCoord, this.cfg.m)
			])).filter((id) => id !== selfStr).slice(0, 8);
			const spSet = new Set(ids);
			const replacements = this.computeReplacements(selfCoord, spSet, selfStr);
			const notice = { v: 1, from: this.node.peerId.toString(), replacements: replacements.length > 0 ? replacements : undefined, timestamp: Date.now() } as const;
			for (const id of ids) {
				// Undialable neighbors are skipped, not attempted: this runs inside stop(), so a
				// stack of dials that can only end in NoValidAddressesError also delays shutdown.
				// (`ids` itself stays unfiltered — it defines the S/P set the replacements exclude.)
				if (!this.isDialable(id)) continue;
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
			// Proactively warm a bounded number of replacements and merge their neighbor views.
			// Replacement ids come straight off the wire, so most are peers we hold no address
			// for; dialing those can only fail, so they are filtered out before the budget is
			// applied (filtering after would waste warm slots on undialable ids).
			const warm = newIds.filter((id) => this.isDialable(id)).slice(0, 6);
			for (const id of warm) {
				try {
					await sendPing(this.node, id, this.protocols.PROTOCOL_PING);
					// The ping usually opens the connection; announce only when it did not, and
					// through the shared choke point so the dial flag, token accounting and
					// counters stay in one place rather than being restated here.
					if (!this.isConnected(id)) {
						await this.sendAnnouncementsRateLimited([id], await this.snapshot());
					}
				} catch (err) {
					log.error('warm/announce failed for %s - %e', id, err);
				}
			}
			await this.mergeNeighborSnapshots(warm.slice(0, 4));
			// Announce replacement info to immediate neighbors
			this.detach(this.announceReplacementsToNeighbors(coord), 'announceReplacementsToNeighbors');
		} catch (err) {
			log.error('handleLeave failed for %s - %e', peerId, err);
		}
	}

	private async announceReplacementsToNeighbors(aroundCoord: Uint8Array): Promise<void> {
		const selfStr = this.node.peerId.toString();
		const neighbors = Array.from(new Set([
			...this.store.neighborsRight(aroundCoord, this.cfg.m),
			...this.store.neighborsLeft(aroundCoord, this.cfg.m),
		])).filter((id) => id !== selfStr && this.isConnected(id)).slice(0, 4);
		await this.sendAnnouncementsRateLimited(neighbors, await this.snapshot());
	}

	private async announceOnDeparture(departedId: string, coord: Uint8Array): Promise<void> {
		// Debounce: skip if we recently announced for this coordinate region
		const regionKey = coordToBase64url(coord);
		const now = Date.now();
		const lastAnnounce = this.departureDebounce.get(regionKey) ?? 0;
		if (now - lastAnnounce < FretService.DEPARTURE_DEBOUNCE_MS) return;
		this.departureDebounce.set(regionKey, now);
		// Prune stale debounce entries
		if (this.departureDebounce.size > 256) {
			for (const [k, v] of this.departureDebounce) { if (now - v > FretService.DEPARTURE_DEBOUNCE_MS * 2) this.departureDebounce.delete(k); }
		}

		const selfStr = this.node.peerId.toString();
		const all = Array.from(new Set([
			...this.store.neighborsRight(coord, this.cfg.m),
			...this.store.neighborsLeft(coord, this.cfg.m),
		])).filter((id) => id !== selfStr && id !== departedId);
		// Prefer non-connected peers; connected peers learn via normal exchange
		const nonConnected = all.filter((id) => !this.isConnected(id) && this.hasAddresses(id));
		const connected = all.filter((id) => this.isConnected(id));
		const targets = [...nonConnected, ...connected].slice(0, this.announceFanout);
		if (targets.length === 0) return;
		await this.sendAnnouncementsRateLimited(targets, await this.snapshot());
	}

	private isNearNeighbor(id: string, _coord: Uint8Array): boolean {
		const selfStr = this.node.peerId.toString();
		const selfCoord = this.cachedSelfCoord;
		if (!selfCoord) return false;
		const near = Array.from(new Set([
			...this.store.neighborsRight(selfCoord, this.cfg.m),
			...this.store.neighborsLeft(selfCoord, this.cfg.m),
		])).filter((nid) => nid !== selfStr);
		return near.includes(id);
	}

	private async announceToNewPeers(ids: string[]): Promise<void> {
		const selfStr = this.node.peerId.toString();
		const targets = ids
			.filter((id) => id !== selfStr && !this.isConnected(id) && this.hasAddresses(id))
			.slice(0, this.announceFanout);
		if (targets.length === 0) return;
		await this.sendAnnouncementsRateLimited(targets, await this.snapshot());
	}

	/**
	 * Feed a received snapshot's network-size estimate into the local estimator.
	 * No-op unless both estimate and confidence are present and positive.
	 */
	private calibrateSizeFromSnapshot(snap: NeighborSnapshotV1, sourceId: string): void {
		if (snap.size_estimate && snap.size_estimate > 0 && snap.confidence && snap.confidence > 0) {
			this.reportNetworkSize(snap.size_estimate, snap.confidence, 'snapshot:' + sourceId);
		}
	}

	/**
	 * Per-message caps for merging a received neighbor/announce snapshot — single source of
	 * truth shared by the neighbor-fetch merge (`mergeNeighborSnapshots`) and the inbound-announce
	 * merge (`mergeAnnounceSnapshot`). Bounds how many remote-supplied ids one message can force
	 * us to parse + SHA-256 hash + upsert, independent of the RPC byte limit.
	 */
	private mergeSnapshotCaps(): { successors: number; predecessors: number; sample: number } {
		return this.cfg.profile === 'core'
			? { successors: 16, predecessors: 16, sample: 8 }
			: { successors: 8, predecessors: 8, sample: 6 };
	}

	/**
	 * Inbound-announce entry point: gate on the per-profile token bucket before any merge work.
	 * A crafted announce can carry many ids (the RPC accepts up to a 128 KB message), each
	 * costing a parse + hash + upsert; without this gate one peer could force thousands of ops.
	 * On rejection we drop the message and count it — never throw, so no inflight state desyncs.
	 */
	private handleAnnounce(from: string, snap: NeighborSnapshotV1): void {
		if (!this.bucketAnnounceInbound.tryTake()) {
			this.diag.rejected.rateLimited++;
			return;
		}
		this.detach(this.mergeAnnounceSnapshot(from, snap), 'mergeAnnounceSnapshot');
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
			// `from` is transport-authenticated (the handler drops any mismatch) and it dialed
			// our namespaced announce protocol — strongest possible membership proof.
			this.applyMembershipSignal(from, 'rpc-inbound');

			if (snap.metadata) {
				// Update metadata via store.update to avoid mutating frozen entries
				this.store.update(from, { metadata: snap.metadata });
			}

			// Cap remote-supplied lists to the same per-profile bounds as the neighbor-fetch
			// merge — a single crafted announce must not force thousands of parse+hash+upserts.
			const caps = this.mergeSnapshotCaps();
			const succList = (snap.successors ?? []).slice(0, caps.successors);
			const predList = (snap.predecessors ?? []).slice(0, caps.predecessors);
			for (const pid of [...succList, ...predList]) {
				try {
					const coord = await hashPeerId(peerIdFromString(pid));
					if (!this.store.getById(pid)) discovered.push(pid);
					this.store.upsert(pid, coord);
					await this.applyTouch(pid, coord);
				} catch (err) {
					log.error('mergeAnnounceSnapshot: failed for %s - %e', pid, err);
				}
			}
			// merge bounded sample if present
			for (const s of (snap.sample ?? []).slice(0, caps.sample)) {
				try {
					const coord = u8FromString(s.coord, 'base64url');
					if (!this.store.getById(s.id)) discovered.push(s.id);
					this.store.upsert(s.id, coord);
					await this.applyTouch(s.id, coord);
				} catch (err) { log.error('mergeAnnounceSnapshot sample upsert failed for %s - %e', s.id, err) }
			}
			// Calibrate local size estimator from snapshot's estimate
			this.calibrateSizeFromSnapshot(snap, from);
			this.enforceCapacity();
			this.emitDiscovered(discovered);
			if (discovered.length > 0) this.detach(this.announceToNewPeers(discovered), 'announceToNewPeers');
		} catch (err) {
			log.error('mergeAnnounceSnapshot failed for %s - %e', from, err);
		}
	}

	// Seeding and stabilization
	private async seedFromPeerStore(): Promise<void> {
		try {
			// NOTE: runs at start() and on every stabilization tick. This re-enumerates the whole
			// peerStore and SHA-256-hashes each peer's id per tick (upsert preserves existing stats,
			// so it is correct, just not free). Fine at current capacity (C=2048); if the peerStore
			// grows large or the tick cadence tightens, gate re-seed on a peerStore change/epoch or
			// skip hashing for ids already in the store (reuse the stored coord).
			const peers = await this.node.peerStore.all();
			const discovered: string[] = [];
			// Rebuilt wholesale rather than merged, so a peer whose addresses the peerStore
			// dropped stops reading as dialable (see `addressKnown`).
			const addressKnown = new Set<string>();
			for (const p of peers) {
				try {
					const pidStr = p.id.toString();
					if (p.addresses.length > 0) addressKnown.add(pidStr);
					const coord = await hashPeerId(p.id);
					if (!this.store.getById(pidStr)) discovered.push(pidStr);
					this.store.upsert(pidStr, coord);
					// If identify has populated the peerStore, classify off its protocol
					// list now rather than waiting for an outbound probe. No `unknown`-only
					// guard here any more — that rule is now general (see
					// `applyMembershipSignal`: an identify list lacking our protocol demotes
					// only from `unknown`, wherever the list came from).
					this.classifyByProtocols(pidStr, p.protocols);
				} catch (err) {
					console.warn('failed to add peer from peerStore', p?.id?.toString?.(), err);
				}
			}
			// NOTE: wholesale replacement clobbers any `setAddressKnown` an identify handler ran
			// while this walk was awaiting its per-peer hashes, so an address learned inside that
			// window is missed until the next tick (~1.5s passive). Harmless today — a connected
			// peer is dialable via `isConnected` regardless — but if the window ever matters,
			// apply the walk's result as a diff instead of a swap.
			this.addressKnown = addressKnown;
			try {
				const coord = await hashPeerId(this.node.peerId);
				const selfStr = this.node.peerId.toString();
				if (!this.store.getById(selfStr)) discovered.push(selfStr);
				this.store.upsert(selfStr, coord);
				// Self always serves its own network.
				this.store.setMembership(selfStr, 'member');
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
		// One loop per run; start() guards re-entry, so no "already running" check is needed.
		const gen = this.runGen;
		const tick = async () => {
			if (this.stopped || gen !== this.runGen) return;
			try {
				await this.seedFromPeerStore();
				await this.seedFromBootstraps();
				await this.stabilizeOnce();
				// Proactive announce after first stabilization (table populated)
				if (!this.firstStabilizeDone) {
					this.firstStabilizeDone = true;
					this.detach(this.proactiveAnnounceOnStart(), 'proactiveAnnounceOnStart');
				}
			} catch (err) {
				console.error('stabilize tick failed:', err);
			} finally {
				// Re-check after the awaits: a stop() during the tick must not re-arm the timer.
				if (!this.stopped && gen === this.runGen) {
					const delay = this.mode === 'active' ? 300 : 1500;
					this.stabilizeTimer = setTimeout(tick, delay);
				}
			}
		};
		this.detach(tick(), 'stabilization loop');
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
		const near = nearAll.filter((id) => id !== selfStr && this.isDialable(id));
		await this.probeNeighborsLatency(near.slice(0, 4));
		// NOTE: `fetchNeighbors` is connection-only (`requireExisting`), so for an address-known
		// but non-connected peer it returns an empty snapshot while `snapshotsFetched` still
		// counts it — a diagnostics overcount, not a correctness problem, and the preceding ping
		// usually opens the connection anyway. If snapshot counts are ever used for anything
		// load-bearing, have fetchNeighbors report the skip instead of returning an empty result.
		await this.mergeNeighborSnapshots(near.slice(0, 4));
		await this.classifyUnknownPeers();
		await this.reprobeForeignPeers();
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
					// A failed negotiation is evidence, not a verdict — this path is member-gated,
					// so `id` is a *confirmed* member and the likeliest cause is a restart or a
					// handler not yet registered. Count it; only a run of them demotes. A timeout /
					// transient error is not even that, and leaves the label untouched.
					if (isUnsupportedProtocolError(err)) this.applyMembershipSignal(id, 'negotiate-failure');
					const coord = this.store.getById(id)?.coord ?? (await hashPeerId(peerIdFromString(id)));
					await this.applyFailure(id, coord);
					this.diag.pingsFail++;
				} catch {}
			}
		}
	}

	/**
	 * Bounded classification probe pass over `unknown` peers.
	 *
	 * Normal traffic only touches peers the ring already selects, but the follow-on
	 * gating work will exclude `unknown` peers from the ring — so without a dedicated
	 * pass an unknown same-network peer would never be selected, never probed, and be
	 * permanently starved. This iterates unknowns directly from the store (not through
	 * ring views), prefers connected / has-addresses ones, and sends a namespaced ping
	 * to at most N per tick. It runs only while unknowns exist; in single-network
	 * steady state every peer becomes member and this is a no-op (no extra traffic).
	 */
	private async classifyUnknownPeers(): Promise<void> {
		const selfStr = this.node.peerId.toString();
		const budget = this.cfg.profile === 'core' ? 8 : 4;
		// NOTE: scans the whole store (O(table size)) every tick to find unknowns, even
		// once steady state has none. Fine at C=2048; if capacity or tick rate grows a lot,
		// track an unknown-count or unknown-id set so a no-op tick costs O(1).
		const unknown = this.store.list().filter(
			(e) => e.id !== selfStr && e.membership === 'unknown' && this.getBackoffPenalty(e.id) === 0
		);
		if (unknown.length === 0) return;
		// Only peers we can actually reach are probeable; prefer connected over has-addresses.
		const connected = unknown.filter((e) => this.isConnected(e.id));
		const reachable = unknown.filter((e) => !this.isConnected(e.id) && this.hasAddresses(e.id));
		const targets = [...connected, ...reachable].slice(0, budget);
		for (const e of targets) {
			if (this.stopped) break;
			await this.probeMembership(e.id);
		}
	}

	/**
	 * Occasionally re-probe a few `foreign` peers so a same-network peer that was *mislabeled*
	 * foreign (e.g. identify completed before the peer registered our protocol handlers) is
	 * re-admitted via a successful namespaced ping. Before ring-membership gating this self-
	 * healed for free — `probeNeighborsLatency` pinged near ring peers regardless of label —
	 * but gating excludes foreign peers from the ring, closing that path. The `peer:update`
	 * identify path also re-admits, but it is not guaranteed (it depends on the remote pushing
	 * an identify update), so this RPC path is the backstop the gating work owes (per the
	 * `ring-membership-classification` review tripwire).
	 *
	 * Bounded and self-limiting: only a couple of off-backoff foreign peers per tick, and a
	 * confirmed-foreign probe records a growing backoff (see `probeMembership`), so a genuinely
	 * foreign peer is re-probed at most ~once per backoff window rather than every tick.
	 */
	private async reprobeForeignPeers(): Promise<void> {
		this.pruneBackoffMap();
		const selfStr = this.node.peerId.toString();
		const budget = this.cfg.profile === 'core' ? 2 : 1;
		const foreign = this.store.list().filter(
			(e) => e.id !== selfStr && e.membership === 'foreign' && this.getBackoffPenalty(e.id) === 0
		);
		if (foreign.length === 0) return;
		// Only reachable peers are probeable; prefer connected over has-addresses.
		// Within each group, probe the least-backed-off first: backoff factor is a proxy for
		// "how many times we already confirmed this peer foreign", so a freshly-demoted peer
		// (factor 0/1) — the one most likely to be mislabeled — is serviced before a
		// long-confirmed foreign one (factor 32) rather than queueing behind it.
		const byBackoffFactor = (a: PeerEntry, b: PeerEntry): number =>
			(this.backoffMap.get(a.id)?.factor ?? 0) - (this.backoffMap.get(b.id)?.factor ?? 0);
		const connected = foreign.filter((e) => this.isConnected(e.id)).sort(byBackoffFactor);
		const reachable = foreign.filter((e) => !this.isConnected(e.id) && this.hasAddresses(e.id)).sort(byBackoffFactor);
		const targets = [...connected, ...reachable].slice(0, budget);
		for (const e of targets) {
			if (this.stopped) break;
			await this.probeMembership(e.id);
		}
	}

	/**
	 * Probe a single peer's membership with a namespaced ping. Success → member;
	 * unsupported-protocol → one more strike toward the failure threshold (see
	 * `applyMembershipSignal`), demoting to foreign only once the run completes;
	 * timeout / transient → label untouched. Every failure backs off either way so we
	 * don't hammer an unreachable-but-connected peer every tick.
	 */
	private async probeMembership(id: string): Promise<void> {
		try {
			const res = await sendPing(this.node, id, this.protocols.PROTOCOL_PING);
			this.diag.pingsSent++;
			if (res.ok) {
				const coord = this.store.getById(id)?.coord ?? (await hashPeerId(peerIdFromString(id)));
				await this.applySuccess(id, coord, res.rttMs); // marks member (and clears backoff)
				this.diag.pingsOk++;
				this.clearBackoff(id);
			} else {
				// empty/busy reply — ambiguous; leave unknown and back off briefly.
				this.diag.pingsFail++;
				this.recordBackoff(id);
			}
		} catch (err) {
			this.diag.pingsFail++;
			if (isUnsupportedProtocolError(err)) {
				// Evidence of absence — foreign only once a run of these accumulates (a peer that
				// has simply not registered its handlers yet produces the identical error). Back
				// off either way so the occasional foreign re-probe (which exists to recover a
				// *mislabeled* same-network peer) does not hammer a genuinely-foreign peer that
				// keeps returning this error. The backoff grows exponentially (factor doubles
				// each window, up to 32×) so probing tapers toward ~once/32s.
				this.applyMembershipSignal(id, 'negotiate-failure');
				this.recordBackoff(id);
			} else {
				this.recordBackoff(id); // timeout / transient — retry a later tick
			}
		}
	}

	private async mergeNeighborSnapshots(ids: string[]): Promise<void> {
		const announced: string[] = [];
		for (const id of ids) {
			try {
				const snap: NeighborSnapshotV1 = await fetchNeighbors(this.node, id, this.protocols.PROTOCOL_NEIGHBORS);
				this.diag.snapshotsFetched++;
				const caps = this.mergeSnapshotCaps();
				const succList = (snap.successors ?? []).slice(0, caps.successors);
				const predList = (snap.predecessors ?? []).slice(0, caps.predecessors);
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
				for (const s of (snap.sample ?? []).slice(0, caps.sample)) {
					try {
						const coord = u8FromString(s.coord, 'base64url');
						if (!this.store.getById(s.id)) announced.push(s.id);
						this.store.upsert(s.id, coord);
						await this.applyTouch(s.id, coord);
					} catch (err) { log.error('mergeNeighborSnapshots sample upsert failed for %s - %e', s.id, err) }
				}
				// Calibrate local size estimator from snapshot's estimate
				this.calibrateSizeFromSnapshot(snap, id);
			} catch (err) {
				console.warn('fetchNeighbors failed for', id, err);
			}
		}
		this.enforceCapacity();
		this.emitDiscovered(announced);
		if (announced.length > 0) this.detach(this.announceToNewPeers(announced), 'announceToNewPeers');
	}

	// Snapshots
	private async snapshot(): Promise<NeighborSnapshotV1> {
		const selfCoord = await hashPeerId(this.node.peerId);
		// Size estimate, neighbors, and sample are all member-scoped so the snapshot we
		// advertise describes only this network — and never re-introduces a foreign peer to
		// same-network neighbors via the sample (the transitive-propagation guard).
		const { n, confidence } = estimateSizeAndConfidence(this.store, this.cfg.m, isMember);
		const capSucc = this.cfg.profile === 'core' ? 12 : 6;
		const capPred = this.cfg.profile === 'core' ? 12 : 6;
		const capSample = this.cfg.profile === 'core' ? 8 : 6;
		const rawSucc = this.getNeighbors(selfCoord, 'right', this.cfg.m);
		const rawPred = this.getNeighbors(selfCoord, 'left', this.cfg.m);
		const successors = rawSucc.slice(0, capSucc);
		const predecessors = rawPred.slice(0, capPred);
		const selfStr = this.node.peerId.toString();
		const excludeIds = new Set([selfStr, ...successors, ...predecessors]);
		const sample = selectDiverseSample(this.store, selfCoord, this.sparsity, excludeIds, capSample, isMember);
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
		// Member-scoped: foreign / unclassified peers are never neighbors, routing
		// candidates, or cohort members for this network. The store walk skips non-members
		// and keeps advancing, so a foreign cluster near the coord can't starve the result.
		if (direction === 'right' || direction === 'both')
			ids.push(...this.store.neighborsRight(hashedCoord, wants, isMember));
		if (direction === 'left' || direction === 'both')
			ids.push(...this.store.neighborsLeft(hashedCoord, wants, isMember));
		return Array.from(new Set(ids)).slice(0, wants);
	}

	assembleCohort(hashedCoord: Uint8Array, wants: number, exclude?: Set<string>): string[] {
		return assembleCohortOverStore(this.store, hashedCoord, wants, exclude, isMember);
	}

	/**
	 * Routing-candidate cohort: member-scoped **and** dialability-scoped, both applied as the
	 * ring walk's own predicate.
	 *
	 * Composing the predicate is the whole point — `.filter()`ing the assembled cohort would
	 * shrink it below `wants` (to empty, when the peers nearest the key are all unreachable)
	 * and dead-end a route while the ring still held reachable hops further out. Same rule as
	 * the breadcrumb exclusions: filter into the walk, never out of the result.
	 *
	 * NOTE: the predicate now runs `isDialable` per visited entry, and a walk that finds no
	 * match is capped at one full traversal of the store (C = 2048 today). Cheap because the
	 * address-set arm short-circuits; if the table capacity grows a lot, keep a connected-id
	 * set so the predicate is two `Set.has` calls.
	 */
	private dialableCohort(hashedCoord: Uint8Array, wants: number, exclude: Set<string>): string[] {
		return assembleCohortOverStore(
			this.store, hashedCoord, wants, exclude,
			(e) => isMember(e) && this.isDialable(e.id)
		);
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
			// Member-scoped: never surface a foreign / unclassified peer to libp2p's discovery
			// pipeline, which would re-seed it into selection upstream.
			// NOTE: callers pass freshly-learned id deltas, so a same-network peer is usually
			// still `unknown` here and is skipped on first sight; the durable emission path is
			// FretPeerDiscovery.scan, which re-scans the whole store each tick and emits the
			// peer once the classification probe promotes it to `member` (~1 tick later).
			if (this.store.getById(id)?.membership !== 'member') continue;
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
		const { n, confidence } = estimateSizeAndConfidence(this.store, this.cfg.m, isMember);

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
			// Exclusions go *into* the walk: post-filtering a sized cohort shrinks it below the
			// requested count, so a long breadcrumb trail would dead-end routing while the ring
			// still held usable next hops.
			const exclude = new Set([...(msg.breadcrumbs ?? []), selfId]);
			// Dialability joins membership as the walk's predicate (see `dialableCohort`), so the
			// selector picks the best *reachable* hop rather than dead-ending a route that still
			// had usable hops behind it. A genuinely empty set falls through to the NearAnchor
			// reply below, exactly as no-next-hop already did.
			const candidates = this.dialableCohort(coord, Math.max(4, this.cfg.m), exclude);

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
					// A failed negotiation hints this hop belongs to another network, but `next`
					// came from the member-gated cohort, so it is a confirmed member and a restart
					// looks identical. Count it; only a run of them demotes.
					if (isUnsupportedProtocolError(err)) this.applyMembershipSignal(next, 'negotiate-failure');
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
		if (bo.until < Date.now()) return 0; // expired: retain entry so factor grows on the next recordBackoff
		return Math.min(1, bo.factor / 32);
	}

	// Remove backoff entries for peers that have been evicted from the store; called
	// once per stabilization tick so the map stays bounded by the store's capacity.
	private pruneBackoffMap(): void {
		for (const id of this.backoffMap.keys()) {
			if (!this.store.getById(id)) this.backoffMap.delete(id);
		}
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
		// Get FRET's own estimate (member-scoped: a co-resident foreign network must not
		// inflate this network's size estimate or the derived cluster span / near-radius).
		const fretEstimate = estimateSizeAndConfidence(this.store, this.cfg.m, isMember);

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
			const { n, confidence } = estimateSizeAndConfidence(this.store, this.cfg.m, isMember);

			// Decide whether to include payload
			const distToKey = xorDistance(selfCoord, coord);
			const includePayload = currentActivity
				? shouldIncludePayload(distToKey, n, confidence, options.wantK)
				: false;

			// Pick candidates: use anchors from prior hints if available, else local cohort.
			// The anchor list is a remote-supplied set of ids, not a sized ring walk, so
			// filtering it directly costs nothing; the local cohort filters inside the walk
			// (see `dialableCohort`). Remote anchors are the likeliest to be undialable — FRET's
			// wire format carries no addresses — so when the filter empties them we fall back to
			// the local cohort rather than declaring the lookup exhausted; only an empty set
			// from *both* ends the walk.
			// NOTE: the walk keeps no visited set, so an unreachable anchor list can send the
			// next iteration back to the same local hop until `maxAttempts` runs out. Bounded
			// and cheap today (the repeat probe is a real RPC to a real peer, not a failed
			// dial); if lookups ever need to cover more of the ring, thread the probed ids
			// through as an exclusion the way `routeAct` threads breadcrumbs.
			const exclude = new Set([selfId]);
			const anchorCandidates = bestAnchors.filter((id) => !exclude.has(id) && this.isDialable(id));
			const candidates = anchorCandidates.length > 0
				? anchorCandidates
				: this.dialableCohort(coord, Math.max(4, this.cfg.m), exclude);

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

				// If we have activity but didn't include it, resend with activity to the anchor.
				// The anchors are remote-supplied ids we may hold no address for, so take the
				// first *dialable* one; when none is, fall through to the bestAnchors update
				// below and let the next iteration route locally instead of failing a dial.
				const actTarget = currentActivity && !includePayload
					? anchor.anchors.find((id) => this.isDialable(id))
					: undefined;
				if (actTarget) {
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
