import type { Startable, PeerId } from '@libp2p/interface';
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
import { DigitreeStore, type PeerEntry, type PeerPatch } from '../store/digitree-store.js';
import { hashKey, hashPeerId, coordToBase64url, base64urlToCoord } from '../ring/hash.js';
import type { Libp2p } from 'libp2p';
import { makeProtocols, validateTimestamp } from '../rpc/protocols.js';
import { registerNeighbors, fetchNeighbors, announceNeighbors } from '../rpc/neighbors.js';
import { registerMaybeAct, sendMaybeAct } from '../rpc/maybe-act.js';
import {
	makeSnapshotParser,
	parseRouteAndMaybeAct,
	MAX_ACTIVITY_BYTES,
	MAYBE_ACT_OVERHEAD_BYTES,
	MAX_SNAPSHOT_METADATA_BYTES_CORE,
	MAX_SNAPSHOT_METADATA_BYTES_EDGE,
} from '../rpc/validate.js';
import { registerLeave, sendLeave } from '../rpc/leave.js';
import { registerPing, sendPing } from '../rpc/ping.js';
import type { RpcOutcome } from '../rpc/outcome.js';
import { fromString as u8FromString } from 'uint8arrays/from-string';
import { estimateSizeAndConfidence } from '../estimate/size-estimator.js';
import { TokenBucket } from '../utils/token-bucket.js';
import { ExpiringMap } from '../utils/expiring-map.js';
import { deadline } from '../utils/deadline.js';
import { runPooled, type PoolResult } from '../utils/pool.js';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { chooseNextHop, type NextHopOptions } from '../selector/next-hop.js';
import { DedupCache, DEDUP_TTL_MS } from './dedup-cache.js';
import { shouldIncludePayload, computeNearRadius } from './payload-heuristic.js';
import { minDistance } from '../ring/distance.js';
import { assembleCohort as assembleCohortOverStore } from './cohort.js';
import { isLiveMember } from './live-member.js';
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An unpredictable token, used for the random part of a correlation id.
 *
 * `Math.random` is a plain PRNG: an observer of a few of our ids can recover its state and
 * compute the ids we have not sent yet, then pre-fill the target's dedup cache with fabricated
 * answers so our real request is served the attacker's reply instead of being performed. A
 * WebCrypto RNG is not predictable from its outputs, which closes that.
 *
 * `randomUUID` is absent on some runtimes we target (React Native, older browsers, non-secure
 * browser contexts), so fall back to `getRandomValues`, which is far more widely present. If
 * neither exists we throw rather than silently degrading to a guessable id.
 */
function randomToken(): string {
	const c = globalThis.crypto;
	if (typeof c?.randomUUID === 'function') return c.randomUUID();
	if (typeof c?.getRandomValues === 'function') {
		const bytes = c.getRandomValues(new Uint8Array(16));
		return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	}
	throw new Error('no WebCrypto RNG available (globalThis.crypto): cannot mint a correlation id');
}

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
 *
 * `rpc-success` is about the *round trip*, not the reply body: a reply that says `ok: false`,
 * `busy`, or that will not decode still reached us over `/optimystic/<network>/fret/...`, which
 * only this network's peers serve. Those arms therefore raise the signal too, through
 * `FretService.noteAnsweredOnProtocol` rather than through `applySuccess` — same membership
 * proof, no relevance credit for an unusable answer.
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

/**
 * A caller-supplied "how many times before we act" count, forced into a usable whole number.
 *
 * A threshold is compared against a counter that only ever increments by one, so anything that
 * is not a finite integer ≥ 1 fails silently rather than loudly: 0 fires on the first
 * observation, a fraction fires one observation early or late, and `NaN` / `Infinity` compare
 * false forever and disable the transition altogether with nothing in the logs.
 */
function normalizeThreshold(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

export class FretService implements IFretService, Startable {
	private mode: FretMode = 'passive';
	private readonly store = new DigitreeStore();
	// Every optional field is resolved to a default in the constructor, so the service never
	// re-derives one at a read site.
	private readonly cfg: Required<FretConfig>;
	private readonly node: Libp2p;
	private stopped = false;
	private started = false;
	/**
	 * Run generation: bumped by both start() and stop(). Each background loop captures the
	 * generation it was armed for and exits when it no longer matches, so a timer left pending
	 * by a stop() cannot be resurrected by the next start() (which would leave two live loops).
	 */
	private runGen = 0;
	/**
	 * Run-scoped cancellation for every *outbound maintenance* RPC: minted in `start()` right
	 * after `runGen++`, aborted in `stop()` right after the loop timers are cleared, so background
	 * pings / fetches / forwards die at once instead of holding teardown open behind a 5 s budget.
	 *
	 * Mirrors `runGen`'s placement for the same reason that counter exists: a start→stop→start
	 * cycle must mint a **fresh** controller, because a reused, already-aborted one would silently
	 * cancel every RPC of the new run. `null` only before the first `start()`. The leave fan-out
	 * deliberately does *not* use it — it runs after the abort, on its own budget (see
	 * `sendLeaveToNeighbors`).
	 *
	 * The aborted controller is deliberately **kept** after `stop()` rather than nulled, and is
	 * replaced only by the next `start()`. Nulling it turns "cancelled" back into "no signal" for
	 * every call site that reads {@link runSignal} *after* the abort — and several do: a `stop()`
	 * landing mid-tick leaves the rest of `stabilizeOnce` (which has no `stopped` re-check between
	 * its passes) to capture the signal fresh, so those probes would dial after teardown, hold
	 * shutdown open, and score contact strikes against healthy peers — the exact failure the abort
	 * exists to prevent.
	 */
	private runAbort: AbortController | null = null;
	private stabilizeTimer: ReturnType<typeof setTimeout> | null = null;
	private preconnectTimer: ReturnType<typeof setTimeout> | null = null;
	/** runGen the active-preconnect loop is armed for; -1 when no loop is armed. */
	private preconnectGen = -1;
	private readonly nodeListeners: Array<{ type: string; handler: (evt: any) => void }> = [];
	private inflightAct = 0;
	private readonly bucketNeighbors: TokenBucket;
	private readonly bucketMaybeAct: TokenBucket;
	private postBootstrapAnnounced = false;
	private readonly sparsity: SparsityModel = createSparsityModel();
	private cachedSelfCoord: Uint8Array | null = null;
	private readonly protocols: ReturnType<typeof import('../rpc/protocols.js').makeProtocols>;
	private metadata?: Record<string, unknown>;
	private activityHandler?: ActivityHandler;
	/** Sized in the constructor, where the profile is known — see the sizing note there. */
	private readonly dedupCache: DedupCache<NearAnchorV1 | { commitCertificate: string }>;
	/**
	 * Per-peer probe backoff. Sized and expired in the constructor — see the sizing note there
	 * and {@link BACKOFF_RETAIN_MS} for why the retention lifetime is *not* the backoff window.
	 */
	private readonly backoffMap: ExpiringMap<{ until: number; factor: number }>;
	private readonly bucketPing: TokenBucket;
	private readonly bucketLeave: TokenBucket;
	private readonly bucketAnnounce: TokenBucket;
	private readonly bucketAnnounceInbound: TokenBucket;
	private readonly announceFanout: number;
	/**
	 * Coordinate regions announced for recently, so a burst of departures around one region
	 * produces one announce burst. **Presence alone means "recently announced"** — the map's TTL
	 * *is* {@link DEPARTURE_DEBOUNCE_MS}, so an entry still present is still inside its window and
	 * the value (the announce timestamp) is diagnostics only. Sized in the constructor.
	 */
	private readonly departureDebounce: ExpiringMap<number>;
	private static readonly DEPARTURE_DEBOUNCE_MS = 2000;
	/**
	 * First backoff window, doubled on each further failure up to {@link BACKOFF_MAX_FACTOR}.
	 *
	 * A named constant rather than a literal inside `recordBackoff` so the retention inequality
	 * below can be asserted against the real value instead of a copy of it.
	 */
	private static readonly BACKOFF_BASE_MS = 1000;
	/** Cap on the doubling factor: the longest window is `BACKOFF_BASE_MS × BACKOFF_MAX_FACTOR`. */
	private static readonly BACKOFF_MAX_FACTOR = 32;
	/**
	 * How long a peer's backoff *escalation* is remembered after its last failure — deliberately
	 * not the backoff window itself.
	 *
	 * `getBackoffPenalty` keeps an entry whose `until` has passed so the next `recordBackoff`
	 * doubles `factor` instead of restarting at 1; that escalation is what tapers a genuinely
	 * foreign or dead peer toward ~once/32 s. So retention means "forget a peer's escalation once
	 * it has gone this long without failing again", and it must comfortably exceed the longest
	 * backoff window (`BACKOFF_BASE_MS × BACKOFF_MAX_FACTOR` = 32 s) — otherwise a peer re-probed
	 * at the slowest cadence would have its entry forgotten *between* probes and silently reset to
	 * factor 1, which is exactly the escalation this constant exists to preserve. 5 min is ~9× the
	 * longest window; `test/ring-membership.spec.ts` pins the inequality so tuning either side
	 * fails loudly.
	 */
	private static readonly BACKOFF_RETAIN_MS = 300_000;
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
	/**
	 * Minimum spacing between two contact failures that both count toward the dead-state run.
	 *
	 * Same reasoning as the negotiate spacing above — concurrent callers failing against one
	 * restarting peer are a single observation, and a burst must not be able to reach the
	 * threshold on its own — but a deliberately separate constant: the two runs mean different
	 * things ("does not serve this network" vs "cannot be reached at all") and should be free to
	 * diverge without one silently re-tuning the other.
	 */
	private static readonly CONTACT_FAILURE_MIN_SPACING_MS = 500;
	/**
	 * Whole-RPC budget for the single-hop maintenance RPCs — ping and announce.
	 *
	 * A ping is a ~50-byte round trip and an announce is a fire-and-forget push with no reply of
	 * substance, so the default `RPC_TIMEOUT_MS` (5 s) on these paths only ever means "this peer
	 * is gone" — and they are exactly the paths that must not hold a stabilization or warm-up tick
	 * open. `sendMaybeAct` deliberately keeps the default: it returns only once the *whole
	 * remaining route* has completed downstream, so its budget is a route budget, not a link one.
	 */
	private static readonly MAINTENANCE_RPC_TIMEOUT_MS = 2000;
	/**
	 * Wall-clock cap on one whole stabilization tick (`stabilizeOnce`).
	 *
	 * The tick's RPCs run pooled (`maintenanceConcurrency` in flight), each already bounded by its
	 * own RPC budget, so this is the bound on the *tick*, not on any one peer: when it expires,
	 * in-flight RPCs abort, not-yet-started tasks come back `skipped`, and the tick returns. It is
	 * the same magnitude as the single-RPC default (`RPC_TIMEOUT_MS`, 5 s), so a tick can be
	 * consumed by one round of slow peers, never by several rounds of them. Skipped work is not
	 * lost — the next tick re-derives its candidates from the store and picks it up. It is a child
	 * of the run signal, so a `stop()` collapses the whole tick at once, and every task compares
	 * against it through `wasCancelled`, so an expiry records no strike, no backoff and no
	 * `pingsFail` — exactly as a `stop()` does.
	 *
	 * NOTE: active mode ticks every 300 ms, so under mass failure a 5 s budget makes active
	 * stabilization effectively continuous (the loop awaits the tick before re-arming — true today
	 * as well). Tighten per mode only if warm-up latency ever measurably suffers.
	 */
	private static readonly STABILIZE_TICK_BUDGET_MS = 5000;
	/**
	 * Wall-clock cap on the whole leave fan-out inside `stop()`.
	 *
	 * The fan-out is `announceFanout`-bounded (Core 8 / Edge 4) plus a small connected-only
	 * extra, and `isDoomedDial`-filtered, so 3 s is generous for the reachable targets while
	 * capping a `stop()` that would otherwise serialize several dead dials at a timeout apiece.
	 * Cannot reuse the run signal — the fan-out runs *after* that aborts, by design.
	 */
	private static readonly SHUTDOWN_BUDGET_MS = 3000;
	/** Per-notice budget inside {@link SHUTDOWN_BUDGET_MS}, so one stalled peer cannot eat it whole. */
	private static readonly LEAVE_NOTICE_TIMEOUT_MS = 1500;
	private firstStabilizeDone = false;
	/**
	 * Plain `++` counters on a single-threaded event loop, so the pooled stabilization tick cannot
	 * corrupt them. A tick truncated by `STABILIZE_TICK_BUDGET_MS` counts fewer pings/snapshots
	 * than a serial tick would have — correct, since those RPCs did not happen.
	 */
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
		/**
		 * Replacement ids recorded from inbound leave notices (see `recordLeaveReplacements`).
		 * Counts ids that passed every filter, which is *not* the same as new table entries: an
		 * id already in the store is recorded too (the upsert preserves it). Named "recorded"
		 * rather than "inserted" so it is not read as a table-pollution gauge.
		 */
		leaveReplacementsRecorded: 0,
		rejected: {
			payloadTooLarge: 0,
			timestampBounds: 0,
			ttlExpired: 0,
			rateLimited: 0,
			identityMismatch: 0,
			/** Inbound maybeAct messages that failed `parseRouteAndMaybeAct` (structure/type). */
			malformed: 0,
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
			// At least 1 whole failure: 0 would mark every peer dead on its first failure, and a
			// non-finite value would compare false against the counter forever — silently
			// disabling the transition rather than failing where the caller could see it.
			deadAfterFailures: normalizeThreshold(cfg?.deadAfterFailures, 3),
		};
		// Create network-specific protocols
		this.protocols = makeProtocols(this.cfg.networkName);
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
		// Sized by role: an entry evicted before its TTL expires is a replay hole, so capacity
		// must exceed the most entries an attacker can force into one TTL window. Only a
		// rate-limited request reaches `cacheResponse`, so that ceiling is the maybeAct bucket:
		// burst + refill × TTL — Core 32 + 16/s × 30s = 512, Edge 8 + 4/s × 30s = 128. Both
		// capacities below are 4× that, leaving room for legitimate concurrent lookups.
		// NOTE: these track the `bucketMaybeAct` rates above; raising those without raising
		// these re-opens the eviction hole.
		this.dedupCache = new DedupCache(DEDUP_TTL_MS, this.cfg.profile === 'core' ? 2048 : 512);
		// An entry for a peer no longer in the store is dropped by `pruneBackoffMap` on the next
		// tick regardless, so the routing table's own capacity is the only ceiling that can ever
		// bind here — Core takes it as-is, Edge trades that worst case for memory. A wrong eviction
		// costs one earlier probe of the stalest-failing peer, since losing the entry only resets
		// that peer's escalation to factor 1.
		this.backoffMap = new ExpiringMap<{ until: number; factor: number }>({
			capacity: this.cfg.profile === 'core' ? this.cfg.capacity : Math.min(this.cfg.capacity, 512),
			ttlMs: FretService.BACKOFF_RETAIN_MS,
		});
		// Live size is bounded by departures per DEPARTURE_DEBOUNCE_MS window, so Core's 512 leaves
		// 256 departures/s of headroom before the cap can bind at all. A wrong eviction costs one
		// extra announce burst, which `bucketAnnounce` already caps globally — the cheapest of the
		// bounded maps to get wrong, which is why it carries the smallest capacity.
		this.departureDebounce = new ExpiringMap<number>({
			capacity: this.cfg.profile === 'core' ? 512 : 128,
			ttlMs: FretService.DEPARTURE_DEBOUNCE_MS,
		});
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

	private async enforceCapacity(): Promise<void> {
		const cap = Math.max(1, this.cfg.capacity);
		if (this.store.size() <= cap) return;
		// Protect immediate neighbors around self. Awaits (rather than reads the nullable
		// cache) so enforcement still runs during startup seeding and table import, when
		// `cachedSelfCoord` has not been hashed yet — the two bulk-insert paths most likely
		// to overflow the table in the first place.
		const self = await this.selfCoord();
		// Protect only *live member* neighbors around self (see `isLiveMember`). A foreign or
		// dead peer can no longer squat in a protected slot, so with relevance ~0 it becomes a
		// preferred eviction victim — exactly what we want, and why the dead state needs no
		// eviction-specific handling of its own.
		// NOTE: protection wins over the cap, so a table whose protected set is already at least
		// `capacity` stays over capacity — the loop below finds nothing evictable and exits with
		// `size() > cap`. The protected set is self plus up to `max(2, m) - 1` live members on
		// each side, i.e. up to `2m - 1` ids, so this needs `capacity < 2m - 1`: unreachable with
		// the shipped numbers (m 8, capacity 2048) and only reachable by misconfiguration.
		// Pinned by `test/relevance.eviction.spec.ts`. If a profile ever ships a capacity that
		// small, capacity stops being a bound and this needs a floor at construction (or
		// protection needs to yield past some multiple of the cap).
		const protectedIds = this.store.protectedIdsAround(self, Math.max(2, this.cfg.m), isLiveMember);
		// Evict the lowest relevance non-protected entries until under cap.
		// NOTE: lists and fully sorts the store to drop a handful of entries. Only reachable once
		// the table is at capacity, so it is a no-op in the common case; if a ring settles at cap
		// under steady churn this runs on every merge/seed, and a bounded selection of the few
		// lowest-relevance entries would replace the full sort.
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

	/**
	 * Record a completed namespaced RPC against `id`.
	 *
	 * `latencyMs` is optional and must be supplied **only** when the caller timed a round trip
	 * to this peer alone — today that is the ping paths. A caller with no such measurement omits
	 * it and the peer's `avgLatencyMs` is left untouched, rather than writing a placeholder that
	 * would decay a real measurement away over successive calls.
	 *
	 * NOTE: this reads the entry, awaits `selfCoord()`, then writes — as do `applyTouch` /
	 * `applyFailure`. Two chains scoring the same peer across that await both derive
	 * `successCount + 1` from the same base, so one increment is lost. Harmless while the
	 * counters only feed a relevance score that is recomputed on every call; if they ever
	 * become load-bearing (quorum, fairness accounting), make the update read-modify-write
	 * inside the store instead of patching a value derived outside it.
	 */
	private async applySuccess(id: string, coord: Uint8Array, latencyMs?: number): Promise<void> {
		const entry = this.store.getById(id) ?? this.store.upsert(id, coord);
		const x = normalizedLogDistance(await this.selfCoord(), coord);
		const next = scoreSuccess(entry, latencyMs, x, this.sparsity);
		this.store.update(id, {
			lastAccess: next.lastAccess,
			relevance: next.relevance,
			successCount: next.successCount,
			// Omitted entirely with no sample, so the patch never speaks for a field this call
			// has nothing to say about.
			...(latencyMs === undefined ? {} : { avgLatencyMs: next.avgLatencyMs }),
		});
		// Every applySuccess call in this service follows a completed RPC over this
		// network's namespaced protocol (ping or maybeAct), which proves the peer
		// serves this network → confirm membership for free off normal traffic.
		this.applyMembershipSignal(id, 'rpc-success');
		// …and proves it is reachable, which clears any contact-failure run and resurrects it if
		// a previous run had marked it dead.
		this.noteProofOfLife(id);
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

	/** This peer's stored ring coordinate, hashing its id when we hold no entry for it yet. */
	private async coordOf(id: string): Promise<Uint8Array> {
		return this.store.getById(id)?.coord ?? (await hashPeerId(peerIdFromString(id)));
	}

	/**
	 * The single seam for "we could not reach this peer": decay its relevance, then count the
	 * strike toward the dead-state threshold.
	 *
	 * Callers must route *only* genuine unreachability here — the outbound RPC threw because the
	 * dial, stream, or read failed. A peer that answered and refused (unsupported protocol), a
	 * peer that replied `ok: false`, and an idle `peer:disconnect` all prove the remote is alive
	 * or say nothing about it, so they keep their relevance decay and nothing more.
	 */
	private async applyContactFailure(id: string, coord: Uint8Array): Promise<void> {
		await this.applyFailure(id, coord);
		this.applyContactStrike(id);
	}

	/**
	 * Count one failed contact against `id`, marking it `dead` once the run completes.
	 *
	 * **Synchronous by construction.** `applySuccess` / `applyFailure` read an entry, await the
	 * self coordinate, then write a value derived before the await — so two concurrent chains
	 * lose one increment (see the NOTE on `applySuccess`). That is harmless for a relevance score
	 * recomputed on every call, but not for a threshold counter, where a lost strike silently
	 * delays or prevents the transition. So this reads, patches, and returns with no await in
	 * between, exactly like `applyMembershipSignal`.
	 *
	 * NOTE: this and `applyMembershipSignal`'s `negotiate-failure` arm are the same shape — a
	 * spacing guard, a clamped increment, a state transition at the threshold — written twice.
	 * Two instances with different constants, different counters and different transitions are
	 * cheaper left apart than behind a parameterized helper; if a third spaced-run counter ever
	 * appears, factor all three out rather than adding another copy.
	 */
	private applyContactStrike(id: string): void {
		// Self is never a normal RPC target, but a dead self would drop out of every ring view —
		// and out of the capacity protection that keeps it there — with no path back short of a
		// restart. Cheap guard, unrecoverable failure avoided.
		if (id === this.node.peerId.toString()) return;
		const e = this.store.getById(id);
		if (!e) return;
		// A *run* means observations separated in time. Several forwards to one restarting hop all
		// fail in the same instant; that is one observation, not three.
		const now = Date.now();
		if (now - e.lastContactFailureAt < FretService.CONTACT_FAILURE_MIN_SPACING_MS) return;
		const threshold = this.cfg.deadAfterFailures;
		// Clamped at the threshold so the counter stays bounded for a peer we keep re-probing;
		// a peer already dead simply stays dead.
		const failures = Math.min(e.contactFailures + 1, threshold);
		const patch: PeerPatch = { contactFailures: failures, lastContactFailureAt: now };
		if (failures >= threshold && e.state !== 'dead') patch.state = 'dead';
		this.store.update(id, patch);
	}

	/**
	 * Record that `id` is demonstrably alive: clear its contact-failure run and, if it was marked
	 * `dead`, restore it to a live state.
	 *
	 * Called from every site that proves liveness — a completed outbound RPC (`applySuccess`), an
	 * inbound RPC (`noteInboundRpc`), and a fresh transport connection (`peer:connect`). The
	 * counter reset is the load-bearing half at the connect site: `setState(id, 'connected')`
	 * there would otherwise resurrect a peer whose counter is still clamped at the threshold, so
	 * its very next failure would re-kill it.
	 *
	 * Relevance is deliberately *not* reset to a baseline. `scoreSuccess` already up-ranks on
	 * success, and wiping the health counters would erase the record of a peer that flaps.
	 */
	private noteProofOfLife(id: string): void {
		const e = this.store.getById(id);
		if (!e) return;
		const patch: PeerPatch = {};
		// The spacing stamp is cleared alongside the count, because it only means anything
		// *within* a run: leaving it behind makes the first failure of the next run land inside
		// the spacing window of a failure from the run just ended, so that strike is discarded
		// and the peer gets a free miss after every recovery.
		if (e.contactFailures !== 0 || e.lastContactFailureAt !== 0) {
			patch.contactFailures = 0;
			patch.lastContactFailureAt = 0;
		}
		if (e.state === 'dead') patch.state = this.isConnected(id) ? 'connected' : 'disconnected';
		if (Object.keys(patch).length === 0) return; // already settled
		this.store.update(id, patch);
	}

	/**
	 * The remote *answered on this network's namespaced protocol* — a framed reply came back,
	 * whatever it said: `ok: false`, `busy`, or bytes that would not decode.
	 *
	 * Weaker than {@link applySuccess}: no relevance credit and no latency sample, because the
	 * reply itself was unusable. But the two facts it does carry are unambiguous, and they are
	 * exactly the strong-evidence row of the table in docs/fret.md. Reaching the reply at all
	 * means the peer negotiated `/optimystic/<network>/fret/...`, which only this network's peers
	 * serve, so it is a member; and the bytes coming back prove it is reachable, which clears any
	 * contact-failure run. Reply *contents* are evidence about the peer's load or its encoder —
	 * never about which network it belongs to.
	 *
	 * Called from the passes whose job is classification and liveness bookkeeping. The passes that
	 * deliberately score nothing at all — the warm-up fan-out, `fetchAndMergeSnapshot`'s
	 * answered-badly arm — stay score-free; the table says a completed RPC *may* set `member`, not
	 * that every site must.
	 */
	private noteAnsweredOnProtocol(id: string): void {
		this.applyMembershipSignal(id, 'rpc-success');
		this.noteProofOfLife(id);
	}

	/**
	 * Record that the transport connection to `id` closed.
	 *
	 * `dead` is a liveness *verdict*, not a connection state, so a disconnect must never overwrite
	 * it. A peer marked dead by a run of failed contacts is still dead when its half-open
	 * connection finally drops — and that drop is exactly the event that follows the failures, so
	 * a plain `setState(id, 'disconnected')` here would undo almost every transition the seam
	 * makes. Nothing about a closing connection is proof of life, and the counter behind the
	 * label is still clamped at the threshold, so the peer would be re-admitted only to be
	 * re-killed by its next failure: a peer flapping in and out of every ring view.
	 *
	 * Clearing `dead` is `noteProofOfLife`'s job alone (plus `peer:connect`, where a connection
	 * genuinely formed and `setState(id, 'connected')` is itself the proof).
	 */
	private noteDisconnected(id: string): void {
		if (this.store.getById(id)?.state === 'dead') return;
		this.store.setState(id, 'disconnected');
	}

	/**
	 * Route one failed outbound RPC to the evidence channel it actually belongs to, branching on
	 * the outcome variant: `foreign-protocol` proves the peer alive on another network and takes
	 * the membership path; `unreachable` / `timeout` are failures to reach the peer at all and
	 * take the contact-failure seam; `decode-error` is proof of life answering badly — relevance
	 * decay only, never a strike. `ok` / `busy` / `cancelled` / `skipped` are the callers' to
	 * handle.
	 *
	 * It deliberately records **no backoff**: each call site keeps whatever backoff behavior it
	 * already had, so routing failures through here introduces none where there was none.
	 *
	 * Never throws — it is bookkeeping on an already-failed path, and several call sites run it
	 * from inside a `catch` where a second throw would escape into a background loop.
	 */
	private async noteRpcFailure(id: string, outcome: RpcOutcome<unknown>): Promise<void> {
		try {
			switch (outcome.kind) {
				case 'foreign-protocol':
					this.applyMembershipSignal(id, 'negotiate-failure');
					return;
				case 'unreachable':
				case 'timeout':
					await this.applyContactFailure(id, await this.coordOf(id));
					return;
				case 'decode-error':
					// Answering badly is still answering: relevance decays, but the reply reached us
					// over our own namespaced protocol, so it is membership proof and proof of life
					// alike — never a strike.
					this.noteAnsweredOnProtocol(id);
					await this.applyFailure(id, await this.coordOf(id));
					return;
				default:
					return; // ok / busy / cancelled / skipped are the callers' to handle
			}
		} catch (e) {
			log.error('noteRpcFailure bookkeeping failed for %s - %e', id, e);
		}
	}

	/**
	 * The current run's cancellation signal — already **aborted** once `stop()` has run, and
	 * `undefined` only before the first `start()`. See {@link runAbort} for why the stopped run's
	 * signal is kept rather than cleared.
	 */
	private get runSignal(): AbortSignal | undefined {
		return this.runAbort?.signal;
	}

	/**
	 * True when a failed RPC is (or follows) **our own** cancellation — which is not evidence about
	 * the peer and must record nothing: no contact strike, no relevance decay, no backoff, no
	 * `pingsFail`. Without this a `stop()` or a busy tick manufactures strikes against healthy
	 * neighbors and can mark them `dead`, inverting the point of cancelling at all.
	 *
	 * The check is against the signal the *caller* passed to the sender, not the sender's own
	 * deadline: the sender builds its deadline as a *child* of ours, so the child is aborted both
	 * when its own budget fired (genuine unreachability — keeps today's semantics) and when we
	 * cancelled, while ours is aborted only in the second case. Callers capture the signal in a
	 * local **before** the loop / `try` so a mid-flight `stop()`+`start()` (which nulls and re-mints
	 * {@link runAbort}) cannot change what is being compared. No new error type is needed for the
	 * same reason — the caller already holds the discriminating fact.
	 */
	private wasCancelled(sig: AbortSignal | undefined): boolean {
		return sig?.aborted === true;
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
				const patch: PeerPatch = { negotiateFailures: failures, lastNegotiateFailureAt: now };
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
			// The peer dialed *us*, which is proof of life however badly our own dials to it fared.
			this.noteProofOfLife(id);
		} catch (err) {
			log.error('noteInboundRpc failed for %s - %e', id, err);
		}
	}

	/**
	 * Classify `id` from a libp2p-reported protocol list (available once identify has
	 * run). Member if any of our namespaced protocols appears; foreign if the list is
	 * non-empty but contains none of them; left unknown if empty (identify pending).
	 * The demotion arm is deliberately weak — see `applyMembershipSignal`.
	 *
	 * NOTE: `seedFromPeerStore` calls this every tick, and the positive arm resets the
	 * negotiate-failure run (identify listing one of our protocols is strong evidence). That is
	 * correct while the list can go stale-*negative*, which is what `identifyPush` delivers when a
	 * peer unhandles our protocols. A deployment that configures `identify` **without**
	 * `identifyPush` never gets that update, so a peer that stops serving this network has its
	 * negotiate run reset on every tick and can never demote to `foreign` — it stays a cohort
	 * member and routing candidate that can only fail. Liveness is unaffected (a peer whose node
	 * goes away still reaches `dead`). If FRET ever ships a recommended libp2p config, require
	 * `identifyPush`; if that is not possible, this arm needs a freshness bound on the list rather
	 * than trusting it unconditionally. `test/failure-recovery.spec.ts` documents the same fact
	 * from the test side — its service-only-outage block needs identify nodes for this reason.
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
		// Fresh controller per run, minted alongside the generation bump (see `runAbort`).
		this.runAbort = new AbortController();
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
				const coord = await this.coordOf(id);
				this.store.upsert(id, coord);
				this.store.setState(id, 'connected');
				// A transport connection formed, so the peer is reachable. `setState` above already
				// cleared any `dead` label; this clears the counter behind it, which would otherwise
				// stay clamped at the threshold and let the very next failure re-kill the peer.
				this.noteProofOfLife(id);
				await this.applyTouch(id, coord);
			} catch (err) { log.error('peer:connect handler failed - %e', err) }
		});
		this.addNodeListener('peer:disconnect', async (evt: any) => {
			try {
				if (this.stopped) return;
				// libp2p v3: evt.detail is the PeerId directly, not { id: PeerId }
				const id = evt?.detail?.toString?.();
				if (!id) return;
				const coord = await this.coordOf(id);
				const wasNear = this.isNearNeighbor(id, coord);
				this.noteDisconnected(id);
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
		// Cancel every in-flight maintenance RPC *before* the teardown below and the leave
		// fan-out, so background dials die at once and do not compete with shutdown. Ordering is
		// load-bearing on both sides: after `clearLoopTimers()` (nothing new gets armed) and
		// before `sendLeaveToNeighbors()`, which must still go out — it carries its own budget,
		// not this signal, which is why aborting here does not silence it.
		// Left in place (not nulled) so a late `runSignal` read still reports "cancelled"; the next
		// start() mints a fresh controller. See `runAbort`.
		this.runAbort?.abort();
		this.removeNodeListeners();
		// Unhandle before the leave notices: unhandle only removes *inbound* handlers,
		// while the leave notices go out over our own outbound streams.
		await this.unregisterRpcHandlers();
		try { await this.sendLeaveToNeighbors(); } catch (err) { console.warn('sendLeaveToNeighbors failed', err); }
		// A start→stop→start cycle is a fresh run, so neither map may carry into it: a peer's
		// backoff escalation is per-run handshake history, exactly like `negotiateFailures`, which
		// the store already refuses to carry across a restart. Cleared after the leave fan-out so
		// that fan-out still sees the run's state. Mirrors `FretPeerDiscovery.stop()`.
		this.backoffMap.clear();
		this.departureDebounce.clear();
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

	private maxBytesNeighbors(): number { return this.cfg.profile === 'core' ? 16 * 1024 : 8 * 1024; }
	private maxBytesMaybeAct(): number { return MAX_ACTIVITY_BYTES + MAYBE_ACT_OVERHEAD_BYTES; }

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
					(from) => this.detach(this.noteInboundRpc(from), 'noteInboundRpc(neighbors)'),
					// The announce path's single cap enforcement point — `mergeAnnounceSnapshot`
					// does not slice. Numbers come from `mergeSnapshotCaps()`; do not inline them.
					makeSnapshotParser(this.mergeSnapshotCaps()),
					() => { this.diag.rejected.malformed++; }
				),
				// NOTE: maybeAct deliberately stays on `registerRpcHandler` while the other four
				// protocols moved to the shared `registerJsonHandler` seam. That seam parses inside
				// the handler body, but this protocol's rate-limit bucket must be taken before any
				// per-message work at all — so its parser call (`parseRouteAndMaybeAct`) stays inside
				// `handleMaybeAct`, after the bucket. The asymmetry is deliberate; do not unify it.
				registerMaybeAct(
					this.node,
					async (msg, from) => {
						this.detach(this.noteInboundRpc(from), 'noteInboundRpc(maybeAct)');
						return await this.handleMaybeAct(msg);
					},
					this.protocols.PROTOCOL_MAYBE_ACT,
					this.maxBytesMaybeAct()
				),
				// NOTE: leave is deliberately the one inbound handler with no `noteInboundRpc`
				// hook (compare neighbors / maybeAct / ping above and below). That hook applies
				// the `rpc-inbound` membership signal to the sender, which here is the *departing*
				// peer — it would re-insert it as a confirmed `member` immediately after
				// `handleLeave` removed it. The asymmetry is the point; do not "fix" it while
				// tidying these signatures.
				registerLeave(
					this.node,
					async (notice) => this.handleLeave(notice),
					this.protocols.PROTOCOL_LEAVE,
					() => { this.diag.rejected.identityMismatch++; },
					() => { this.diag.rejected.malformed++; }
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

	/**
	 * Response-cache key: correlation id **plus phase**, where the phase is simply whether the
	 * message carries an activity.
	 *
	 * A find-then-act flow is two requests, not two copies of one: a digest-only probe asks
	 * "who is near this key?", and the resend that follows carries the actual work. They share a
	 * correlation id because they belong to one lookup, so keying on the id alone lets the
	 * probe's cheap `NearAnchor` be handed back as the answer to the message that carries the
	 * work — and the activity handler never runs. That is not a rare race: a responder's anchor
	 * list normally names itself (it is in-cluster, which is why it answered), so the resend
	 * usually goes straight back to the peer that just cached the digest reply.
	 *
	 * Both arms keep their idempotency under this key. A replayed digest probe still returns the
	 * cached anchors without re-walking the ring, and a genuine retry of the same work still
	 * returns the stored commit certificate rather than performing the work twice.
	 *
	 * The phase is read off the message's own `activity` field rather than parsed out of the
	 * sender's id, which is opaque to us. The activity payload is deliberately *not* hashed into
	 * the key: a retry whose payload re-encodes to equivalent-but-different bytes would miss the
	 * cache and re-perform the work, which is worse than the collision that would guard against
	 * (each lookup mints its own activity id, so distinct payloads do not share a key).
	 */
	private dedupKey(msg: RouteAndMaybeActV1): string {
		return `${msg.correlation_id}|${msg.activity ? 'act' : 'digest'}`;
	}

	/**
	 * Store a response under the message's dedup key — but only when it is a *terminal* answer
	 * for that phase.
	 *
	 * For a digest probe a `NearAnchor` is the answer, so it caches. For an activity-bearing
	 * message a `NearAnchor` is the opposite: it means "I did not perform the work — the ring
	 * says try over there" (no handler installed, or not in-cluster and the forward found no
	 * hop or failed). Caching it would answer every retry of that work for the TTL with the
	 * same refusal, and the activity would be lost — the very failure {@link dedupKey} exists
	 * to prevent, one level in, and just as silent.
	 *
	 * Not caching a refusal means a replayed activity can re-drive the forward attempt. That is
	 * the correct trade: the work was never performed, so re-attempting is not a duplicate, and
	 * TTL decrement, breadcrumbs and the rate-limit bucket already bound the cost.
	 */
	private cacheResponse(
		msg: RouteAndMaybeActV1,
		result: NearAnchorV1 | { commitCertificate: string }
	): void {
		if (!msg.correlation_id) return;
		if (msg.activity && !('commitCertificate' in result)) return;
		this.dedupCache.set(this.dedupKey(msg), result);
	}

	/**
	 * Static, zero-computation rejection for messages that fail a cheap validity check
	 * (breadcrumb loop, stale/future timestamp, expired TTL, oversized payload). Deliberately
	 * *not* {@link nearAnchorOnly} — that call still hashes the key and walks the ring twice,
	 * which is exactly the per-message cost the rate limit below exists to bound, so a flood of
	 * trivially-invalid messages must not be able to force it.
	 *
	 * NOTE: `estimated_cluster_size` / `confidence` are 0 here — "no information given" — for the
	 * same reason {@link nearAnchorOnly} uses placeholders: no consumer reads either field today.
	 * If one starts to, both sites need revisiting together, and this one cannot report a real
	 * estimate without giving back the per-message cost it exists to avoid.
	 */
	private staticReject(): NearAnchorV1 {
		return { v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 0, confidence: 0 };
	}

	private async handleMaybeAct(
		msg: RouteAndMaybeActV1
	): Promise<NearAnchorV1 | BusyResponseV1 | { commitCertificate: string }> {
		// Rate limit first, before any per-message computation: otherwise a flood of messages
		// that all fail a cheap validity check below (loop/stale/expired-TTL/oversized) would
		// never reach this check and the bucket would bound nothing.
		// NOTE: this also puts the dedup lookup behind the bucket, so under an empty bucket a
		// legitimate retry gets `busy` instead of its cached certificate. Correct, not a
		// regression of idempotency — the work is still never performed twice, and the sender
		// has `retry_after_ms` — but if retry latency under load ever matters, the fix is a
		// cheaper dedup-only pre-check, not moving the bucket back behind the guards.
		if (!this.bucketMaybeAct.tryTake()) { this.diag.rejected.rateLimited++; return { v: 1, busy: true, retry_after_ms: this.bucketMaybeAct.retryAfterMs() }; }

		// Structural validation immediately after the bucket (so malformed floods are metered
		// too, never an unmetered pre-filter) and before every guard below — each of which reads
		// fields the validator vouches for (`breadcrumbs?.includes` on a number was a throw that
		// leaked the inbound stream). O(message size): no hashing, no ring walks.
		// NOTE: the parsed result is discarded and `msg` is used from here down. Correct only
		// because this is the one parser that normalizes nothing and returns its own argument
		// (see `parseRouteAndMaybeAct`); the day it normalizes anything, this silently reads the
		// un-normalized message with no compile error. Bind the result if that rule ever changes.
		if (!parseRouteAndMaybeAct(msg)) { this.diag.rejected.malformed++; return this.staticReject(); }
		// The one decode of `key`. Handed down to `routeAct` / `nearAnchorOnly` so neither can
		// throw on the field the validator just vetted — the double-throw that used to make the
		// fallback as fragile as the path it backstopped.
		const keyBytes = u8FromString(msg.key, 'base64url');

		// Breadcrumb loop detection: reject if self already visited
		const selfId = this.node.peerId.toString();
		if (msg.breadcrumbs?.includes(selfId)) return this.staticReject();

		// Correlation-ID dedup: return cached result if seen before
		if (msg.correlation_id) {
			const cached = this.dedupCache.get(this.dedupKey(msg));
			if (cached) return cached;
		}

		// Timestamp freshness: reject messages outside the ±30s window (= the dedup TTL, so a
		// message can never outlive the cache entry that recognises it as a replay)
		// NOTE: ±30s also makes this the tightest clock-sync requirement in the system, and a
		// badly-skewed peer presents only as a rising `timestampBounds` count. If skew ever
		// needs diagnosing in the field, record the observed offset here rather than a bare tally.
		if (!validateTimestamp(msg.timestamp)) {
			this.diag.rejected.timestampBounds++;
			return this.staticReject();
		}

		// Quick guards
		if (msg.ttl <= 0) { this.diag.rejected.ttlExpired++; return this.staticReject(); }
		if (msg.activity && msg.activity.length > MAX_ACTIVITY_BYTES) { this.diag.rejected.payloadTooLarge++; return this.staticReject(); }
		const limit = this.cfg.profile === 'core' ? 16 : 4;
		if (this.inflightAct >= limit) { this.diag.rejected.rateLimited++; return { v: 1, busy: true, retry_after_ms: 500 }; }
		this.inflightAct++;
		try {
			const result = await this.routeAct(msg, keyBytes);
			this.cacheResponse(msg, result);
			return result;
		} catch (err) {
			log.error('routeAct failed - %e', err);
			return await this.nearAnchorOnly(msg, keyBytes);
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
	 * Would a maintenance dial to this peer be wasted breath?
	 *
	 * The maintenance fan-outs (announces, leave notices) deliberately draw their targets from
	 * *unfiltered* store walks — a member-scoped walk would drop a freshly-connected peer that is
	 * still `unknown` and stall bootstrap before the classification pass can label it — so each of
	 * them needs this guard stated explicitly rather than inheriting {@link isLiveMember}. Having
	 * it in one place is what keeps the two fan-outs from drifting apart, which they had:
	 *
	 * - **undialable** — a bare-id dial with no peerStore address can only raise
	 *   `NoValidAddressesError` (see *Dialability* in `docs/fret.md`).
	 * - **`foreign`** — a peer already proved to serve another network can only answer a dial on
	 *   one of our namespaced protocols with `UnsupportedProtocolError`.
	 * - **`dead`** — a run of failed contacts says the dial fails outright. Re-probing it is the
	 *   dead arm of {@link reprobeOffRingTargets}'s job, which is budgeted for exactly that; a maintenance
	 *   fan-out is not, and would re-probe every dead peer on every tick with no backoff.
	 *
	 * `unknown` is deliberately *not* doomed — it may yet turn out to be a member.
	 *
	 * On the leave path this also protects shutdown: `sendLeaveToNeighbors` runs inside `stop()`,
	 * where a stack of dials that can only fail delays the whole teardown.
	 */
	private isDoomedDial(id: string): boolean {
		if (!this.isDialable(id)) return true;
		const entry = this.store.getById(id);
		return entry?.membership === 'foreign' || entry?.state === 'dead';
	}

	/**
	 * Single choke point for outbound announces. Every announce target list is chosen to
	 * *prefer* non-connected peers (a connected peer learns via normal exchange), so this
	 * dials — and therefore has to be the place {@link isDoomedDial} is applied. Checked
	 * before the token bucket so a doomed target does not burn an announce token.
	 *
	 * Deliberately serial, unlike the pooled stabilization tick: the `break` on an empty bucket
	 * below *is* the rate limit, and pooling would take every token up front before the first
	 * announce completes.
	 */
	private async sendAnnouncementsRateLimited(ids: string[], snap: NeighborSnapshotV1): Promise<void> {
		const sig = this.runSignal;
		for (const id of ids) {
			// Both halves are load-bearing. `stopped` covers ordinary shutdown; the signal covers
			// the case `stopped` cannot see — a stop() + start() landing mid-loop, where `sig` is
			// the aborted controller of the run this loop belongs to while `stopped` is already
			// back to false, so the `cancelled` outcome below (checked against the *new* run's
			// signal state, not this loop's) cannot stand in for it.
			if (this.stopped || this.wasCancelled(sig)) break;
			if (this.isDoomedDial(id)) continue;
			if (!this.bucketAnnounce.tryTake()) { this.diag.announcementsSkipped++; break; }
			try {
				const out = await announceNeighbors(this.node, id, snap, this.protocols.PROTOCOL_NEIGHBORS_ANNOUNCE, {
					dial: true, signal: sig, timeoutMs: FretService.MAINTENANCE_RPC_TIMEOUT_MS,
				});
				if (out.kind === 'ok') this.diag.announcementsSent++;
				else if (out.kind !== 'cancelled') log.error('announce to %s failed: %s', id, out.kind);
			} catch (err) {
				// Reachable only for a malformed id (peerIdFromString throws inside rpcRequest).
				log.error('announce failed to %s - %e', id, err);
			}
		}
	}

	/**
	 * Target selection shared by the two ring-walking announce paths — {@link
	 * announceNeighborsBounded} (around self) and {@link announceOnDeparture} (around a departed
	 * coordinate). Two rules live here rather than being restated per caller, which is what stops
	 * them drifting; before this they were duplicated and a comment merely *promised* they matched.
	 *
	 * - The walk is **unfiltered**: a member-scoped walk would drop a freshly-connected peer that
	 *   is still `unknown`, stalling bootstrap before the classification pass can label it. Only
	 *   the snapshot *contents* are member-scoped.
	 * - Non-connected-but-addressable peers come **first**, because a connected peer learns the
	 *   same content through normal exchange. That preference is why the choke point dials, and
	 *   therefore why {@link isDoomedDial} is applied there rather than here.
	 */
	private announceTargetsAround(coord: Uint8Array, exclude: Set<string>, fanout: number): string[] {
		const all = Array.from(new Set([
			...this.store.neighborsRight(coord, this.cfg.m),
			...this.store.neighborsLeft(coord, this.cfg.m)
		])).filter((id) => !exclude.has(id));
		const nonConnected = all.filter((id) => !this.isConnected(id) && this.hasAddresses(id));
		const connected = all.filter((id) => this.isConnected(id));
		return [...nonConnected, ...connected].slice(0, fanout);
	}

	private async announceNeighborsBounded(maxCount?: number): Promise<void> {
		const selfCoord = await hashPeerId(this.node.peerId);
		const exclude = new Set([this.node.peerId.toString()]);
		const ids = this.announceTargetsAround(selfCoord, exclude, maxCount ?? this.announceFanout);
		if (ids.length === 0) return;
		await this.sendAnnouncementsRateLimited(ids, await this.snapshot());
	}

	/**
	 * Warm-up ping fan-out, shared by the two connection warm-up passes: the one-shot pass at
	 * `start()` ({@link preconnectNeighbors}) and the per-second active-mode tick in
	 * {@link startActivePreconnectLoop}. Both were serial dial chains — precisely what the *Active
	 * vs passive state* section of `docs/fret.md` says active mode exists to avoid — so both take
	 * the same treatment the stabilization tick did.
	 *
	 * - **Pooled at {@link maintenanceConcurrency}** (Core 6 / Edge 2), the same cap a tick uses.
	 * - **Against the run signal, not a tick deadline.** Neither pass runs inside `stabilizeOnce`,
	 *   so there is no tick budget to inherit; the per-ping {@link MAINTENANCE_RPC_TIMEOUT_MS}
	 *   bounds each task and `stop()` collapses the whole fan-out at once.
	 * - **`isDialable` is filtered before `budget` is applied**, not inside the task, so neither a
	 *   pool slot nor a slot of the caller's per-pass budget goes to a peer that can only fail to
	 *   dial. Filtering after the slice would let a run of undialable near peers consume the whole
	 *   budget and warm nobody, which is the opposite of what a warm-up pass is for.
	 *
	 * `pingsSent` counts only a ping that completed, as it did serially. Cancellation is not
	 * evidence: a task that fails under an aborted run logs nothing — these paths never scored
	 * anything, so the guard suppresses only the log line — and a task the pool never started is
	 * `skipped`, so an aborted run issues no dial at all.
	 *
	 * @param budget optional cap on how many peers this pass may target (the active tick's Core 6 /
	 *   Edge 3 per second). Distinct from the concurrency cap, which is how many may be in flight.
	 */
	private async pingWarmupTargets(ids: readonly string[], label: string, budget?: number): Promise<void> {
		// Captured before the tasks are built, so a mid-flight stop()+start() cannot change what
		// `wasCancelled` compares against — see `wasCancelled`.
		const sig = this.runSignal;
		const dialable = ids.filter((id) => this.isDialable(id));
		const targets = budget === undefined ? dialable : dialable.slice(0, budget);
		const results = await runPooled(targets.map((id) => async () => {
			try {
				const out = await sendPing(this.node, id, this.protocols.PROTOCOL_PING, { signal: sig, timeoutMs: FretService.MAINTENANCE_RPC_TIMEOUT_MS });
				switch (out.kind) {
					case 'ok': case 'busy': case 'decode-error':
						this.diag.pingsSent++; // parity: counted whenever the old sendPing *returned*
						return;
					case 'foreign-protocol': case 'unreachable': case 'timeout':
						log.error('%s ping failed for %s - %s', label, id, out.kind);
						return;
					case 'cancelled': case 'skipped':
						return;
				}
			} catch (err) {
				// Reachable only for a malformed id (peerIdFromString throws inside rpcRequest).
				log.error('%s ping failed for %s - %e', label, id, err);
			}
		}), { concurrency: this.maintenanceConcurrency, signal: sig });
		logRejected(results, targets, label);
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
			await this.pingWarmupTargets(ids, 'preconnectNeighbors');
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
			await this.activePreconnectTick();
			// Re-check after the awaits: a stop() during the tick must not re-arm the timer.
			if (this.stopped || gen !== this.runGen) { release(); return; }
			this.preconnectTimer = setTimeout(tick, 1000);
		};
		this.detach(tick(), 'active preconnect loop');
	}

	/**
	 * One active-mode warm-up pass: this profile's per-second budget of near peers, pooled through
	 * {@link pingWarmupTargets}. Separated from the loop that arms it so the pass is drivable on its
	 * own — the scheduling (generation guard, timer re-arm) and the work are different concerns, and
	 * the work is the part with behavior to pin.
	 *
	 * Never throws: the loop must re-arm even after a bad tick.
	 */
	private async activePreconnectTick(): Promise<void> {
		try {
			const selfCoord = await this.selfCoord();
			const selfStr = this.node.peerId.toString();
			const budget = this.cfg.profile === 'core' ? 6 : 3;
			// Unfiltered store walk (warm-up must reach unclassified peers; ring reads use getNeighbors).
			const ids = Array.from(new Set([
				...this.store.neighborsRight(selfCoord, Math.min(12, this.cfg.m)),
				...this.store.neighborsLeft(selfCoord, Math.min(12, this.cfg.m))
			])).filter((id) => id !== selfStr);
			await this.pingWarmupTargets(ids, 'active preconnect', budget);
		} catch (err) { log.error('active preconnect tick failed - %e', err) }
	}

	/**
	 * Replacement hints for a leave notice: the live members just outside our own S/P window,
	 * best-connected and most-relevant first.
	 *
	 * **Live-member-scoped, because this list goes on the wire.** It is the same
	 * transitive-propagation guard the outgoing snapshot's neighbor lists and sample carry: a
	 * departing node must not hand its neighbors peers it knows serve another network, or peers a
	 * run of failed contacts already marked dead. The recipient no longer dials these ids — it
	 * records them as untrusted `unknown` entries (`recordLeaveReplacements`) and lets its own
	 * classification pass vet them — but an unfiltered list still re-seeds a foreign peer into a
	 * same-network view that ring gating exists to keep it out of, and still spends the
	 * recipient's *probe* budget on peers we had already given up on. The filter is what stops
	 * a peer we abandoned from propagating through our departure.
	 *
	 * The *targets* of the notice (`sendLeaveToNeighbors`'s `ids`) stay unfiltered by contrast:
	 * that walk defines the S/P set this list excludes, not a list we advertise.
	 */
	private computeReplacements(selfCoord: Uint8Array, spNeighborIds: Set<string>, selfStr: string): string[] {
		const maxReplacements = 6;
		const wider = Array.from(new Set([
			...this.store.neighborsRight(selfCoord, this.cfg.m * 2, isLiveMember),
			...this.store.neighborsLeft(selfCoord, this.cfg.m * 2, isLiveMember),
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
		// Own budget, *not* `runSignal`: this runs after `stop()` aborted that signal, by design —
		// the graceful-departure notices must still go out. `SHUTDOWN_BUDGET_MS` caps the whole
		// fan-out; each notice gets `LEAVE_NOTICE_TIMEOUT_MS`; and both loops stop once the budget
		// is spent (otherwise every remaining `sendLeave` throws immediately and only logs noise).
		// `cancel()` in the `finally` is mandatory — an uncleared timer fails the mocha exit
		// watchdog (see `deadline`).
		const budget = deadline(FretService.SHUTDOWN_BUDGET_MS);
		const sendOpts = { signal: budget.signal, timeoutMs: FretService.LEAVE_NOTICE_TIMEOUT_MS };
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
				if (budget.signal.aborted) break;
				// Doomed dials are skipped, not attempted (see `isDoomedDial`): this runs inside
				// stop(), so a stack of dials that can only fail also delays shutdown.
				// (`ids` itself stays unfiltered — it defines the S/P set the replacements exclude.)
				if (this.isDoomedDial(id)) continue;
				// `ok` for a write-only send means only "reached the transport", not receipt; a
				// non-ok, non-cancelled outcome is worth a log line even though nothing is scored
				// during shutdown.
				try {
					const out = await sendLeave(this.node, id, notice, this.protocols.PROTOCOL_LEAVE, sendOpts);
					if (out.kind !== 'ok' && out.kind !== 'cancelled') log.error('sendLeave to %s: %s', id, out.kind);
				} catch (err) { log.error('sendLeave failed for %s - %e', id, err) }
			}
			// Bounded fan-out beyond S/P (connected peers only)
			const fanOut = this.cfg.profile === 'core' ? 4 : 2;
			const expanded = this.expandCohort(ids, selfCoord, fanOut, new Set([selfStr]));
			// No `isDoomedDial` here: everything outside `spSet` came from the live-member-scoped
			// `assembleCohort` inside `expandCohort`, and `isConnected` already implies dialable.
			const extra = expanded.filter((id) => !spSet.has(id) && this.isConnected(id)).slice(0, fanOut);
			for (const id of extra) {
				if (budget.signal.aborted) break;
				try {
					const out = await sendLeave(this.node, id, notice, this.protocols.PROTOCOL_LEAVE, sendOpts);
					if (out.kind !== 'ok' && out.kind !== 'cancelled') log.error('sendLeave fan-out to %s: %s', id, out.kind);
				} catch (err) { log.error('sendLeave fan-out failed for %s - %e', id, err) }
			}
		} catch (err) {
			log.error('sendLeaveToNeighbors outer failed - %e', err);
		} finally {
			budget.cancel();
		}
	}

	// NOTE: `registerJsonHandler` parses before `serve` runs, so `parseLeaveNotice` now precedes
	// this bucket — the leave parse is unmetered. Bounded on purpose: a leave body is capped at
	// 4096 bytes and the parser is O(message size) with no hashing, so the pre-filter costs at
	// most ~4 KB of pure parsing per message — cheaper than the `readFramed` this bucket never
	// metered either. Keep the bucket first *inside* this method; do not move it into the seam.
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
			await this.recordLeaveReplacements(notice.replacements, peerId);
			// One *debounced* announce per departure, shared with the `peer:disconnect` path. A
			// graceful departure fires both (the notice, then the disconnect that follows it);
			// routing both through `announceOnDeparture` collapses them into a single burst of at
			// most `announceFanout` per departed coordinate per DEPARTURE_DEBOUNCE_MS, instead of
			// the two undebounced fan-outs this path used to add on top.
			this.detach(this.announceOnDeparture(peerId, coord), 'announceOnDeparture(leave)');
		} catch (err) {
			log.error('handleLeave failed for %s - %e', peerId, err);
		}
	}

	/**
	 * Record a leave notice's suggested replacements as untrusted local hints — and nothing more.
	 *
	 * No ping, no neighbor fetch, no announce: an inbound leave notice is one small message and
	 * must not be amplifiable into a fan of outbound RPCs. The healing it used to attempt inline
	 * is already someone else's job, on a pass that is budgeted, backed off and ordered:
	 * {@link classifyTargets} selects exactly the entries inserted here (`unknown`, not
	 * `dead`, off backoff, dialable) on the next stabilization tick and promotes them to `member`
	 * on a successful ping, while a replacement that is locally `foreign` or `dead` is picked up
	 * by the matching {@link reprobeOffRingTargets} arm with its backoff intact. The cost is latency —
	 * healing within ≤ 1 tick rather than one RPC round trip — which the departing peer's own
	 * advance notice makes affordable.
	 *
	 * The list is already bounded at 12 and parse-checked by `sanitizeReplacements`
	 * (`src/rpc/validate.ts`), which is what bounds the local hash + upsert work below.
	 */
	private async recordLeaveReplacements(replacements: string[] | undefined, departedId: string): Promise<void> {
		if (!replacements || replacements.length === 0) return;
		const selfStr = this.node.peerId.toString();
		const seen = new Set<string>();
		for (const id of replacements) {
			// Skipping self is a correctness guard, not tidiness: were self ever absent from the
			// store, upserting it here would recreate it as `unknown` and drop self out of every
			// member-only ring view (see *Network-scoped admission* in `docs/fret.md`). Skipping
			// the departed peer stops us re-adding the one `handleLeave` just removed. Duplicates
			// inside one list collapse, so 12 copies of an id cost one hash and one upsert.
			if (id === selfStr || id === departedId || seen.has(id)) continue;
			seen.add(id);
			// `isDialable`, not `isDoomedDial`: we are not dialing, so `foreign` / `dead` are no
			// reason to drop the id — `upsert` preserves that state and the peer keeps its own
			// re-probe arm and backoff. But an id libp2p holds no address for can never be probed
			// by any pass, so inserting it would only pollute the table. This is also the bound on
			// table pollution: an attacker cannot add peerStore addresses for ids it invents.
			if (!this.isDialable(id)) continue;
			let coord: Uint8Array;
			try {
				coord = await hashPeerId(peerIdFromString(id));
			} catch (err) {
				// `sanitizeReplacements` already parse-checked these, so this is unreachable in
				// practice — but it must not throw out into the RPC handler.
				log.error('handleLeave: could not hash replacement id %s - %e', id, err);
				continue;
			}
			// Bare `upsert`, deliberately *no* `applyTouch` — unlike the two snapshot-merge paths
			// (`fetchAndMergeSnapshot` / `mergeAnnounceSnapshot`). `applyTouch` writes a
			// sparsity-weighted relevance score, and giving an attacker-named id a non-zero score
			// lets it outrank a genuine but not-yet-contacted peer when `enforceCapacity` evicts by
			// relevance. A replacement is a name we were handed, not a peer we contacted: it starts
			// at relevance 0 and earns a score once the classification pass actually reaches it.
			//
			// NOTE: on an id *already* in the store, `upsert` refreshes `lastAccess` (relevance,
			// health, state and membership are all preserved). `lastAccess` feeds the recency term
			// the next time that peer is scored, so naming a peer here nudges its future relevance
			// up a little without any contact having happened. Harmless today — eviction sorts on
			// relevance alone, and the nudge helps the *named* peer, not the namer. Revisit if
			// eviction ever sorts on `lastAccess`, or if the recency weight grows enough that a
			// repeat-named id could out-survive a genuine peer: the fix is a
			// `refreshLastAccess: false` upsert variant, not a filter here.
			this.store.upsert(id, coord);
			this.diag.leaveReplacementsRecorded++;
		}
		// Once, after the loop rather than per insert: `enforceCapacity` lists and fully sorts the
		// store.
		await this.enforceCapacity();
	}

	private async announceOnDeparture(departedId: string, coord: Uint8Array): Promise<void> {
		// Debounce: skip if we recently announced for this coordinate region. The map's TTL *is*
		// DEPARTURE_DEBOUNCE_MS, so presence is the whole test — no timestamp arithmetic, and no
		// inline prune loop, since the map sweeps on the stabilization tick and is capacity-bounded.
		const regionKey = coordToBase64url(coord);
		if (this.departureDebounce.has(regionKey)) return;
		this.departureDebounce.set(regionKey, Date.now());

		const exclude = new Set([this.node.peerId.toString(), departedId]);
		const targets = this.announceTargetsAround(coord, exclude, this.announceFanout);
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
	 * truth shared by the neighbor-fetch merge (`fetchAndMergeSnapshot`) and the inbound-announce
	 * merge (`mergeAnnounceSnapshot`). Bounds how many remote-supplied ids one message can force
	 * us to parse + SHA-256 hash + upsert, independent of the RPC byte limit.
	 *
	 * NOTE: the **parser is the single enforcement point**, not the merge loops. Both call sites
	 * take their caps from this one method — `makeSnapshotParser(this.mergeSnapshotCaps())` is
	 * passed to `registerNeighbors` in `registerRpcHandlers` (announce path) and as the `parse`
	 * option to `fetchNeighbors` in `fetchAndMergeSnapshot` (fetch path) — so a message is already
	 * truncated by the time either merge loop sees it. Neither loop slices: enforcing in two
	 * places is exactly how two copies of a cap drift apart, and the loops' own `try/catch` is a
	 * separate guard (a `base64urlToCoord` throw), not a cap. Do not re-add a slice; widen or
	 * narrow the numbers here and both paths follow.
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

			// Wire JSON is untrusted, so the declared `Record<string, unknown>` is a claim until
			// checked: a crafted announce can carry a string or an array here, and storing that
			// would hand `getMetadata` a value of a shape its type says is impossible.
			// NOTE: the accepted object is otherwise unbounded (one per authenticated sender,
			// capped only by the 128 KB message limit and the routing-table capacity); if
			// per-peer metadata ever shows up in memory profiles, cap its serialized size here.
			if (isPlainObject(snap.metadata)) {
				// Update metadata via store.update to avoid mutating frozen entries
				this.store.update(from, { metadata: snap.metadata });
			}

			// No cap here: the snapshot parser wired in at `registerRpcHandlers` already truncated
			// these lists to `mergeSnapshotCaps()`. A second slice would be a second copy of the
			// same bound — the drift this loop's caps were moved to the parser to prevent.
			for (const pid of [...(snap.successors ?? []), ...(snap.predecessors ?? [])]) {
				try {
					const coord = await hashPeerId(peerIdFromString(pid));
					if (!this.store.getById(pid)) discovered.push(pid);
					this.store.upsert(pid, coord);
					await this.applyTouch(pid, coord);
				} catch (err) {
					log.error('mergeAnnounceSnapshot: failed for %s - %e', pid, err);
				}
			}
			// merge sample if present — truncated and per-entry coord-vetted by the parser above,
			// so `base64urlToCoord` throws only on a parser-bypassed body; the try/catch also
			// covers `upsert` / `applyTouch`, which the parser says nothing about.
			for (const s of snap.sample ?? []) {
				try {
					const coord = base64urlToCoord(s.coord);
					if (!this.store.getById(s.id)) discovered.push(s.id);
					this.store.upsert(s.id, coord);
					await this.applyTouch(s.id, coord);
				} catch (err) { log.error('mergeAnnounceSnapshot sample upsert failed for %s - %e', s.id, err) }
			}
			// Calibrate local size estimator from snapshot's estimate
			this.calibrateSizeFromSnapshot(snap, from);
			await this.enforceCapacity();
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
			// NOTE: FretPeerDiscovery now feeds this loop — every member it emits becomes an
			// (address-less) peerStore entry, so the peerStore is no longer bounded by peers
			// libp2p learned on its own. It is still bounded by C=2048 via the FRET store the
			// emissions come from, which is why the sizing above still holds.
			const peers = await this.node.peerStore.all();
			// Rebuilt wholesale rather than merged, so a peer whose addresses the peerStore
			// dropped stops reading as dialable (see `addressKnown`).
			const addressKnown = new Set<string>();
			for (const p of peers) {
				try {
					const pidStr = p.id.toString();
					if (p.addresses.length > 0) addressKnown.add(pidStr);
					const coord = await hashPeerId(p.id);
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
				this.store.upsert(selfStr, coord);
				// Self always serves its own network.
				this.store.setMembership(selfStr, 'member');
			} catch (err) {
				console.error('failed to add self to store', err);
			}
			await this.enforceCapacity();
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
				this.store.upsert(id, coord);
				await this.applyTouch(id, coord);
			} catch (err) {
				console.warn('seedFromBootstraps failed for', bootstrapEntry, err);
			}
		}
		await this.enforceCapacity();
	}

	/**
	 * Max outbound maintenance RPCs in flight during a stabilization tick. Core 6 / Edge 2 — the
	 * pre-dial concurrency the *Operating profiles* section of `docs/fret.md` already states for
	 * each profile, reused rather than re-invented. Edge's 2 is deliberately conservative: an Edge
	 * tick under mass failure truncates on {@link STABILIZE_TICK_BUDGET_MS} more often than a Core
	 * one, which is the profile's stated posture ("fewer probes per window"), not an oversight.
	 */
	private get maintenanceConcurrency(): number {
		return this.cfg.profile === 'core' ? 6 : 2;
	}

	/**
	 * One stabilization tick: two pooled phases under one tick-wide budget.
	 *
	 * 1. For each near peer, ping **then** snapshot-fetch (`probeAndFetch`) — chained per peer,
	 *    pooled across peers. Then one `enforceCapacity` and one announce for everything the
	 *    merges saw for the first time; neither may run inside the pool (`enforceCapacity` sorts a
	 *    snapshot of the store and would over-evict if two ran concurrently; a per-task announce
	 *    would announce a peer once per task).
	 * 2. The classification and re-probe *targets* — each still selected under its own per-tick
	 *    budget and ordering (see `classifyTargets` / `reprobeExcludedTargets`; merging the
	 *    candidate lists would repeal the separate-budgets rule) — pooled together through
	 *    `probeMembership`.
	 *
	 * The four candidate sets are disjoint by construction (near = live member; classify =
	 * `unknown` non-dead; foreign arm = `foreign` non-dead; dead arm = `dead`), which is what makes
	 * pooling them safe against the lost-increment race on `applySuccess` / `applyFailure` (see the
	 * NOTE there); `test/stabilize-concurrency.spec.ts` asserts the disjointness rather than trusting
	 * it. Wall time is therefore on the order of the slowest single peer, bounded by the tick budget,
	 * rather than the sum of 14–20 round trips.
	 */
	private async stabilizeOnce(): Promise<void> {
		this.sweepBoundedMaps();
		const near = await this.nearProbeTargets();
		// `runSignal` is undefined before the first start(); `deadline` accepts that. `cancel()` in
		// the finally is mandatory — see `deadline`.
		const budget = deadline(FretService.STABILIZE_TICK_BUDGET_MS, this.runSignal);
		try {
			const pool = { concurrency: this.maintenanceConcurrency, signal: budget.signal };
			const merged = await runPooled(near.map((id) => () => this.probeAndFetch(id, budget.signal)), pool);
			logRejected(merged, near, 'probeAndFetch');
			const announced = fulfilledValues(merged).flat();
			await this.enforceCapacity();
			if (announced.length > 0) this.detach(this.announceToNewPeers(announced), 'announceToNewPeers');

			// Selecting phase-2 targets is three full store walks; the pool would only `skip` every
			// one of them once the budget has gone. This early return does not *cause* the skip —
			// phase 2 is behind a barrier on phase 1, and one phase-1 task's worst case (2 s ping +
			// 5 s fetch) already exceeds the 5 s tick budget, so a single stalled near peer starves
			// phase 2 for the whole tick. Tracked as `bug-tick-budget-starves-phase-two`.
			if (budget.signal.aborted) return;
			const targets = [...this.classifyTargets(), ...this.reprobeExcludedTargets()];
			const probed = await runPooled(targets.map((id) => () => this.probeMembership(id, budget.signal)), pool);
			logRejected(probed, targets, 'probeMembership');
		} finally {
			budget.cancel();
		}
	}

	/**
	 * The near peers a tick pings and snapshot-fetches: the dialable live members nearest self on
	 * either side, at most 4, in **ring order** (closest first) — deliberately not rotated like the
	 * other candidate lists. These are the peers ring correctness depends on most, so a truncated
	 * tick should skip the 4th-closest and never the immediate successor; it self-corrects next tick.
	 */
	private async nearProbeTargets(): Promise<string[]> {
		const selfStr = this.node.peerId.toString();
		const nearAll = this.getNeighbors(await this.selfCoord(), 'both', Math.max(2, this.cfg.m));
		return nearAll.filter((id) => id !== selfStr && this.isDialable(id)).slice(0, 4);
	}

	/**
	 * Ping `id`, then fetch and merge its neighbor snapshot — one pooled task per near peer.
	 *
	 * The two stay in this order *per peer*: `fetchNeighbors` is connection-only
	 * (`requireExisting`), so it returns an empty snapshot unless a connection already exists, and
	 * it is usually the preceding ping that opens one. Fusing them per peer preserves that
	 * dependency while the pool parallelises across peers — strictly better than the old "all
	 * pings, then all fetches", which lost it for any peer whose ping landed late.
	 *
	 * Returns the ids the merge saw for the first time, for the tick's single announce.
	 */
	private async probeAndFetch(id: string, signal: AbortSignal | undefined): Promise<string[]> {
		await this.probeNeighborLatency(id, signal);
		// A tick that ran out of budget mid-ping has nothing to fetch — and `fetchNeighbors` would
		// swallow the abort into an empty snapshot and count it as fetched.
		if (this.wasCancelled(signal)) return [];
		return this.fetchAndMergeSnapshot(id, signal);
	}

	/**
	 * Ping one near neighbor and score the outcome. `signal` is the tick budget (a child of the run
	 * signal) and is an explicit parameter rather than defaulted from `runSignal`, so no call site
	 * can silently fall back to the run signal and escape the tick budget — see `wasCancelled` for
	 * why the *caller's* signal is the discriminator.
	 */
	private async probeNeighborLatency(id: string, signal: AbortSignal | undefined): Promise<void> {
		try {
			const out = await sendPing(this.node, id, this.protocols.PROTOCOL_PING, { signal, timeoutMs: FretService.MAINTENANCE_RPC_TIMEOUT_MS });
			switch (out.kind) {
				case 'ok':
					this.diag.pingsSent++;
					if (out.value.ok) {
						await this.applySuccess(id, await this.coordOf(id), out.rttMs);
						this.diag.pingsOk++;
					} else {
						// The peer's own negative pong: alive and on our protocol — decay relevance
						// only, never a strike.
						this.noteAnsweredOnProtocol(id);
						await this.applyFailure(id, await this.coordOf(id));
						this.diag.pingsFail++;
					}
					return;
				case 'busy':
					// Deliberate NEW behavior: the near pass records backoff for busy alone; timeout
					// and unreachable still record none here (failure-recovery.spec pins that). Busy
					// is still an answer on our protocol, so membership and liveness are confirmed.
					this.diag.pingsSent++;
					this.diag.pingsFail++;
					this.noteAnsweredOnProtocol(id);
					this.recordBackoff(id);
					return;
				case 'decode-error':
					this.diag.pingsSent++;
					this.diag.pingsFail++;
					await this.noteRpcFailure(id, out); // decay only
					return;
				case 'foreign-protocol':
				case 'unreachable':
				case 'timeout':
					this.diag.pingsFail++;
					await this.noteRpcFailure(id, out);
					return;
				case 'cancelled':
				case 'skipped':
					return; // our own cancellation / never attempted: record nothing
			}
		} catch (err) {
			// Reachable only for a malformed id (peerIdFromString throws inside rpcRequest).
			log.error('probeNeighborLatency failed for %s - %e', id, err);
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
	 *
	 * `dead` unknowns are left to the dead arm of {@link reprobeOffRingTargets} so the two passes
	 * never probe the same peer in one tick; a successful probe there promotes membership anyway
	 * (`applySuccess` applies both the `rpc-success` signal and the resurrection).
	 *
	 * Selects and returns only — the probing is the tick's pooled second phase. Candidates are
	 * ordered by **ascending `lastAccess`** (least-recently-touched first) before the budget slice,
	 * so a tick truncated by its budget never starves the tail: a probed unknown either succeeds
	 * (`applySuccess` bumps `lastAccess`) or records backoff (dropping off this list until the
	 * window passes), so it rotates to the back with no extra bookkeeping. A fixed store order would
	 * re-derive the same head every tick — the discovery-scan starvation bug, re-introduced here.
	 */
	private classifyTargets(): string[] {
		const selfStr = this.node.peerId.toString();
		const budget = this.cfg.profile === 'core' ? 8 : 4;
		// NOTE: scans the whole store (O(table size)) every tick to find unknowns, even
		// once steady state has none — and the two `reprobeOffRingTargets` arms each scan it
		// again, so a tick is three full walks. Fine at C=2048; if capacity or tick rate grows
		// a lot, do one walk per tick and partition it into the three candidate sets.
		const unknown = this.store.list().filter(
			(e) => e.id !== selfStr && e.membership === 'unknown' && e.state !== 'dead'
				&& this.getBackoffPenalty(e.id) === 0
		);
		if (unknown.length === 0) return [];
		unknown.sort((a, b) => a.lastAccess - b.lastAccess);
		// Only peers we can actually reach are probeable; prefer connected over has-addresses.
		// (Stable sort, so each group keeps the ascending-`lastAccess` order.)
		const connected = unknown.filter((e) => this.isConnected(e.id));
		const reachable = unknown.filter((e) => !this.isConnected(e.id) && this.hasAddresses(e.id));
		return [...connected, ...reachable].slice(0, budget).map((e) => e.id);
	}

	/**
	 * Re-probe the two kinds of peer the ring views exclude, so an exclusion can never be a
	 * one-way door. Both arms share every mechanic below and differ only in which peers they
	 * pick and how many per tick, so they run through {@link reprobeOffRingTargets}.
	 *
	 * - **`foreign`** — a same-network peer *mislabeled* foreign (e.g. identify completed before
	 *   it registered our protocol handlers) is re-admitted by a successful namespaced ping.
	 *   Before ring-membership gating this self-healed for free (`probeNeighborLatency` pinged
	 *   near ring peers regardless of label); gating closed that path. The `peer:update` identify
	 *   path also re-admits, but only if the remote pushes an update, so this is the dependable
	 *   backstop.
	 * - **`dead`** — a peer marked dead by a run of failed contacts is out of every ring view, so
	 *   `stabilizeOnce` (which draws its probe targets from `getNeighbors`) never touches it
	 *   again. Without this arm a peer that recovers but never dials us and never forms a
	 *   connection stays dead until it is evicted at capacity — `upsert` preserves `state`, so
	 *   even a peerStore re-seed does not resurrect it — which is a black hole on a small ring.
	 *   A successful ping runs `applySuccess`, which both confirms membership and resurrects.
	 *
	 * **Separate budgets, not one merged candidate list**, so a large foreign population cannot
	 * starve dead recovery: the foreign arm is already near saturation at roughly 42 foreign
	 * peers by its own arithmetic (see the re-probe discussion in `docs/fret.md`), and a merged
	 * list would put every dead peer behind that queue.
	 */
	private reprobeExcludedTargets(): string[] {
		// No prune here: sweeping bookkeeping maps is not a probe pass's job, and
		// `sweepBoundedMaps` at the top of `stabilizeOnce` (this pass's only caller) already ran it
		// this tick.
		const budget = this.cfg.profile === 'core' ? 2 : 1;
		// Arms are disjoint by construction: a peer that is both foreign and dead belongs to the
		// dead arm alone, so no peer is probed twice in one tick. Recovering it there fixes both
		// labels at once, since `applySuccess` promotes membership and resurrects together.
		//
		// NOTE: the arms share one `backoffMap`, so a peer that accumulated backoff while foreign
		// carries it into the dead arm. Intended today — it is the same "don't hammer this peer"
		// budget, and the arms are disjoint so no peer is charged twice per tick. If the two ever
		// need independent cadence (e.g. dead recovery made more eager than foreign re-probing),
		// they need separate backoff maps, not just separate budgets.
		return [
			...this.reprobeOffRingTargets((e) => e.membership === 'foreign' && e.state !== 'dead', budget),
			...this.reprobeOffRingTargets((e) => e.state === 'dead', budget),
		];
	}

	/**
	 * Select one bounded re-probe arm's targets — peers matching `isCandidate` — the shared
	 * mechanics of both arms of {@link reprobeExcludedTargets}: off-backoff and reachable candidates
	 * only, least-backed-off first, at most `budget` per tick. Selects and returns only; the probing
	 * is the tick's pooled second phase.
	 *
	 * Bounded and self-limiting: every failed probe records a growing backoff (see
	 * {@link probeMembership}), so a peer that is genuinely foreign, or genuinely gone, is
	 * re-probed at most ~once per backoff window (doubling to a 32× cap) rather than every tick.
	 * That growing factor is also what rotates the list under tick truncation: a probed peer's
	 * factor grows, so it sorts behind the ones a truncated tick never reached.
	 */
	private reprobeOffRingTargets(isCandidate: (e: PeerEntry) => boolean, budget: number): string[] {
		const selfStr = this.node.peerId.toString();
		const candidates = this.store.list().filter(
			(e) => e.id !== selfStr && this.getBackoffPenalty(e.id) === 0 && isCandidate(e)
		);
		if (candidates.length === 0) return [];
		// Only reachable peers are probeable; prefer connected over has-addresses.
		// Within each group, probe the least-backed-off first: backoff factor is a proxy for
		// "how many times we already confirmed this exclusion", so a freshly-excluded peer
		// (factor 0/1) — the one most likely to be recoverable — is serviced before a
		// long-confirmed one (factor 32) rather than queueing behind it.
		const byBackoffFactor = (a: PeerEntry, b: PeerEntry): number =>
			(this.backoffMap.get(a.id)?.factor ?? 0) - (this.backoffMap.get(b.id)?.factor ?? 0);
		const connected = candidates.filter((e) => this.isConnected(e.id)).sort(byBackoffFactor);
		const reachable = candidates.filter((e) => !this.isConnected(e.id) && this.hasAddresses(e.id)).sort(byBackoffFactor);
		return [...connected, ...reachable].slice(0, budget).map((e) => e.id);
	}

	/**
	 * Probe a single peer with a namespaced ping. Success → `applySuccess`, which confirms
	 * membership *and* clears any contact-failure run, resurrecting a `dead` peer — which is what
	 * makes both arms of {@link reprobeExcludedTargets} recoveries rather than mere reclassification.
	 * Failures route through {@link noteRpcFailure} on the outcome variant — `foreign-protocol` is
	 * one more strike toward the negotiate-failure threshold (see `applyMembershipSignal`);
	 * `unreachable` / `timeout` count toward the dead-state run. Every failure backs off so we
	 * don't hammer an unreachable-but-connected peer every tick.
	 *
	 * `signal` is the tick budget (a child of the run signal), an explicit parameter for the same
	 * reason as on `probeNeighborLatency`.
	 */
	private async probeMembership(id: string, signal: AbortSignal | undefined): Promise<void> {
		try {
			const out = await sendPing(this.node, id, this.protocols.PROTOCOL_PING, { signal, timeoutMs: FretService.MAINTENANCE_RPC_TIMEOUT_MS });
			switch (out.kind) {
				case 'ok':
					this.diag.pingsSent++;
					if (out.value.ok) {
						await this.applySuccess(id, await this.coordOf(id), out.rttMs); // marks member, clears contact run
						this.diag.pingsOk++;
						this.clearBackoff(id);
					} else {
						// Negative pong: the reply is not usable, but it arrived on our namespaced
						// protocol, so it settles membership and liveness all the same. Back off
						// briefly — a peer answering `ok: false` has nothing to tell us yet.
						this.diag.pingsFail++;
						this.noteAnsweredOnProtocol(id);
						this.recordBackoff(id);
					}
					return;
				case 'busy':
				case 'decode-error':
					// Answered but unusable — back off, no strike. Same reasoning as the negative
					// pong: reply *contents* say nothing about which network the peer serves, and
					// reaching a reply at all proves it serves ours.
					this.diag.pingsSent++;
					this.diag.pingsFail++;
					this.noteAnsweredOnProtocol(id);
					this.recordBackoff(id);
					return;
				case 'foreign-protocol':
				case 'unreachable':
				case 'timeout':
					// Back off either way so the foreign re-probe (which exists to recover a
					// *mislabeled* same-network peer) does not hammer a genuinely-foreign peer. The
					// backoff grows exponentially (factor doubles each window, up to 32×) so probing
					// tapers toward ~once/32s.
					this.diag.pingsFail++;
					await this.noteRpcFailure(id, out);
					this.recordBackoff(id);
					return;
				case 'cancelled':
				case 'skipped':
					return; // no backoff — next tick probes fresh
			}
		} catch (err) {
			// Reachable only for a malformed id (peerIdFromString throws inside rpcRequest).
			log.error('probeMembership failed for %s - %e', id, err);
		}
	}

	/**
	 * Fetch one near neighbor's snapshot and merge it into the store. Returns the ids the merge saw
	 * for the first time; the caller (`stabilizeOnce`) does the one `enforceCapacity` and the one
	 * announce for the whole tick — neither belongs in a pooled task (see `stabilizeOnce`).
	 *
	 * NOTE: `fetchNeighbors` is connection-only (dial `'never'`), so for an address-known but
	 * non-connected peer it returns `skipped` — nothing attempted, nothing counted — and the
	 * preceding ping in `probeAndFetch` usually opens the connection anyway. Cancellation (stop()
	 * or the tick budget) surfaces as the `cancelled` outcome and likewise counts and scores
	 * nothing: our own cancellation is not evidence about the peer. `snapshotsFetched` counts only
	 * `ok` replies.
	 *
	 * NOTE: pooling makes concurrent scoring of one peer genuinely possible, in two ways — two near
	 * peers' snapshots naming the **same** third peer (`applyTouch` against `applyTouch`), and a
	 * snapshot naming a near peer another task is pinging (`applyTouch` against `applySuccess`).
	 * The tick's four candidate sets being disjoint does not cover the second: the ids a snapshot
	 * *names* are not one of those sets. Harmless either way — the fields the race can lose
	 * (`accessCount`, `successCount`) only feed a relevance score recomputed on every call (see the
	 * NOTE on `applySuccess`).
	 */
	private async fetchAndMergeSnapshot(id: string, signal: AbortSignal | undefined): Promise<string[]> {
		const announced: string[] = [];
		// Default (route-sized) budget: a snapshot is a real payload, not a ~50-byte ping.
		const out = await fetchNeighbors(this.node, id, this.protocols.PROTOCOL_NEIGHBORS, {
			signal,
			// The fetch path's single cap enforcement point — the merge loop below does not slice.
			// Truncating here puts the bound ahead of the parse-and-hash loop instead of inside it.
			parse: makeSnapshotParser(this.mergeSnapshotCaps()),
		});
		switch (out.kind) {
			case 'skipped':      // no connection — nothing attempted, count nothing
			case 'cancelled':    // our own cancellation — not evidence about the peer
				return announced;
			case 'busy':
			case 'decode-error':
				// Answered badly / refused: alive. Today's empty-snapshot path scored nothing — preserved.
				log.error('fetchNeighbors %s from %s', out.kind, id);
				return announced;
			case 'foreign-protocol': // reaches this path for the first time — classification now works here
			case 'unreachable':
			case 'timeout':
				await this.noteRpcFailure(id, out);
				return announced;
			case 'ok':
				break;
		}
		this.diag.snapshotsFetched++;
		const snap = out.value;
		// No cap here either: `parse` above is `makeSnapshotParser(this.mergeSnapshotCaps())`, so
		// the reply was already truncated before it was handed back. See `mergeSnapshotCaps`.
		for (const pid of [...(snap.successors ?? []), ...(snap.predecessors ?? [])]) {
			try {
				const coord = await hashPeerId(peerIdFromString(pid));
				if (!this.store.getById(pid)) announced.push(pid);
				this.store.upsert(pid, coord);
				await this.applyTouch(pid, coord);
			} catch (err) {
				console.warn('failed to merge neighbor', pid, err);
			}
		}
		for (const s of snap.sample ?? []) {
			try {
				const coord = base64urlToCoord(s.coord);
				if (!this.store.getById(s.id)) announced.push(s.id);
				this.store.upsert(s.id, coord);
				await this.applyTouch(s.id, coord);
			} catch (err) { log.error('fetchAndMergeSnapshot sample upsert failed for %s - %e', s.id, err) }
		}
		// Calibrate local size estimator from snapshot's estimate
		this.calibrateSizeFromSnapshot(snap, id);
		return announced;
	}

	// Snapshots
	private async snapshot(): Promise<NeighborSnapshotV1> {
		const selfCoord = await hashPeerId(this.node.peerId);
		// Size estimate, neighbors, and sample are all live-member-scoped so the snapshot we
		// advertise describes only this network's reachable peers — and never re-introduces a
		// foreign peer to same-network neighbors via the sample (the transitive-propagation
		// guard), nor advertises a peer we have already given up on as a neighbor.
		const { n, confidence } = estimateSizeAndConfidence(this.store, this.cfg.m, { filter: isLiveMember, selfCoord });
		const capSucc = this.cfg.profile === 'core' ? 12 : 6;
		const capPred = this.cfg.profile === 'core' ? 12 : 6;
		const capSample = this.cfg.profile === 'core' ? 8 : 6;
		const rawSucc = this.getNeighbors(selfCoord, 'right', this.cfg.m);
		const rawPred = this.getNeighbors(selfCoord, 'left', this.cfg.m);
		const successors = rawSucc.slice(0, capSucc);
		const predecessors = rawPred.slice(0, capPred);
		const selfStr = this.node.peerId.toString();
		const excludeIds = new Set([selfStr, ...successors, ...predecessors]);
		const sample = selectDiverseSample(this.store, selfCoord, this.sparsity, excludeIds, capSample, isLiveMember);
		let outMetadata = this.metadata;
		if (outMetadata) {
			const metadataCap = this.cfg.profile === 'core' ? MAX_SNAPSHOT_METADATA_BYTES_CORE : MAX_SNAPSHOT_METADATA_BYTES_EDGE;
			const metadataBytes = new TextEncoder().encode(JSON.stringify(outMetadata)).byteLength;
			if (metadataBytes > metadataCap) {
				log.error('snapshot metadata (%d bytes) exceeds %d byte cap for profile %s - omitting from outgoing snapshot', metadataBytes, metadataCap, this.cfg.profile);
				outMetadata = undefined;
			}
		}
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
			metadata: outMetadata,
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
		// Live-member-scoped: foreign, unclassified, and dead peers are never neighbors,
		// routing candidates, or cohort members for this network. The store walk skips
		// non-matches and keeps advancing, so a cluster of foreign or dead peers near the
		// coord can't starve the result.
		if (direction === 'right' || direction === 'both')
			ids.push(...this.store.neighborsRight(hashedCoord, wants, isLiveMember));
		if (direction === 'left' || direction === 'both')
			ids.push(...this.store.neighborsLeft(hashedCoord, wants, isLiveMember));
		return Array.from(new Set(ids)).slice(0, wants);
	}

	assembleCohort(hashedCoord: Uint8Array, wants: number, exclude?: Set<string>): string[] {
		return assembleCohortOverStore(this.store, hashedCoord, wants, exclude, isLiveMember);
	}

	/**
	 * Routing-candidate cohort: live-member-scoped **and** dialability-scoped, both applied as
	 * the ring walk's own predicate.
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
			(e) => isLiveMember(e) && this.isDialable(e.id)
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
	/**
	 * Fallback reply used only when `routeAct` throws unexpectedly, after the rate-limit token
	 * has already been taken and real routing work was attempted. The cheap validity guards
	 * (breadcrumb loop, timestamp, TTL, oversized payload) use {@link staticReject} instead —
	 * they run pre-bucket-adjacent and must not force a key hash plus two ring walks on every
	 * trivially-invalid message. Anchors here are still measured against the key coordinate,
	 * same as `buildNearAnchor` (see `test/pick-anchors.spec.ts`).
	 *
	 * NOTE: `estimated_cluster_size` / `confidence` are placeholders here — no consumer reads
	 * either field today. If one starts to, this must report the real estimate
	 * (`estimateSizeAndConfidence`) rather than the configured k and a flat 0.5.
	 */
	private async nearAnchorOnly(msg: RouteAndMaybeActV1, keyBytes?: Uint8Array): Promise<NearAnchorV1> {
		// `keyBytes` is supplied on the inbound-handler path, which validated and decoded the
		// key once; decoding here covers direct callers only.
		const coord = await hashKey(keyBytes ?? u8FromString(msg.key, 'base64url'));
		const right = this.getNeighbors(coord, 'right', this.cfg.m);
		const left = this.getNeighbors(coord, 'left', this.cfg.m);
		const anchors = this.pickAnchors([...right.slice(0, 3), ...left.slice(0, 3)], coord);
		return {
			v: 1,
			anchors,
			cohort_hint: Array.from(new Set([...right.slice(0, 2), ...left.slice(0, 2)])),
			estimated_cluster_size: this.cfg.k,
			confidence: 0.5,
		};
	}

	/**
	 * Up to two anchors for a NearAnchor reply: the candidates closest to `targetCoord`, which
	 * is always the *key's* hashed coordinate. Anchors invite the sender to resend its activity,
	 * so measuring from anything else (self, or the all-zero vector this once used) returns peers
	 * near an unrelated point and the resend lands outside the key's cluster.
	 */
	private pickAnchors(candidates: string[], targetCoord: Uint8Array): string[] {
		const unique = Array.from(new Set(candidates));
		if (unique.length === 0) return [];
		const linkQ = (_id: string) => 0.5; // neutral until reputation is enabled
		const first = chooseNextHop(this.store, targetCoord, unique, (id) => this.isConnected(id), linkQ);
		const rest = unique.filter((id) => id !== first);
		const second = chooseNextHop(this.store, targetCoord, rest, (id) => this.isConnected(id), linkQ);
		return [first, second].filter((x): x is string => Boolean(x));
	}

	/**
	 * The doc's local membership test: self is in-cluster for a message when it appears among the
	 * first `window` entries of the key's alternating two-sided cohort.
	 *
	 * `wants` is the caller's staged/partial-cohort ask and is capped at `want_k`, per the wire
	 * contract (`wants ≤ k`), so a malformed message cannot widen the window past the cluster the
	 * sender asked for.
	 *
	 * The floor of 2 keeps both key-adjacent anchors acting even for a degenerate `want_k` of 0 or
	 * 1; without it nobody would consider itself in-cluster and the message would forward until TTL
	 * ran out.
	 *
	 * NOTE: want_k is caller-supplied and sizes this walk; bounded today only by the store size
	 * (C = 2048). If inbound maybeAct ever needs a tighter per-message cost bound, clamp want_k to
	 * a profile maximum here.
	 */
	private inClusterWindow(msg: RouteAndMaybeActV1): number {
		const k = msg.want_k ?? this.cfg.k;
		return Math.max(2, Math.min(msg.wants ?? k, k));
	}

	async routeAct(msg: RouteAndMaybeActV1, keyBytes?: Uint8Array): Promise<NearAnchorV1 | { commitCertificate: string }> {
		// `keyBytes` is supplied on the inbound-handler path, which validated and decoded the
		// key once; decoding here covers direct callers (public API, tests).
		const coord = await hashKey(keyBytes ?? u8FromString(msg.key, 'base64url'));
		const selfId = this.node.peerId.toString();
		const { n, confidence } = estimateSizeAndConfidence(this.store, this.cfg.m, {
			filter: isLiveMember,
			selfCoord: await this.selfCoord()
		});

		// In-cluster test: `neighborDistance` returns Infinity when self is absent from a cohort of
		// that size, so the comparison is exactly "self appears among the first `clusterWindow`
		// entries".
		// Deliberately wider than the two key-adjacent anchors: `shouldIncludePayload` attaches an
		// activity because the sender judged us near enough to act, so a cluster member that
		// forwards spends a hop the sender never budgeted for.
		const clusterWindow = this.inClusterWindow(msg);
		const inCluster = this.neighborDistance(selfId, coord, clusterWindow) < clusterWindow;

		if (inCluster) {
			// In-cluster with activity → perform via callback
			if (msg.activity && this.activityHandler) {
				// Deliberately `want_k`-wide, not `clusterWindow`-wide: the cohort exists to gather
				// `min_sigs` signatures and `min_sigs` derives from the full k, so `wants` narrows
				// *who acts*, not *how many peers the actor gathers*.
				const cohort = this.assembleCohort(coord, msg.want_k ?? this.cfg.k);
				const result = await this.activityHandler(
					msg.activity, cohort, msg.min_sigs, msg.correlation_id
				);
				return result;
			}
			// In-cluster without activity → return NearAnchor inviting resend. An activity-bearing
			// message with no handler installed lands here too, as a refusal.
			// NOTE: an in-cluster node refuses rather than forwarding, so the widened window grows
			// the set of peers that can strand an activity from 2 to `clusterWindow`. Harmless
			// while a network installs the handler on every node or none. If a deployment ever runs
			// a mixed population, forward instead of refusing when `msg.activity` is set and no
			// handler exists.
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

			const hopOpts = this.buildNextHopOptions(n, confidence, await this.selfCoord());
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
				// Default (route) budget — this returns only once the whole downstream route has
				// completed — but still run-scoped, so a stop() mid-forward does not hold teardown.
				const sig = this.runSignal;
				try {
					this.diag.maybeActForwarded++;
					const out = await sendMaybeAct(this.node, next, fwd, this.protocols.PROTOCOL_MAYBE_ACT, { signal: sig });
					switch (out.kind) {
						case 'ok': {
							const nextCoord = await this.coordOf(next);
							// No latency sample: `sendMaybeAct` on the forward path returns only once
							// the *entire remaining route* has completed downstream, so its wall time
							// is the cost of the whole subtree, not of the link to `next`. Recording
							// it would penalize a perfectly healthy adjacent hop for a long path
							// behind it. Latency belongs to the ping paths, which measure one hop.
							await this.applySuccess(next, nextCoord);
							this.clearBackoff(next);
							return out.value;
						}
						case 'busy':
							this.recordBackoff(next);
							break;
						case 'cancelled':
						case 'skipped':
							// Our own cancellation is not evidence about `next` — score nothing and
							// fall through to the NearAnchor below, the honest "did not forward"
							// answer. (`skipped` is unreachable here — maybeAct dials — and scores
							// the same nothing.)
							break;
						case 'foreign-protocol':
						case 'unreachable':
						case 'timeout':
						case 'decode-error':
							// A failed negotiation hints this hop belongs to another network, but
							// `next` came from the member-gated cohort, so it is a confirmed member
							// and a restart looks identical. Count the evidence; only a run of them
							// demotes, and only unreachable/timeout count toward the dead-state run.
							log.error('forward maybeAct to %s: %s', next, out.kind);
							await this.noteRpcFailure(next, out);
							this.recordBackoff(next);
							break;
					}
				} catch (err) {
					// Reachable only for a malformed id (peerIdFromString throws inside rpcRequest).
					log.error('forward maybeAct failed to %s - %e', next, err);
				}
			}
		}

		// Fallback: return NearAnchor with best hints
		return this.buildNearAnchor(coord, n, confidence);
	}

	private buildNearAnchor(coord: Uint8Array, n: number, confidence: number): NearAnchorV1 {
		const right = this.getNeighbors(coord, 'right', this.cfg.m);
		const left = this.getNeighbors(coord, 'left', this.cfg.m);
		const anchors = this.pickAnchors([...right.slice(0, 4), ...left.slice(0, 4)], coord);
		return {
			v: 1,
			anchors,
			cohort_hint: Array.from(new Set([...right.slice(0, 4), ...left.slice(0, 4)])),
			estimated_cluster_size: Math.max(this.cfg.k, n),
			confidence,
		};
	}

	/**
	 * `selfCoord` is supplied only when *forwarding* someone else's message, so near-mode
	 * selection can require a hop strictly closer to the key than we are.
	 *
	 * It is deliberately omitted when we *originate* a lookup: an originating node aims at the
	 * key's cluster — the k peers around the key, spanning both sides — not the key point, so
	 * an originator that is itself the peer nearest the key must still contact a cluster member,
	 * and every one of them is farther from the key than it is. Filtering there prevents no loop
	 * (`iterativeLookup`'s `visited` set does that) and only refuses to send, silently dropping
	 * the activity. `test/iterative-lookup.spec.ts` pins that down. See "Next-hop selection
	 * heuristic" in `docs/fret.md` for the full argument.
	 */
	private buildNextHopOptions(sizeEstimate: number, confidence: number, selfCoord?: Uint8Array): NextHopOptions {
		return {
			nearRadius: computeNearRadius(sizeEstimate, this.cfg.k),
			selfCoord,
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
		// Absent *or* retention-expired both read as `undefined` here, and both mean the same
		// thing: this peer's escalation is forgotten, so the next window starts at factor 1.
		const existing = this.backoffMap.get(id);
		const factor = existing ? Math.min(existing.factor * 2, FretService.BACKOFF_MAX_FACTOR) : 1;
		// The `set` also restarts the retention window, so retention is measured from the last
		// failure rather than from the first — see BACKOFF_RETAIN_MS.
		this.backoffMap.set(id, { until: Date.now() + FretService.BACKOFF_BASE_MS * factor, factor });
	}

	private clearBackoff(id: string): void {
		this.backoffMap.delete(id);
	}

	private getBackoffPenalty(id: string): number {
		const bo = this.backoffMap.get(id);
		if (!bo) return 0;
		if (bo.until < Date.now()) return 0; // window over, entry retained so factor grows on the next recordBackoff
		return Math.min(1, bo.factor / FretService.BACKOFF_MAX_FACTOR);
	}

	/**
	 * Drop backoff entries for peers that have left the store.
	 *
	 * **Orthogonal to expiry, not a duplicate of it**: a peer evicted from the routing table may
	 * still be well inside its retention window, and no TTL can see that it is gone. Walks the
	 * key *snapshot* `ExpiringMap.keys()` returns, so deleting while iterating is safe.
	 */
	private pruneBackoffMap(): void {
		for (const id of this.backoffMap.keys()) {
			if (!this.store.getById(id)) this.backoffMap.delete(id);
		}
	}

	/**
	 * Periodic tidy-up for the two capacity-bounded bookkeeping maps.
	 *
	 * Both are hard-capped at construction, so this is not what keeps them bounded — it is what
	 * keeps them bounded by *live* population rather than by peak, since an expired entry occupies
	 * a slot until something removes it. Called once per stabilization tick;
	 * `FretPeerDiscovery` sweeps its own map on its own interval (it is constructed before the
	 * libp2p node, and therefore before this service exists, so a single shared sweep is not
	 * available to it).
	 */
	private sweepBoundedMaps(): void {
		this.backoffMap.sweep();
		this.departureDebounce.sweep();
		this.pruneBackoffMap();
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
		// This method is public and callable before `start()` has hashed the self coordinate;
		// when it is not yet populated the estimator falls through to its whole-store path.
		const fretEstimate = estimateSizeAndConfidence(this.store, this.cfg.m, {
			filter: isLiveMember,
			selfCoord: this.cachedSelfCoord ?? undefined
		});

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

		// Weight recent observations more heavily with exponential decay. Two different
		// denominators are in play and mixing them up is what made the reported confidence
		// collapse: `size_estimate` is weighted by recency × confidence (a confident, recent
		// observation should dominate the size), while the average confidence is weighted by
		// recency *only* — dividing a recency-weighted numerator by an unweighted count drags
		// the result toward zero as observations age even when every one of them agrees.
		let totalWeight = 0;
		let weightedSum = 0;
		let confidenceSum = 0;
		let recencySum = 0;

		for (const obs of allObservations) {
			const age = now - obs.timestamp;
			const recencyWeight = Math.exp(-age / (this.observationWindowMs / 3));
			const weight = recencyWeight * obs.confidence;

			weightedSum += obs.estimate * weight;
			confidenceSum += obs.confidence * recencyWeight;
			recencySum += recencyWeight;
			totalWeight += weight;
		}

		// Reachable when every observation carries confidence 0 (the local FRET estimate is
		// always present, so an *empty* observation set is not).
		if (totalWeight === 0 || recencySum === 0) {
			return { size_estimate: 0, confidence: 0, sources: 0 };
		}

		const estimate = Math.round(weightedSum / totalWeight);
		const avgConfidence = confidenceSum / recencySum;

		return {
			size_estimate: estimate,
			confidence: Math.min(1, avgConfidence),
			// Observations contributing, not distinct observers: repeated snapshots from one
			// peer each add an entry. Diagnostic only — nothing branches on it.
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

	/**
	 * A correlation id for one *phase* of a lookup — see {@link dedupKey} for why a phase, and
	 * not a whole lookup, is the unit a receiver deduplicates on.
	 *
	 * `phase` is appended so the two ids of a single lookup are distinct by construction rather
	 * than by the randomness. A receiver never parses it; it reads the phase off the message's
	 * own `activity` field, which is the part it can actually trust.
	 *
	 * The random part comes from {@link randomToken}, not `Math.random`, so an observer of our
	 * ids cannot compute the next one and pre-poison a peer's dedup cache with an answer for a
	 * request we have not sent yet. The self-id and timestamp prefixes are traceability only and
	 * need not be secret.
	 */
	private newCorrelationId(phase: 'digest' | 'act'): string {
		return `${this.node.peerId.toString()}-${Date.now()}-${randomToken()}-${phase}`;
	}

	async *iterativeLookup(key: Uint8Array, options: LookupOptions): AsyncGenerator<RouteProgress> {
		const coord = await hashKey(key);
		const selfId = this.node.peerId.toString();
		const selfCoord = await this.selfCoord();
		const ttl = options.ttl ?? 8;
		const maxAttempts = options.maxAttempts ?? ttl + 2;
		// One id per phase, each minted once for the whole lookup and shared across every hop
		// and attempt of that phase. Per-*call* is the load-bearing part: a peer that already
		// performed the work recognises a repeated activity send and returns its stored
		// certificate, and a digest probe that loops around the ring is recognised as a replay.
		// Minting a fresh id per message would destroy both. Splitting the two phases is what
		// stops the probe's reply from being served as the answer to the activity (see
		// `dedupKey`).
		const discoveryId = this.newCorrelationId('digest');
		const activityId = this.newCorrelationId('act');
		// One run signal for the whole walk (see `wasCancelled`): a stop() mid-lookup cancels the
		// in-flight send, and the failure it produces is not scored against the target.
		const sig = this.runSignal;

		let hop = 0;
		let currentActivity = options.activity;
		let bestAnchors: string[] = [];
		// Every peer this walk has already contacted, across attempts. An anchor list that keeps
		// naming a peer we already probed would otherwise send the next attempt straight back to
		// it: the reply is valid (so nothing throws, and nothing is dropped from the pool) but
		// carries no new information, and the walk spins until `maxAttempts` runs out. Seeded
		// with self, which is never a hop.
		const visited = new Set<string>([selfId]);

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const { n, confidence } = estimateSizeAndConfidence(this.store, this.cfg.m, { filter: isLiveMember, selfCoord });

			// Decide whether to include payload
			const distToKey = minDistance(selfCoord, coord);
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
			// `visited` goes *into* the local walk rather than filtering its result, for the same
			// reason the breadcrumb trail does (see `dialableCohort`): post-filtering a sized
			// cohort shrinks it below the requested count.
			// NOTE: `isDialable` is also what makes the bare `await sendMaybeAct` below unable to
			// throw. `rpcRequest` throws for one caller bug — `peerIdFromString` on a malformed id
			// — and these ids are remote-supplied (`NearAnchorV1.anchors`), parse-unchecked by
			// `parseNearAnchor`. They survive only via `addressKnown` (built from real peerStore
			// ids) or `isConnected` (which swallows the parse error), so an unparseable anchor id
			// never reaches the send. If `isDialable` ever gains the peer-routing fallback its own
			// NOTE contemplates, restore a `try`/`catch` here and at the activity resend, or
			// parse-check anchor ids in `parseNearAnchor`.
			const anchorCandidates = bestAnchors.filter((id) => !visited.has(id) && this.isDialable(id));
			const candidates = anchorCandidates.length > 0
				? anchorCandidates
				: this.dialableCohort(coord, Math.max(4, this.cfg.m), visited);

			if (candidates.length === 0) {
				yield { type: 'exhausted', hop };
				return;
			}

			// No self coordinate: we are originating, not forwarding. See `buildNextHopOptions`.
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

			visited.add(target);
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
				// The heuristic may put the payload on this very message, which makes it an
				// activity-bearing message and so part of the activity phase — it must carry the
				// same id the resend below would, or the two paths disagree about which id names
				// the work.
				correlation_id: includePayload ? activityId : discoveryId,
				timestamp: Date.now(),
				signature: '',
			};

			const out = await sendMaybeAct(this.node, target, msg, this.protocols.PROTOCOL_MAYBE_ACT, { signal: sig });

			if (out.kind === 'busy') {
				// NOTE: `target` is already in `visited`, so a busy peer is retired for the rest
				// of this lookup rather than retried. Free today — the attempt loop has no delay,
				// so an immediate retry would meet the same empty token bucket. If the walk ever
				// honours `retry_after_ms` with a real wait, keep busy responders out of
				// `visited` so the wait can pay off.
				this.recordBackoff(target);
				continue;
			}
			if (out.kind === 'cancelled' || out.kind === 'skipped') {
				// A cancelled walk is `exhausted`, not a strike against `target`; burning the
				// remaining attempts would only meet the same aborted signal. (`skipped` is
				// unreachable here — maybeAct dials — and scores the same nothing.)
				break;
			}
			if (out.kind !== 'ok') {
				// foreign-protocol / unreachable / timeout / decode-error: route the evidence.
				// decode-error is proof of life — `noteRpcFailure` decays only, no contact strike.
				log.error('iterativeLookup hop %d to %s: %s', hop, target, out.kind);
				await this.noteRpcFailure(target, out);
				this.recordBackoff(target);
				// No need to drop `target` from `bestAnchors` — it is in `visited`, which every
				// candidate path filters against.
				hop++;
				continue;
			}

			{
				const result = out.value;
				if ('commitCertificate' in result) {
					yield { type: 'complete', hop, result, peerId: target };
					return;
				}

				// NearAnchor response — `out.value` narrows the union; no cast.
				const anchor = result;
				yield { type: 'near_anchor', hop, nearAnchor: anchor, peerId: target };

				// If we have activity but didn't include it, resend with activity to the anchor.
				// The anchors are remote-supplied ids we may hold no address for, so take the
				// first *dialable* one; when none is, fall through to the bestAnchors update
				// below and let the next iteration route locally instead of failing a dial.
				// Deliberately not filtered against `visited`: the anchor we resend to is normally
				// the peer we just probed (it named itself, being in-cluster), and that resend is
				// the point of the two-phase flow rather than a repeat of the probe.
				// NOTE: so the same peer can be an activity target on more than one attempt. Free
				// today — every activity send of a lookup shares one id, so a repeat is answered
				// from that peer's cache without re-performing the work, and `visited` still
				// bounds the probe phase. If activity delivery ever needs to try *successive*
				// anchors rather than the first dialable one, give the resend its own attempted
				// set rather than reusing `visited`.
				const actTarget = currentActivity && !includePayload
					? anchor.anchors.find((id) => this.isDialable(id))
					: undefined;
				if (actTarget) {
					visited.add(actTarget);
					yield { type: 'activity_sent', hop: hop + 1, peerId: actTarget };

					const actMsg: RouteAndMaybeActV1 = {
						...msg,
						activity: currentActivity,
						// `...msg` carries the probe's id; this message is the activity phase, so
						// override it. Sharing the probe's id is what made the receiver answer
						// this message from the probe's cache entry and never run the activity.
						correlation_id: activityId,
						ttl: 1,
						// Breadcrumbs are the peers this *message* has already passed through, and
						// the receiver rejects any message whose trail names itself. The resend's
						// destination is normally `target` — the peer that just named itself as an
						// anchor, which is the whole point of the two-phase flow — so listing
						// `target` unconditionally makes the receiver refuse its own resend as a
						// loop and the activity is silently never performed. Keep `target` only
						// when it is a *different* peer, where it is a genuine "don't bounce back"
						// hint. Invariant: a message never carries its own destination.
						breadcrumbs: [selfId, target].filter((id) => id !== actTarget),
					};

					const actOut = await sendMaybeAct(
						this.node, actTarget, actMsg, this.protocols.PROTOCOL_MAYBE_ACT, { signal: sig }
					);
					if (actOut.kind === 'busy') {
						this.recordBackoff(actTarget);
					} else if (actOut.kind === 'cancelled' || actOut.kind === 'skipped') {
						// Our own cancellation: score nothing and end the walk (`exhausted` below)
						// rather than spend the remaining attempts on sends that cannot go out.
						break;
					} else if (actOut.kind !== 'ok') {
						// foreign-protocol / unreachable / timeout / decode-error: route the
						// evidence; decode-error decays only, no contact strike.
						log.error('activity send to anchor %s: %s', actTarget, actOut.kind);
						await this.noteRpcFailure(actTarget, actOut);
						this.recordBackoff(actTarget);
					} else if ('commitCertificate' in actOut.value) {
						yield { type: 'complete', hop: hop + 1, result: actOut.value, peerId: actTarget };
						return;
					} else {
						bestAnchors = actOut.value.anchors;
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
			}
		}

		// NOTE: `exhausted` conflates two different outcomes — "the ring offered no further hop" and
		// "our own run was cancelled under the walk" (the two `cancelled`-outcome breaks above land here).
		// A caller therefore cannot tell a genuinely exhausted lookup from one whose activity was
		// never delivered because `stop()` landed mid-walk. Deliberate: `RouteProgress` is part of
		// the public `FretService` interface, so a `{ type: 'cancelled' }` variant is an API change
		// every consumer would have to learn, well beyond what the cancellation-evidence rule needs.
		// A caller that must distinguish them already holds the discriminating fact — it owns the
		// signal it cancelled. Revisit if a consumer ever needs the distinction without owning that
		// signal.
		yield { type: 'exhausted', hop };
	}

	setMetadata(metadata: Record<string, unknown>): void {
		this.metadata = metadata;
	}

	getMetadata(peerId: string): Record<string, unknown> | undefined {
		const entry = this.store.getById(peerId);
		return entry?.metadata;
	}

	listPeers(): Array<{ id: string; metadata?: Record<string, unknown> }> {
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

	async importTable(table: SerializedTable): Promise<number> {
		// A snapshot never speaks for *self*. Import replaces by id, and both fields that make
		// self's entry authoritative are supplied by the snapshot: `membership` (absent in a
		// pre-membership snapshot, and `unknown` in one taken by another peer, which would drop
		// self out of every member-only ring view) and `coord` (a wrong one moves self off its
		// own ring position, so capacity enforcement no longer protects it). Both would heal on
		// the next stabilization tick's peer-store re-seed, but dropping self's record is one
		// rule instead of two repairs — and the local entry is better information regardless.
		// The count therefore reports ids actually stored, self excluded.
		const selfStr = this.node.peerId.toString();
		const count = this.store.importEntries(table.entries.filter((e) => e.id !== selfStr));
		await this.enforceCapacity();
		return count;
	}
}

/** The values of the fulfilled results of a pool run; rejected and skipped tasks contribute nothing. */
function fulfilledValues<T>(results: ReadonlyArray<PoolResult<T>>): T[] {
	return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

/**
 * Log every task of a pooled maintenance run that rejected — the stabilization tick's two phases
 * and the warm-up fan-out alike. Each pooled task catches its own RPC failures, so a rejection here
 * is a bug in the task's bookkeeping, not evidence about the peer — logged, never scored, and never
 * fatal to the rest of the pass (the pool isolates it). It used to surface as `stabilize tick
 * failed:` and abort the serial walk; the pool must not turn that into silence. Results are
 * index-aligned with `ids`.
 */
function logRejected(results: ReadonlyArray<PoolResult<unknown>>, ids: readonly string[], label: string): void {
	results.forEach((r, i) => {
		if (r.status === 'rejected') log.error('%s failed for %s - %e', label, ids[i], r.reason);
	});
}
