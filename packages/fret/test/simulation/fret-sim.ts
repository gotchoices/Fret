import { DeterministicRNG } from './deterministic-rng.js'
import { EventScheduler, type SimEvent } from './event-scheduler.js'
import { MetricsCollector, type SimMetrics } from './sim-metrics.js'
import { SimMessageBus, type MessageBusConfig, type SimMessage } from './message-bus.js'
import { CoordPlacement, type ClusterConfig, type PlacementStrategy } from './placement.js'
import { PartitionModel } from './reachability.js'
import { LivenessModel, notDead } from './liveness.js'
import { SimMeasurement } from './measurement.js'
import { DigitreeStore } from '../../src/store/digitree-store.js'
import {
	createSparsityModel,
	initialRelevance,
	normalizedLogDistance,
	observeDistance,
	touch,
} from '../../src/store/relevance.js'
import type { SparsityModel } from '../../src/store/relevance.js'
import { chooseNextHop } from '../../src/selector/next-hop.js'
import { ringNeighborsBothSides } from '../../src/ring/ring-walk.js'
import { toCoord } from '../helpers/ring.js'

// Re-exported so spec imports keep coming from this module (a re-export does not bring the
// names into local scope — the import above does that for SimConfig's own fields).
export type { PlacementStrategy, ClusterConfig } from './placement.js'

export interface SimPeerConfig {
	profile: 'edge' | 'core'
	// NOTE: only successors/predecessors caps are enforced in the harness — the sim does
	// not yet emit the sparsity-weighted `sample` portion of a snapshot, so `sample` is
	// carried for parity with the real profiles but is otherwise inert here. If the sim
	// starts seeding via samples, enforce this cap in collectSnapshotEntries.
	snapshotCap: { successors: number; predecessors: number; sample: number }
	stabilizationIntervalMs: number
	maxConnections: number
}

export const EDGE_PROFILE: SimPeerConfig = {
	profile: 'edge',
	snapshotCap: { successors: 6, predecessors: 6, sample: 6 },
	stabilizationIntervalMs: 2000,
	maxConnections: 4,
}

export const CORE_PROFILE: SimPeerConfig = {
	profile: 'core',
	snapshotCap: { successors: 12, predecessors: 12, sample: 8 },
	stabilizationIntervalMs: 500,
	maxConnections: 12,
}

export interface ProfileMix {
	edge: number
	core: number
}

export interface SimPeer {
	id: string
	coord: Uint8Array
	alive: boolean
	connected: Set<string>
	neighbors: Set<string>
	profileConfig: SimPeerConfig
}

export interface SimConfig {
	seed: number
	n: number // initial peers
	k: number // cluster size
	m: number // neighbors (S/P set size)
	/**
	 * Churn events per second. Each event is a *paired* departure and arrival: one peer
	 * picked from the currently-alive population leaves, and one fresh peer joins, so the
	 * population stays stationary — matching this field's "peers leaving/joining per second"
	 * meaning. Leave-only churn made every threshold measured at a non-zero rate a
	 * measurement of population collapse rather than of behavior under churn.
	 */
	churnRatePerSec: number
	stabilizationIntervalMs: number
	durationMs: number
	messageBus?: MessageBusConfig
	placement?: PlacementStrategy
	clusterConfig?: ClusterConfig
	capacity?: number // max store entries per peer
	profileMix?: ProfileMix
	/** Consecutive failed contacts before an entry is marked dead (default 3, as production). */
	deadAfterFailures?: number
	/** Dead entries each peer re-probes per stabilization tick (default 2, as production's dead arm). */
	deadReprobePerTick?: number
}

/**
 * The deterministic simulation harness: event dispatch and scheduling, the stabilize tick,
 * snapshot exchange (bus and direct), churn/join/leave, capacity eviction, and routing —
 * composing the focused modules beside it: coordinate placement (`CoordPlacement`), the
 * partition oracle (`PartitionModel`), contact-failure escalation (`LivenessModel`), and
 * ring-health measures (`SimMeasurement`).
 */
export class FretSimulation {
	private readonly rng: DeterministicRNG
	readonly scheduler: EventScheduler
	readonly metrics: MetricsCollector
	private readonly config: SimConfig
	private readonly peers = new Map<string, SimPeer>()
	private readonly stores = new Map<string, DigitreeStore>()
	// One sparsity (KDE) model **per peer**: a shared model would make every peer's sparsity
	// bonus a function of every other peer's observations. The model consumes no RNG, so it
	// cannot perturb same-seed replay (pinned by simulation.partition.spec.ts). A departed peer
	// keeps its model entry, same memory note `handleLeave` carries for `stores`.
	private readonly models = new Map<string, SparsityModel>()
	private readonly bus: SimMessageBus | undefined
	private nextPeerIndex: number
	private readonly lastStabilized = new Map<string, number>()
	private readonly placement: CoordPlacement
	private readonly partitionModel: PartitionModel
	private readonly liveness: LivenessModel
	private readonly measurement: SimMeasurement

	constructor(config: SimConfig) {
		this.config = config
		this.rng = new DeterministicRNG(config.seed)
		this.scheduler = new EventScheduler()
		this.metrics = new MetricsCollector()
		this.nextPeerIndex = config.n

		if (config.messageBus) {
			this.bus = new SimMessageBus(this.rng, config.messageBus, this.metrics)
		}

		// Constructed immediately after the bus (which consumes no RNG), so clustered mode
		// draws its centers at the same RNG position as before the module split — keeping
		// same-seed replays byte-identical.
		this.placement = new CoordPlacement(this.rng, {
			placement: config.placement,
			clusterConfig: config.clusterConfig,
			n: config.n,
		})
		this.partitionModel = new PartitionModel({ hasPeer: (id) => this.peers.has(id) })
		this.liveness = new LivenessModel(
			{
				deadAfterFailures: config.deadAfterFailures ?? 3,
				deadReprobePerTick: config.deadReprobePerTick ?? 2,
			},
			{
				contactAllowed: (a, b) => this.partitionModel.contactAllowed(a, b),
				isAlive: (id) => {
					const p = this.peers.get(id)
					return !!p && p.alive
				},
				// Both non-null assertions hold because neither map is ever pruned: a departed
				// peer keeps its `peers` entry (with `alive = false`) and its model, and both
				// are only ever called with a peer id the harness itself is sweeping or
				// routing from. See the NOTE in `handleLeave` — reclaiming those maps, which
				// that NOTE floats as a memory fix, would turn both of these into crashes.
				modelFor: (selfId) => this.models.get(selfId)!,
				coordOf: (id) => this.peers.get(id)!.coord,
			},
		)
		this.measurement = new SimMeasurement({
			peers: this.peers,
			stores: this.stores,
			m: config.m,
			partition: this.partitionModel,
		})
	}

	initialize(): void {
		for (let i = 0; i < this.config.n; i++) {
			this.addPeer(i)
		}

		// Schedule initial connections
		for (const peer of this.peers.values()) {
			this.scheduler.schedule({ type: 'connect', peerId: peer.id }, this.rng.nextInt(0, 100))
		}

		this.scheduleStabilization()

		if (this.config.churnRatePerSec > 0) {
			this.scheduleChurn()
		}
	}

	/** Split the network into mutually unreachable groups — see `PartitionModel.partition`. */
	partition(groups: ReadonlyArray<ReadonlyArray<string>>): void {
		this.partitionModel.partition(groups)
	}

	/** Restore full reachability — see `PartitionModel.heal`. */
	heal(): void {
		this.partitionModel.heal()
	}

	/** Contacts refused by the reachability predicate since construction — see `PartitionModel.blocked`. */
	crossPartitionBlocked(): number {
		return this.partitionModel.blocked()
	}

	private addPeer(index: number, isJoin = false): SimPeer {
		const peer = this.createPeer(index, isJoin)
		this.peers.set(peer.id, peer)
		// `addPeer` is the single construction seam (initialize() and handleJoin() both go
		// through it), so creating the model here covers every peer exactly once.
		const model = createSparsityModel()
		this.models.set(peer.id, model)
		const store = new DigitreeStore()
		store.upsert(peer.id, peer.coord)
		// Score the self entry so it does not sit at the 0 sentinel `upsert` leaves. Self is
		// eviction-protected anyway, so this only affects what the relevance index reads. The
		// distance is 0 (self to itself) and the KDE is deliberately *not* observed with it:
		// self is not a peer at some distance, and feeding 0 would bias every peer's occupancy
		// toward the near end of the axis.
		const now = this.scheduler.getCurrentTime()
		const selfEntry = store.getById(peer.id)!
		store.update(peer.id, {
			relevance: initialRelevance(selfEntry, normalizedLogDistance(peer.coord, peer.coord), model, now),
			lastAccess: now,
		})
		this.stores.set(peer.id, store)
		this.metrics.recordJoin()
		return peer
	}

	private assignProfile(): SimPeerConfig {
		const mix = this.config.profileMix
		if (!mix) return CORE_PROFILE
		const total = mix.edge + mix.core
		const edgeThreshold = mix.edge / total
		return this.rng.next() < edgeThreshold ? EDGE_PROFILE : CORE_PROFILE
	}

	private createPeer(index: number, isJoin: boolean): SimPeer {
		const id = `peer-${index.toString().padStart(4, '0')}`
		const coord = this.placement.generateCoord(index, isJoin)
		const profileConfig = this.assignProfile()
		return { id, coord, alive: true, connected: new Set(), neighbors: new Set(), profileConfig }
	}

	private scheduleStabilization(): void {
		// Use the fastest cadence among all profiles so no peer misses its window.
		// NOTE: when profileMix is set, config.stabilizationIntervalMs is intentionally
		// ignored — per-peer cadence comes from each profile's stabilizationIntervalMs,
		// gated in handleStabilize(). The global tick just sets the polling granularity.
		const interval = this.config.profileMix
			? Math.min(EDGE_PROFILE.stabilizationIntervalMs, CORE_PROFILE.stabilizationIntervalMs)
			: this.config.stabilizationIntervalMs
		for (let t = interval; t < this.config.durationMs; t += interval) {
			this.scheduler.schedule({ type: 'stabilize' }, t)
		}
	}

	/**
	 * Schedule the churn cadence only. Which peer leaves is decided at fire time by
	 * handleChurn, not here: picking up front drew every leaver from the *initial*
	 * population, so a late joiner could never churn and a peer drawn twice produced a
	 * second no-op leave.
	 */
	private scheduleChurn(): void {
		const intervalMs = Math.floor(1000 / this.config.churnRatePerSec)
		for (let t = intervalMs; t < this.config.durationMs; t += intervalMs) {
			this.scheduler.schedule({ type: 'churn' }, t)
		}
	}

	/** One churn event: the currently-alive population loses one peer and gains one. */
	private handleChurn(): void {
		const alive = Array.from(this.peers.values()).filter((p) => p.alive)
		const leaving = this.rng.pick(alive)
		if (leaving) {
			this.handleLeave(leaving.id)
		}
		this.handleJoin()
	}

	scheduleBatchLeave(count: number, atMs: number): string[] {
		const alive = Array.from(this.peers.values()).filter((p) => p.alive)
		const leaving = this.rng.shuffle(alive).slice(0, Math.min(count, alive.length))
		for (const peer of leaving) {
			this.scheduler.scheduleAt({ type: 'leave', peerId: peer.id }, atMs)
		}
		return leaving.map((p) => p.id)
	}

	scheduleBatchJoin(count: number, atMs: number): void {
		for (let i = 0; i < count; i++) {
			this.scheduler.scheduleAt({ type: 'join', count: 1 }, atMs + i)
		}
	}

	scheduleRoute(fromPeerId: string, targetCoord: Uint8Array, atMs: number): void {
		this.scheduler.scheduleAt({ type: 'route', peerId: fromPeerId, targetCoord }, atMs)
	}

	run(): SimMetrics {
		this.initialize()

		while (this.scheduler.pending() > 0) {
			const evt = this.scheduler.nextEvent()
			if (!evt) break
			if (evt.time > this.config.durationMs) break
			this.handleEvent(evt)
		}

		return this.metrics.finalize()
	}

	/** Process a single simulation event (public entry point for manual stepping). */
	processEvent(evt: SimEvent): void {
		this.handleEvent(evt)
	}

	private handleEvent(evt: SimEvent): void {
		switch (evt.type) {
			case 'connect':
				if (evt.peerId) this.handleConnect(evt.peerId)
				break
			case 'leave':
				if (evt.peerId) this.handleLeave(evt.peerId)
				break
			case 'join':
				this.handleJoin()
				break
			case 'churn':
				this.handleChurn()
				break
			case 'stabilize':
				this.handleStabilize()
				break
			case 'route':
				if (evt.peerId && evt.targetCoord) this.handleRoute(evt.peerId, evt.targetCoord, evt.time)
				break
		}

		// After any event, flush bus messages that have come due. The sim has no
		// standalone timer event for the bus; delivery piggybacks on the periodic
		// stabilization cadence, which always provides a future event to drain the
		// queue. NOTE: messages still in flight when the run hits durationMs are
		// simply never delivered (acceptable — they model in-transit traffic at EOL).
		if (this.bus) {
			this.deliverPendingMessages()
		}
	}

	/** Deliver and process all bus messages ready at the current time. */
	private deliverPendingMessages(): void {
		if (!this.bus) return
		const time = this.scheduler.getCurrentTime()
		const messages = this.bus.deliver(time)
		for (const msg of messages) {
			this.processDeliveredMessage(msg)
		}
	}

	/** Process a delivered message from the bus. */
	private processDeliveredMessage(msg: SimMessage): void {
		const peer = this.peers.get(msg.to)
		if (!peer || !peer.alive) return

		// A cut applies to traffic already in flight: a message whose endpoints are no longer
		// mutually reachable is dropped at delivery (never delivered late), counted as a bus
		// drop. Healing cannot resurrect it — it left the pending queue here.
		if (!this.partitionModel.contactAllowed(msg.from, msg.to)) {
			this.metrics.recordMessageDrop()
			return
		}

		const store = this.stores.get(msg.to)
		if (!store) return

		switch (msg.type) {
			case 'neighbor-response': {
				// Payload is an array of { id, coord } entries to merge
				const entries = msg.payload as Array<{ id: string; coord: Uint8Array }>
				for (const entry of entries) {
					const p = this.peers.get(entry.id)
					if (p && p.alive) {
						// A merge never resurrects (or even touches) a locally-dead entry —
						// production upsert preserves state and a re-seed does not resurrect.
						// Skipping the upsert also keeps the entry's lastAccess sim-deterministic
						// for the dead re-probe ordering (upsert stamps wall-clock time).
						if (store.getById(entry.id)?.state === 'dead') continue
						store.upsert(p.id, p.coord)
						// NOTE: gossip-fed KDE — a deliberate deviation from production's
						// hearsay rule; the reasoning lives on `scoreMerge`.
						this.scoreMerge(msg.to, store, p.id)
					}
				}
				if (this.config.capacity) {
					this.enforceCapacity(msg.to, store)
				}
				break
			}
			case 'leave-notice': {
				const leavingId = msg.payload as string
				store.remove(leavingId)
				peer.connected.delete(leavingId)
				peer.neighbors.delete(leavingId)
				break
			}
			default:
				break
		}
	}

	private handleConnect(peerId: string): void {
		const peer = this.peers.get(peerId)
		if (!peer || !peer.alive) return

		const store = this.stores.get(peerId)
		if (!store) return

		const maxConn = peer.profileConfig.maxConnections
		// A joiner samples only peers it can reach — a mid-split joiner (group 0 by default)
		// bootstraps against its own side, never across the cut.
		const alivePeers = Array.from(this.peers.values())
			.filter((p) => p.id !== peerId && p.alive && this.partitionModel.reachable(peerId, p.id))
		const sample = this.rng.shuffle(alivePeers).slice(0, Math.min(maxConn, alivePeers.length))
		// A bootstrap dial is *proven contact*, not hearsay, so these take production's `touch`
		// (accessCount incremented, KDE observed) rather than the merge sites' hearsay rule.
		// `handleConnect` takes no time parameter, so the clock is read here.
		// NOTE: this block is the proven-contact arm of the same rule `scoreMerge` states for the
		// hearsay arm — score one entry in one store, patching exactly what the helper computed.
		// It is inline rather than a `scoreContact` sibling because it is the only proven-contact
		// site; if a second one appears, extract the pair rather than copying this. Read
		// `scoreMerge`'s doc block before editing either — the clock rule below is stated there.
		const model = this.models.get(peerId)!
		const simNow = this.scheduler.getCurrentTime()
		for (const other of sample) {
			store.upsert(other.id, other.coord)
			const entry = store.getById(other.id)
			if (entry) {
				const scored = touch(entry, normalizedLogDistance(peer.coord, other.coord), model, simNow)
				store.update(other.id, {
					relevance: scored.relevance,
					lastAccess: scored.lastAccess,
					accessCount: scored.accessCount,
				})
			}
			peer.connected.add(other.id)
			this.metrics.recordConnection()
		}

		if (this.config.capacity) {
			this.enforceCapacity(peerId, store)
		}
	}

	private handleLeave(peerId: string): void {
		const peer = this.peers.get(peerId)
		if (!peer || !peer.alive) return

		// NOTE: a departed peer keeps its entry in `peers` and its store in `stores` — every
		// hot path filters on `alive`, so this is memory, not per-tick cost. Continuous churn
		// makes both maps grow linearly in run length x rate (59 entries for a 40-peer 10s run
		// at 2/s). If a long or high-rate run ever runs out of memory, reclaim here - but note
		// `LivenessModel`'s `modelFor` / `coordOf` deps read `models` / `peers` by id and assume
		// no entry is ever removed, so reclaiming needs those two to gain a failure mode first.
		peer.alive = false
		peer.connected.clear()
		peer.neighbors.clear()
		this.metrics.recordLeave()

		// Leave notices only reach the leaver's own side of a cut; the other side discovers
		// the departure through its own contact-failure escalation, not through a notice.
		if (this.bus) {
			// Send leave notices through the bus
			const time = this.scheduler.getCurrentTime()
			for (const [otherId, _otherStore] of this.stores) {
				if (otherId === peerId) continue
				const otherPeer = this.peers.get(otherId)
				if (!otherPeer || !otherPeer.alive) continue
				if (!this.partitionModel.contactAllowed(peerId, otherId)) continue
				this.bus.send(peerId, otherId, 'leave-notice', peerId, time)
			}
		} else {
			// Instant mode: directly remove from all stores
			for (const [otherId, otherStore] of this.stores) {
				if (otherId === peerId) continue
				const otherPeer = this.peers.get(otherId)
				if (!otherPeer || !otherPeer.alive) continue
				if (!this.partitionModel.contactAllowed(peerId, otherId)) continue
				otherStore.remove(peerId)
				otherPeer.connected.delete(peerId)
				otherPeer.neighbors.delete(peerId)
			}
		}
	}

	private handleJoin(): void {
		const index = this.nextPeerIndex++
		const peer = this.addPeer(index, true)
		// Immediately connect the new peer to some existing alive peers
		this.handleConnect(peer.id)
	}

	private handleStabilize(): void {
		this.metrics.recordStabilization()
		const time = this.scheduler.getCurrentTime()

		for (const peer of this.peers.values()) {
			if (!peer.alive) continue

			// Per-profile cadence gating: skip if this peer hasn't waited long enough
			if (this.config.profileMix) {
				const lastTime = this.lastStabilized.get(peer.id) ?? 0
				if (time - lastTime < peer.profileConfig.stabilizationIntervalMs) continue
			}
			this.lastStabilized.set(peer.id, time)

			const store = this.stores.get(peer.id)
			if (!store) continue

			// Compute this peer's neighbors from its store. The walk skips entries this peer
			// has marked dead — that skip is what lets the window advance past a partitioned-away
			// peer instead of pinning on it forever, and it is the *only* partition-awareness
			// here: `reachable` is deliberately NOT consulted, because a peer cannot know a
			// neighbor became unreachable until its own contact attempts say so. Consulting it
			// would empty the set the instant a cut is applied and make "the neighbor sets went
			// side-pure" true by oracle rather than by escalation. The outbound exchange below
			// is still gated, so nothing crosses the cut in the meantime.
			const right = store.neighborsRight(peer.coord, this.config.m, notDead)
			const left = store.neighborsLeft(peer.coord, this.config.m, notDead)
			const neighbors = new Set(
				[...right, ...left].filter((id) => {
					if (id === peer.id) return false
					const p = this.peers.get(id)
					return p && p.alive
				})
			)

			peer.neighbors = neighbors
			this.metrics.recordNeighbors(neighbors.size)

			if (this.bus) {
				// Send neighbor snapshots through the bus
				this.sendNeighborSnapshots(peer, store, neighbors, time)
			} else {
				// Instant mode: direct exchange
				this.exchangeNeighborsDirect(peer, store, neighbors)
			}

			// Contact sweep: prune departed peers, escalate unreachable ones toward `dead`.
			this.liveness.contactSweep(peer.id, store, time)

			// Bounded re-probe of dead entries — the path back after heal().
			this.liveness.reprobeDeadEntries(peer.id, store, time)

			// Enforce capacity
			if (this.config.capacity) {
				this.enforceCapacity(peer.id, store)
			}
		}

		// Record coverage snapshot
		const coverage = this.snapshotCoverage()
		this.metrics.recordCoverage(time, coverage)
	}

	/** Collect snapshot entries for a peer, respecting profile snapshot caps. */
	private collectSnapshotEntries(
		peer: SimPeer,
		store: DigitreeStore,
	): Array<{ id: string; coord: Uint8Array }> {
		const cap = peer.profileConfig.snapshotCap
		const peerRight = store.neighborsRight(peer.coord, cap.successors, notDead)
		const peerLeft = store.neighborsLeft(peer.coord, cap.predecessors, notDead)
		return [...peerRight, ...peerLeft]
			.filter((id) => {
				const p = this.peers.get(id)
				return p && p.alive
			})
			.map((id) => {
				const p = this.peers.get(id)!
				return { id: p.id, coord: p.coord }
			})
	}

	/** Send neighbor snapshots through the message bus. */
	private sendNeighborSnapshots(
		peer: SimPeer,
		_store: DigitreeStore,
		neighbors: Set<string>,
		time: number,
	): void {
		const myEntries = this.collectSnapshotEntries(peer, this.stores.get(peer.id)!)

		for (const nid of neighbors) {
			const neighbor = this.peers.get(nid)
			if (!neighbor || !neighbor.alive) continue

			// Gates the whole exchange — including the direct read of the neighbor's store
			// below, which models the far peer *responding*, not merely our send.
			if (!this.partitionModel.contactAllowed(peer.id, nid)) continue

			// Send our neighbors to the neighbor (capped by sender's profile)
			this.bus!.send(peer.id, nid, 'neighbor-response', myEntries, time)

			// Also request their neighbors (they send back, capped by their profile)
			const nstore = this.stores.get(nid)
			if (!nstore) continue
			const theirEntries = this.collectSnapshotEntries(neighbor, nstore)
			this.bus!.send(nid, peer.id, 'neighbor-response', theirEntries, time)
		}
	}

	/** Direct (instant) neighbor exchange — respects profile snapshot caps. */
	private exchangeNeighborsDirect(
		peer: SimPeer,
		store: DigitreeStore,
		neighbors: Set<string>,
	): void {
		for (const nid of neighbors) {
			const neighbor = this.peers.get(nid)
			if (!neighbor || !neighbor.alive) continue

			// Gates both directions — reading the neighbor's store models it responding.
			if (!this.partitionModel.contactAllowed(peer.id, nid)) continue

			const nstore = this.stores.get(nid)
			if (!nstore) continue

			const nCap = neighbor.profileConfig.snapshotCap
			const nRight = nstore.neighborsRight(neighbor.coord, nCap.successors, notDead)
			const nLeft = nstore.neighborsLeft(neighbor.coord, nCap.predecessors, notDead)

			const pCap = peer.profileConfig.snapshotCap
			const peerRight = store.neighborsRight(peer.coord, pCap.successors, notDead)
			const peerLeft = store.neighborsLeft(peer.coord, pCap.predecessors, notDead)

			// Merge neighbor's view into peer's store. A merge never resurrects (or touches)
			// a locally-dead entry — production upsert preserves state and a re-seed does not
			// resurrect; skipping also keeps lastAccess sim-deterministic for re-probe ordering.
			// NOTE: gossip-fed KDE — a deliberate deviation from production's hearsay rule; the
			// reasoning lives on `scoreMerge`. Scoring runs only where the upsert ran, so the
			// dead skip in each condition skips the scoring with it.
			for (const id of [...nRight, ...nLeft]) {
				const p = this.peers.get(id)
				if (p && p.alive && store.getById(id)?.state !== 'dead') {
					store.upsert(p.id, p.coord)
					this.scoreMerge(peer.id, store, p.id)
				}
			}

			// Merge peer's view into neighbor's store. Each side scores with *its own* model and
			// its own coord as the "self" of the distance — the peer's store is the peer's view.
			for (const id of [...peerRight, ...peerLeft]) {
				const p = this.peers.get(id)
				if (p && p.alive && nstore.getById(id)?.state !== 'dead') {
					nstore.upsert(p.id, p.coord)
					this.scoreMerge(nid, nstore, p.id)
				}
			}

			if (this.config.capacity) {
				this.enforceCapacity(nid, nstore)
			}
		}
	}

	/**
	 * Score one merged (hearsay) entry in `storeOwnerId`'s store — the shared rule for every
	 * merge site: the bus `neighbor-response` path and both directions of
	 * `exchangeNeighborsDirect`. Call it only where the upsert actually ran, so a skipped
	 * locally-dead entry is skipped here too.
	 *
	 * It reads the scheduler clock itself rather than taking a `time` parameter, which is a
	 * deliberate difference from `LivenessModel`'s scoring calls (they take `time` because an
	 * event's own time and the scheduler's are not the same number on the `processEvent` /
	 * `advanceTo` paths). None of the three merge sites has a `time` in scope, and routing the
	 * read through one helper is what stops the bus and instant paths from stamping different
	 * timestamps or applying different scoring rules. Do not "fix" it into a parameter.
	 *
	 * NOTE: wall clock meets sim clock here, and on every other scoring site. `DigitreeStore.upsert`
	 * stamps `lastAccess` with `Date.now()`; each scoring site then patches it to sim time. So the
	 * *first* scoring of an entry computes `recencyScore` over `max(0, simNow - wallClock)` — always
	 * 0, i.e. recency exactly 1.0 — while every later re-score decays against a `lastAccess` that is
	 * already sim time. Benign (the sim never compares the two clocks, and same-seed replay is
	 * unaffected), but not derivable from the code, so it is written down rather than re-derived.
	 *
	 * NOTE: deviation from production, and the sim needs it. Production scores a gossiped peer
	 * once at creation and never feeds its distance to the KDE (`initialRelevance` alone — see
	 * docs/fret.md, Relevance scoring and table management). Here gossip *does* feed the KDE and
	 * an already-held entry is re-scored on every merge, because a sim peer sees orders of
	 * magnitude fewer contact events than a real node: proven contact alone supplies at most
	 * about `maxConnections` observations per peer, so at `alpha = 0.03` occupancy stays near 0,
	 * the ideal/density ratio stays above `sMax^(1/beta) ~= 2.63`, and every entry clamps at
	 * `sMax = 1.8` and ties — the same degeneracy relevance ranking exists to escape, one layer
	 * down. Re-scoring lets the bonus track growing occupancy.
	 */
	private scoreMerge(storeOwnerId: string, store: DigitreeStore, id: string): void {
		// Churn: the entry can be gone by the time we score it.
		const entry = store.getById(id)
		if (!entry) return
		const model = this.models.get(storeOwnerId)!
		const x = normalizedLogDistance(this.peers.get(storeOwnerId)!.coord, entry.coord)
		observeDistance(model, x)
		const now = this.scheduler.getCurrentTime()
		store.update(id, { relevance: initialRelevance(entry, x, model, now), lastAccess: now })
	}

	/**
	 * Enforce store capacity by evicting lowest-relevance entries, skipping a protection set.
	 *
	 * The protection set is production's (docs/fret.md — Relevance scoring and table
	 * management): self plus `max(2, m)` live entries per side of self, gathered by the shipped
	 * `ringNeighborsBothSides` helper rather than a hand-rolled two-sided walk, so the helper's
	 * self-slot over-fetch keeps a walk anchored on self from protecting only `m - 1` per side.
	 * The sim models no `membership`, so `notDead` stands in for production's `isLiveMember`.
	 * That is `2 * max(2, m) + 1` ids.
	 *
	 * **Protection outranks the cap**: with `capacity < 2m + 1` the evictable set runs out and
	 * the store simply stays over capacity — the slice-based eviction below cannot loop, and it
	 * must never evict a protected id to get under the cap.
	 *
	 * Eviction here is genuinely relevance-ranked: every entry a store holds is scored at the
	 * site that put it there — the self-seed in `addPeer`, the bootstrap dials in
	 * `handleConnect`, the three merge sites through `scoreMerge`, and the per-tick contact
	 * sweep through `LivenessModel` — so unprotected entries no longer all tie at the 0 that
	 * bare `upsert` leaves. Protection outranks that ranking, as above.
	 */
	private enforceCapacity(peerId: string, store: DigitreeStore): void {
		const cap = this.config.capacity!
		const overBy = store.size() - cap
		if (overBy <= 0) return
		const protectedIds = new Set(
			ringNeighborsBothSides(store, this.peers.get(peerId)!.coord, Math.max(2, this.config.m), peerId, {
				filter: notDead,
			}),
		)
		protectedIds.add(peerId)
		// Sort by relevance ascending and drop the lowest `overBy` in one pass.
		const evictable = store.list().filter((e) => !protectedIds.has(e.id))
		evictable.sort((a, b) => a.relevance - b.relevance)
		for (const e of evictable.slice(0, overBy)) {
			store.remove(e.id)
		}
	}

	/**
	 * Route one message hop by hop, choosing every hop with the shipped selector
	 * (`chooseNextHop`, cost path) over the *deciding peer's own store*. Nothing here reads
	 * the global `alive` flag or the partition map to build a candidate pool: a peer learns a
	 * neighbour is unreachable only when its own contact attempt fails, exactly as production
	 * does, and each such failure strikes that entry through the same escalation
	 * `LivenessModel.contactSweep` uses. Consulting the oracle instead is what let this
	 * harness report a routing-success number that could not fail when the distance math was
	 * wrong.
	 */
	private handleRoute(fromPeerId: string, targetCoord: Uint8Array, time: number): void {
		const from = this.peers.get(fromPeerId)
		if (!from || !from.alive) {
			this.metrics.recordRoute(false, 0)
			return
		}

		let current = fromPeerId
		const visited = new Set<string>()
		let hops = 0
		// Bounds contact attempts spent, so a route into a fully partitioned-away window
		// terminates. Every hop consumes an attempt, so this bounds hops too — no separate
		// `hops` term is needed. It keeps reading the global alive count on purpose: this is a
		// harness cutoff rather than a decision a peer makes, and deriving it from a peer's own
		// store size would make the budget vary per hop and per partition side. Every routing
		// *decision* below is local.
		const maxHops = Math.ceil(Math.log2(this.aliveCount()) * 2) + 4
		let attempts = 0

		while (attempts < maxHops) {
			visited.add(current)
			const store = this.stores.get(current)
			const currentPeer = this.peers.get(current)
			if (!store || !currentPeer) break

			// Check if current peer is the closest to the target. These reads are deliberately
			// UNfiltered (dead entries stay visible): a peer nearest a partitioned-away
			// coordinate must not crown itself anchor while its store still names a (dead)
			// entry closer to the key — that is what makes a cross-cut route fail by
			// exhaustion instead of succeeding against the wrong half.
			// NOTE: that outcome therefore rests on dead entries *staying in the store*. Nothing
			// evicts them today (only a departed peer is pruned, and capacity is unset in the
			// partition specs), but if dead entries ever start being pruned or evicted, a
			// boundary peer would crown itself anchor for a far-side coordinate and the
			// "A→B route fails during the cut" assertion would silently invert into a pass on
			// the wrong reason. Re-derive the anchor rule here before allowing that.
			const succ = store.successorOfCoord(targetCoord)
			const pred = store.predecessorOfCoord(targetCoord)
			if (!succ && !pred) break

			// If we're the successor or predecessor of the target, we found it
			const right = store.neighborsRight(targetCoord, 1)
			const left = store.neighborsLeft(targetCoord, 1)
			const anchor = right[0] ?? left[0]
			if (anchor === current || (succ && succ.id === current) || (pred && pred.id === current)) {
				this.metrics.recordRoute(true, hops)
				return
			}

			// Candidate pool — this peer's own store and nothing else. `notDead` is the only
			// filter with any partition awareness in it, and it reads what *this* peer's own
			// failed contacts recorded.
			const pool = [
				...store.neighborsRight(targetCoord, this.config.m, notDead),
				...store.neighborsLeft(targetCoord, this.config.m, notDead),
			].filter((id) => id !== current && !visited.has(id))

			// Choose, attempt contact, and on failure choose again from what is left. A chosen
			// hop is a *candidate*, not a delivered message.
			const tried = new Set<string>()
			let next: string | undefined
			// Fixed for the whole hop — `store` does not change inside the retry loop, and the
			// derivation allocates a BigInt division plus a 32-byte coordinate.
			const nearRadius = this.nearRadiusFor(store)
			while (attempts < maxHops) {
				const candidates = pool.filter((id) => !tried.has(id))
				if (candidates.length === 0) break

				// Candidates resolve through `store.getById`; one absent from this peer's store
				// is silently skipped — none is here, since the pool came from that store's own
				// walks. `selfCoord` is supplied from the second hop onward only: production
				// passes it when *forwarding*, and an originator aiming at a key's cluster is
				// legitimately farther from the key than every member of that cluster.
				const pick = chooseNextHop(
					store,
					targetCoord,
					candidates,
					(id) => currentPeer.connected.has(id),
					() => 0, // sim models no link latency; a constant keeps runs deterministic
					{
						nearRadius,
						selfCoord: hops > 0 ? currentPeer.coord : undefined,
						confidence: 0.5,
					},
				)
				// No strictly-improving candidate left. Stopping is the production outcome; a
				// "closest anyway" fallback would reintroduce the backwards drift the
				// strict-improvement floor exists to prevent.
				if (!pick) break

				attempts++
				tried.add(pick)
				const entry = store.getById(pick)
				const target = this.peers.get(pick)
				if (this.partitionModel.contactAllowed(current, pick) && target?.alive) {
					if (entry) this.liveness.recordContactSuccess(current, store, entry, time)
					next = pick
					break
				}
				// Failed contact: strike it the way the sweep would, then try the next best.
				if (entry) this.liveness.recordContactFailure(current, store, entry, time)
			}

			if (!next) break
			// Only a delivered hop counts, so `avgRoutingHops` stays a path-length measure and
			// failed attempts spend attempt budget instead.
			current = next
			hops++
		}

		this.metrics.recordRoute(false, hops)
	}

	/**
	 * Near-radius for the cost-path selector, derived from **local** information only:
	 * β·k·(2^256 / store.size()) with β = 2, clamped to half the ring (ring distance is the
	 * shorter arc, so it cannot exceed 2^255). Using `aliveCount()` would put the oracle back
	 * in a new place — the point of this path is that every input is something the deciding
	 * peer could actually know.
	 *
	 * NOTE: as a fraction of the maximum ring distance this radius is exactly `4k/store.size()`
	 * (2·k·2^256/size ÷ 2^255), so `size()` is its own denominator and a *smaller* store makes
	 * the radius larger. On the routing spec's unbounded cases `size()` stays within an order of
	 * the population and the radius lands around a third of maximum distance; on its
	 * capacity-bounded case (`capacity: 32`, k=15) the fraction is 60/32 > 1 and the radius clamps
	 * to half the ring, the largest a ring distance can be. Either way most candidates — on the
	 * bounded case, all of them — take the selector's *near* branch, where ordering is by distance
	 * alone and both the connected allowance and the backoff arm of the cost path are inert.
	 *
	 * That is production's own arithmetic, not a sim defect, but it bounds the claim in a way
	 * worth stating precisely: this harness exercises chiefly the near branch, so it can
	 * discriminate the distance *metric* (it does — see the substitution table in
	 * `test/simulation.routing.spec.ts`) and not the cost function's slack constants. Exercising
	 * the far branch needs a larger capacity or a smaller β, not a sparser store.
	 */
	private nearRadiusFor(store: DigitreeStore): Uint8Array {
		const span = (1n << 256n) / BigInt(Math.max(1, store.size()))
		const raw = span * BigInt(this.config.k) * 2n
		const halfRing = 1n << 255n
		return toCoord(raw > halfRing ? halfRing : raw)
	}

	/** Mean fraction of each peer's ideal neighbor window it holds — see `SimMeasurement.snapshotCoverage`. */
	snapshotCoverage(): number {
		return this.measurement.snapshotCoverage()
	}

	/** Mean per-peer fraction of neighbor-window entries no longer alive — see `SimMeasurement.deadNeighborRatio`. */
	deadNeighborRatio(): number {
		return this.measurement.deadNeighborRatio()
	}

	aliveCount(): number {
		return Array.from(this.peers.values()).filter((p) => p.alive).length
	}

	getPeers(): ReadonlyMap<string, SimPeer> {
		return this.peers
	}

	getStores(): ReadonlyMap<string, DigitreeStore> {
		return this.stores
	}

	getBus(): SimMessageBus | undefined {
		return this.bus
	}
}
