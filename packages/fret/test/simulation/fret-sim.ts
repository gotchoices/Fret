import { DeterministicRNG } from './deterministic-rng.js'
import { EventScheduler, type SimEvent } from './event-scheduler.js'
import { MetricsCollector, type SimMetrics } from './sim-metrics.js'
import { SimMessageBus, type MessageBusConfig, type SimMessage } from './message-bus.js'
import { DigitreeStore, type PeerEntry } from '../../src/store/digitree-store.js'
import { chooseNextHop } from '../../src/selector/next-hop.js'
import { toCoord } from '../helpers/ring.js'

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

/**
 * How ring coordinates are handed out.
 *
 * `clumped-joiners` is a **deliberate defect**, kept as a negative control: it reproduces the
 * pre-fix joiner placement in which every mid-run joiner landed at `index / (index + 1)` of the
 * ring, so joiners piled into an ever-narrowing sliver near the ring's top instead of spreading
 * out. `test/churn-scenarios.spec.ts` asserts that its placement guard reads *over* threshold
 * under this strategy and under threshold under `uniform`, so the guard proves its own
 * separating power on every run rather than at authoring time only.
 */
export type PlacementStrategy = 'uniform' | 'clustered' | 'skewed' | 'clumped-joiners'

export interface ClusterConfig {
	numClusters: number
	spreadBits: number
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
 * Ring-shaped reads skip entries the probing peer has marked `dead` in its own store. This is
 * liveness only — the sim does not model `membership` — and it is deliberately *not* the global
 * `alive` oracle: it reads only what this peer's own contact attempts recorded.
 */
const notDead = (e: PeerEntry): boolean => e.state !== 'dead'

export class FretSimulation {
	private readonly rng: DeterministicRNG
	readonly scheduler: EventScheduler
	readonly metrics: MetricsCollector
	private readonly config: SimConfig
	private readonly peers = new Map<string, SimPeer>()
	private readonly stores = new Map<string, DigitreeStore>()
	private readonly bus: SimMessageBus | undefined
	private nextPeerIndex: number
	private readonly lastStabilized = new Map<string, number>()
	private readonly deadAfterFailures: number
	private readonly deadReprobePerTick: number

	// Active partition: peer id → group index. Empty map = no partition.
	private readonly partitionOf = new Map<string, number>()
	private crossPartitionBlockedCount = 0

	// Placement state for clustered mode
	private clusterCenters: bigint[] | undefined

	constructor(config: SimConfig) {
		this.config = config
		this.deadAfterFailures = config.deadAfterFailures ?? 3
		this.deadReprobePerTick = config.deadReprobePerTick ?? 2
		this.rng = new DeterministicRNG(config.seed)
		this.scheduler = new EventScheduler()
		this.metrics = new MetricsCollector()
		this.nextPeerIndex = config.n

		if (config.messageBus) {
			this.bus = new SimMessageBus(this.rng, config.messageBus, this.metrics)
		}

		if (config.placement === 'clustered' && config.clusterConfig) {
			this.clusterCenters = []
			for (let i = 0; i < config.clusterConfig.numClusters; i++) {
				this.clusterCenters.push(this.rng.nextBigInt(256))
			}
		}
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

	/**
	 * Split the network into mutually unreachable groups.
	 *
	 * An id absent from every group resolves to group 0, so a peer that joins mid-split lands
	 * in the first group — the harness's stand-in for "the side the bootstrap list points at".
	 * Calling again replaces the whole assignment (no throw); a peer listed in more than one
	 * group keeps its last listing (last write wins — the map cannot be corrupted by a dup).
	 *
	 * An id that names no peer throws. It cannot be distinguished from a mid-split joiner at
	 * read time (both are "absent from the map"), so a typo'd or stale id would silently sort
	 * every *real* peer into one group and leave the split a no-op that a test still passes.
	 */
	partition(groups: ReadonlyArray<ReadonlyArray<string>>): void {
		for (const group of groups) {
			for (const id of group) {
				if (!this.peers.has(id)) throw new Error(`partition(): unknown peer id ${id}`)
			}
		}
		this.partitionOf.clear()
		for (let g = 0; g < groups.length; g++) {
			for (const id of groups[g]!) this.partitionOf.set(id, g)
		}
	}

	/** Restore full reachability. Calling with no partition active is a defined no-op. */
	heal(): void {
		this.partitionOf.clear()
	}

	/** Contacts refused by the reachability predicate since construction (monotonic). */
	crossPartitionBlocked(): number {
		return this.crossPartitionBlockedCount
	}

	/**
	 * The one reachability predicate every cross-peer site consults: true when no partition is
	 * active, or when both ids resolve to the same group (absent id → group 0).
	 */
	private reachable(a: string, b: string): boolean {
		if (this.partitionOf.size === 0) return true
		return (this.partitionOf.get(a) ?? 0) === (this.partitionOf.get(b) ?? 0)
	}

	/**
	 * `reachable`, counting a refusal. Used at sites that model an actual contact attempt
	 * (a probe, a send, a delivery); pool-filtering sites (candidate lists, coverage math)
	 * use `reachable` directly so the counter stays "contacts refused", not "ids filtered".
	 */
	private contactAllowed(a: string, b: string): boolean {
		if (this.reachable(a, b)) return true
		this.crossPartitionBlockedCount++
		return false
	}

	private addPeer(index: number, isJoin = false): SimPeer {
		const peer = this.createPeer(index, isJoin)
		this.peers.set(peer.id, peer)
		const store = new DigitreeStore()
		store.upsert(peer.id, peer.coord)
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
		const coord = this.generateCoord(index, isJoin)
		const profileConfig = this.assignProfile()
		return { id, coord, alive: true, connected: new Set(), neighbors: new Set(), profileConfig }
	}

	/** Generate a ring coordinate based on placement strategy. */
	private generateCoord(index: number, isJoin: boolean): Uint8Array {
		const placement = this.config.placement ?? 'uniform'
		switch (placement) {
			case 'uniform':
				return isJoin ? this.randomCoord() : this.uniformCoord(index, this.config.n)
			case 'clumped-joiners':
				// The pre-fix bug, on purpose. handleJoin does `nextPeerIndex++` before creating
				// the peer, so the old `uniformCoord(index, this.nextPeerIndex)` was exactly
				// `index / (index + 1)` of the ring — 40/41, 41/42, ... — all converging on the
				// same point. Spelled out as `index + 1` rather than read back off the mutable
				// counter so the intent survives any future change to when the counter is bumped.
				// Initial peers are placed evenly, exactly as `uniform` does.
				return isJoin ? this.uniformCoord(index, index + 1) : this.uniformCoord(index, this.config.n)
			case 'clustered':
				return this.clusteredCoord()
			case 'skewed':
				return this.skewedCoord()
		}
	}

	/** Evenly spaced on the 256-bit ring, over a fixed population. */
	private uniformCoord(index: number, population: number): Uint8Array {
		const coord = new Uint8Array(32)
		const bigIndex = BigInt(index)
		const range = (1n << 256n) / BigInt(Math.max(1, population))
		const val = bigIndex * range
		for (let i = 0; i < 32; i++) {
			coord[31 - i] = Number((val >> BigInt(i * 8)) & 0xffn)
		}
		return coord
	}

	/** Seeded-random ring position for a mid-run joiner — models placement by hash of peer id. */
	private randomCoord(): Uint8Array {
		return toCoord(this.rng.nextBigInt(256))
	}

	/** Gaussian spread around cluster centers. */
	private clusteredCoord(): Uint8Array {
		const centers = this.clusterCenters!
		const center = centers[this.rng.nextInt(0, centers.length)]!
		const spreadBits = this.config.clusterConfig?.spreadBits ?? 32
		// NOTE: spread is scaled through a JS float, so it stays exact up to ~52 bits.
		// Beyond that the offset loses low-bit precision (still wraps correctly); if a
		// caller ever needs spreadBits > 52, do the scaling in BigInt instead.
		const offset = BigInt(Math.round(this.rng.nextGaussian() * Number(1n << BigInt(spreadBits))))
		const ringSize = 1n << 256n
		// Wrap around ring
		let val = (center + offset) % ringSize
		if (val < 0n) val += ringSize
		return toCoord(val)
	}

	/** Power-law distribution — some ring regions are dense, most are sparse. */
	private skewedCoord(): Uint8Array {
		// Raising a uniform sample to a power > 1 concentrates mass near 0, leaving
		// most of the ring sparse — a crude model of organically dense/sparse regions.
		// (The earlier inverse-Pareto form (pareto-1)/pareto algebraically reduces to
		// 1-u, i.e. uniform, so it produced no skew at all.)
		const u = this.rng.next() // [0,1); u=0 maps cleanly to coordinate 0 (no NaN)
		const exponent = 3 // higher → denser near the low end of the ring
		const normalized = Math.pow(u, exponent) // [0,1), concentrated near 0
		// Only the top 128 bits carry entropy here (Number can't represent the full
		// 256-bit range); the low 128 bits stay zero, which is fine for placement.
		const ringSize = 1n << 256n
		const val = BigInt(Math.floor(normalized * Number(ringSize >> 128n))) << 128n
		return toCoord(val % ringSize)
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
		if (!this.contactAllowed(msg.from, msg.to)) {
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
			.filter((p) => p.id !== peerId && p.alive && this.reachable(peerId, p.id))
		const sample = this.rng.shuffle(alivePeers).slice(0, Math.min(maxConn, alivePeers.length))
		for (const other of sample) {
			store.upsert(other.id, other.coord)
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
		// at 2/s). If a long or high-rate run ever runs out of memory, reclaim here.
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
				if (!this.contactAllowed(peerId, otherId)) continue
				this.bus.send(peerId, otherId, 'leave-notice', peerId, time)
			}
		} else {
			// Instant mode: directly remove from all stores
			for (const [otherId, otherStore] of this.stores) {
				if (otherId === peerId) continue
				const otherPeer = this.peers.get(otherId)
				if (!otherPeer || !otherPeer.alive) continue
				if (!this.contactAllowed(peerId, otherId)) continue
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
			this.contactSweep(peer, store, time)

			// Bounded re-probe of dead entries — the path back after heal().
			this.reprobeDeadEntries(peer, store, time)

			// Enforce capacity
			if (this.config.capacity) {
				this.enforceCapacity(peer.id, store)
			}
		}

		// Record coverage snapshot
		const coverage = this.snapshotCoverage()
		this.metrics.recordCoverage(time, coverage)
	}

	/**
	 * One contact attempt per store entry per tick: prune peers that left the network, strike
	 * entries whose peer cannot be reached, and clear the strike run on a successful contact.
	 * The prune is the one global-`alive` read left here, and it stands in for a departed
	 * peer's leave notice rather than for knowledge a peer could not have; the strike/clear
	 * arithmetic itself lives in `recordContactFailure` / `recordContactSuccess`, shared with
	 * the routing path so the two escalations cannot drift.
	 * At `deadAfterFailures` strikes the entry is marked `dead` and drops out of every
	 * ring-shaped read via the `notDead` filter.
	 *
	 * Production spaces strikes ≥ 500 ms apart so a burst of concurrent failures counts once
	 * (docs/fret.md — Ring membership). *This sweep* strikes an entry at most once per tick,
	 * so within the sweep the independence the spacing rule buys holds by construction and no
	 * spacing check is re-implemented — a property of the tick, not of the clock: a driver
	 * that processes several ticks at one simulated timestamp still sweeps once per tick.
	 * NOTE: that is no longer the whole picture — `handleRoute` strikes through the same
	 * `recordContactFailure`, so an entry can take a sweep strike and one route strike (and
	 * one per further route) at the same simulated timestamp, escalating to `dead` faster
	 * than the sweep alone would. Harmless while routes are scheduled sparsely by the specs;
	 * if a suite ever fires many routes per tick through the same unreachable window, add the
	 * production spacing check (≥ 500 ms since `lastContactFailureAt`) inside
	 * `recordContactFailure` rather than re-deriving it per call site.
	 * Production also spreads its contacts across budgeted passes (near / classify /
	 * re-probe) rather than touching every entry each tick; the sim collapses those into one
	 * per-tick sweep, so a fully unreachable population escalates in `deadAfterFailures`
	 * ticks flat.
	 */
	private contactSweep(peer: SimPeer, store: DigitreeStore, time: number): void {
		for (const entry of store.list()) {
			if (entry.id === peer.id) continue
			const p = this.peers.get(entry.id)
			if (!p || !p.alive) {
				store.remove(entry.id)
				continue
			}
			if (entry.state === 'dead') continue // dead entries belong to the re-probe arm
			if (!this.contactAllowed(peer.id, entry.id)) {
				this.recordContactFailure(store, entry, time)
			} else {
				this.recordContactSuccess(store, entry)
			}
		}
	}

	/**
	 * One failed contact against a store entry: extend the strike run, and at
	 * `deadAfterFailures` mark the entry dead. Called from the per-tick `contactSweep` and
	 * from the routing path's contact attempts, which is the whole point of extracting it —
	 * two copies of this arithmetic is how the sweep and the router drift apart.
	 */
	private recordContactFailure(store: DigitreeStore, entry: PeerEntry, time: number): void {
		const strikes = Math.min(entry.contactFailures + 1, this.deadAfterFailures)
		if (strikes >= this.deadAfterFailures) {
			// lastAccess ← sim time: the re-probe arm orders by ascending lastAccess, and
			// only sim-clock stamps keep two same-seed runs picking identical candidates
			// (Date.now() stamps differ between runs and would break deterministic replay).
			store.update(entry.id, { contactFailures: strikes, state: 'dead', lastAccess: time })
		} else {
			store.update(entry.id, { contactFailures: strikes })
		}
	}

	/** A successful contact clears the strike run. Written only when there is one to clear. */
	private recordContactSuccess(store: DigitreeStore, entry: PeerEntry): void {
		if (entry.contactFailures > 0) store.update(entry.id, { contactFailures: 0 })
	}

	/**
	 * Re-probe up to `deadReprobePerTick` of this peer's dead entries; a reachable one returns
	 * to `disconnected` with its strike run cleared. Without this, nothing would ever contact a
	 * dead entry again and the merge half of a partition would be untestable — the same trap
	 * production solves with the dead arm of its re-probe pass. Candidates are ordered by
	 * ascending lastAccess (id tie-break) so a truncated pass rotates instead of re-deriving
	 * the same head — the production ordering rule. The sim has no backoff model and does not
	 * need one: production backs dead re-probes off exponentially; here the tick cadence bounds
	 * the rate.
	 */
	private reprobeDeadEntries(peer: SimPeer, store: DigitreeStore, time: number): void {
		const dead = store.list().filter((e) => e.state === 'dead')
		if (dead.length === 0) return
		dead.sort((a, b) => a.lastAccess - b.lastAccess || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		for (const entry of dead.slice(0, this.deadReprobePerTick)) {
			// Stamp before the outcome so the next pass starts past this candidate either way.
			store.update(entry.id, { lastAccess: time })
			if (!this.contactAllowed(peer.id, entry.id)) continue
			store.update(entry.id, { state: 'disconnected', contactFailures: 0 })
		}
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
			if (!this.contactAllowed(peer.id, nid)) continue

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
			if (!this.contactAllowed(peer.id, nid)) continue

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
			for (const id of [...nRight, ...nLeft]) {
				const p = this.peers.get(id)
				if (p && p.alive && store.getById(id)?.state !== 'dead') store.upsert(p.id, p.coord)
			}

			// Merge peer's view into neighbor's store
			for (const id of [...peerRight, ...peerLeft]) {
				const p = this.peers.get(id)
				if (p && p.alive && nstore.getById(id)?.state !== 'dead') nstore.upsert(p.id, p.coord)
			}

			if (this.config.capacity) {
				this.enforceCapacity(nid, nstore)
			}
		}
	}

	/** Enforce store capacity by evicting lowest-relevance entries (never self). */
	private enforceCapacity(peerId: string, store: DigitreeStore): void {
		const cap = this.config.capacity!
		const overBy = store.size() - cap
		if (overBy <= 0) return
		// Sort by relevance ascending and drop the lowest `overBy` in one pass.
		// NOTE: the sim populates stores exclusively via DigitreeStore.upsert, which
		// fixes relevance at 0, so today every entry ties and eviction degenerates to
		// ring order (list() is key-ordered). If the harness ever starts scoring peers,
		// this becomes true relevance-based eviction with no code change.
		const evictable = store.list().filter((e) => e.id !== peerId)
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
	 * `contactSweep` uses. Consulting the oracle instead is what let this harness report a
	 * routing-success number that could not fail when the distance math was wrong.
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
				if (this.contactAllowed(current, pick) && target?.alive) {
					if (entry) this.recordContactSuccess(store, entry)
					next = pick
					break
				}
				// Failed contact: strike it the way the sweep would, then try the next best.
				if (entry) this.recordContactFailure(store, entry, time)
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
	 * (2·k·2^256/size ÷ 2^255). The sim's stores are unbounded and its gossip merges every
	 * neighbour's window each tick, so `size()` stays within an order of the population and the
	 * radius lands around a third of maximum distance at the routing spec's sizes — most
	 * candidates therefore take the selector's *near* branch, where ordering is by distance
	 * alone and both the connected allowance and the backoff arm of the cost path are inert.
	 * That is production's own arithmetic, not a sim defect, but it bounds the claim: this
	 * harness exercises chiefly the near branch. Exercising the far branch needs sparse,
	 * finger-shaped stores, which needs sim eviction to stop being degenerate — see the
	 * `enforceCapacity` NOTE and `backlog/debt-sim-eviction-degenerate-blocks-metric-guard`.
	 */
	private nearRadiusFor(store: DigitreeStore): Uint8Array {
		const span = (1n << 256n) / BigInt(Math.max(1, store.size()))
		const raw = span * BigInt(this.config.k) * 2n
		const halfRing = 1n << 255n
		return toCoord(raw > halfRing ? halfRing : raw)
	}

	/**
	 * Mean fraction of each peer's ideal neighbor window that it actually holds.
	 *
	 * NOTE: 1.0 is not reachable. Both walks are anchored *on* the peer's own coordinate, so each
	 * returns self plus m−1 others, while the denominator asks for 2m — a fully converged ring
	 * therefore reports exactly (2m−2)/2m (87.5% at the usual m = 8), which is why every suite's
	 * threshold sits below that and why the partition specs log 87.5% at all three phases. Same
	 * self-anchored off-by-one docs/fret.md describes for the eviction protection set. Harmless
	 * as a *relative* measure, which is all any caller uses it for; fix it only alongside
	 * re-calibrating every threshold that was set against today's numbers.
	 */
	snapshotCoverage(): number {
		const alivePeers = Array.from(this.peers.values()).filter((p) => p.alive)
		if (alivePeers.length <= 1) return 1

		// Each peer is measured against the alive population it can actually reach — under a
		// cut, dividing by the global alive count would cap coverage at the split ratio by
		// construction and a "the ring healed" assertion would measure the split, not the
		// healing. With no partition active every peer resolves to one group and the
		// denominator is the global alive count — today's value, unchanged (the existing
		// suites' thresholds are calibrated against it).
		const partitionActive = this.partitionOf.size > 0
		const aliveByGroup = new Map<number, number>()
		if (partitionActive) {
			for (const p of alivePeers) {
				const g = this.partitionOf.get(p.id) ?? 0
				aliveByGroup.set(g, (aliveByGroup.get(g) ?? 0) + 1)
			}
		}

		let totalCoverage = 0
		for (const peer of alivePeers) {
			const store = this.stores.get(peer.id)
			if (!store) continue

			// `aliveByGroup` was built from this same list, so the lookup always hits.
			const reachableAlive = partitionActive
				? aliveByGroup.get(this.partitionOf.get(peer.id) ?? 0)!
				: alivePeers.length
			const reachableOthers = reachableAlive - 1

			const liveFilter = (id: string): boolean => {
				if (id === peer.id) return false
				if (!this.reachable(peer.id, id)) return false
				const p = this.peers.get(id)
				return !!p && p.alive
			}
			const right = store.neighborsRight(peer.coord, this.config.m, notDead).filter(liveFilter)
			const left = store.neighborsLeft(peer.coord, this.config.m, notDead).filter(liveFilter)

			const idealPerSide = Math.min(this.config.m, reachableOthers)
			const actual = new Set([...right, ...left]).size
			// A singleton side has reachableOthers = 0 → ideal 0 → contributes 1 (it fully
			// covers its empty reachable world) — defined, no NaN.
			const ideal = Math.min(idealPerSide * 2, reachableOthers)
			totalCoverage += ideal > 0 ? actual / ideal : 1
		}

		return totalCoverage / alivePeers.length
	}

	deadNeighborRatio(): number {
		const alivePeers = Array.from(this.peers.values()).filter((p) => p.alive)
		if (alivePeers.length === 0) return 0

		let totalRatio = 0
		let count = 0
		for (const peer of alivePeers) {
			const store = this.stores.get(peer.id)
			if (!store) continue

			const right = store.neighborsRight(peer.coord, this.config.m, notDead)
				.filter((id) => id !== peer.id)
			const left = store.neighborsLeft(peer.coord, this.config.m, notDead)
				.filter((id) => id !== peer.id)
			const all = new Set([...right, ...left])
			if (all.size === 0) continue

			let dead = 0
			for (const id of all) {
				const p = this.peers.get(id)
				if (!p || !p.alive) dead++
			}
			totalRatio += dead / all.size
			count++
		}

		return count > 0 ? totalRatio / count : 0
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
