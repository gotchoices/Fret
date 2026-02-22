import { DeterministicRNG } from './deterministic-rng.js'
import { EventScheduler, type SimEvent } from './event-scheduler.js'
import { MetricsCollector, type SimMetrics } from './sim-metrics.js'
import { DigitreeStore } from '../../src/store/digitree-store.js'

export interface SimPeer {
	id: string
	coord: Uint8Array
	alive: boolean
	connected: Set<string>
	neighbors: Set<string>
}

export interface SimConfig {
	seed: number
	n: number // initial peers
	k: number // cluster size
	m: number // neighbors (S/P set size)
	churnRatePerSec: number // peers leaving/joining per second
	stabilizationIntervalMs: number
	durationMs: number
}

export class FretSimulation {
	private readonly rng: DeterministicRNG
	readonly scheduler: EventScheduler
	readonly metrics: MetricsCollector
	private readonly config: SimConfig
	private readonly peers = new Map<string, SimPeer>()
	private readonly stores = new Map<string, DigitreeStore>()
	private nextPeerIndex: number

	constructor(config: SimConfig) {
		this.config = config
		this.rng = new DeterministicRNG(config.seed)
		this.scheduler = new EventScheduler()
		this.metrics = new MetricsCollector()
		this.nextPeerIndex = config.n
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

	private addPeer(index: number): SimPeer {
		const peer = this.createPeer(index)
		this.peers.set(peer.id, peer)
		const store = new DigitreeStore()
		store.upsert(peer.id, peer.coord)
		this.stores.set(peer.id, store)
		this.metrics.recordJoin()
		return peer
	}

	private createPeer(index: number): SimPeer {
		const id = `peer-${index.toString().padStart(4, '0')}`
		const coord = new Uint8Array(32)
		const bigIndex = BigInt(index)
		const range = (1n << 256n) / BigInt(Math.max(1, this.config.n + this.nextPeerIndex - this.config.n))
		const val = bigIndex * range
		for (let i = 0; i < 32; i++) {
			coord[31 - i] = Number((val >> BigInt(i * 8)) & 0xffn)
		}
		return { id, coord, alive: true, connected: new Set(), neighbors: new Set() }
	}

	private scheduleStabilization(): void {
		const interval = this.config.stabilizationIntervalMs
		for (let t = interval; t < this.config.durationMs; t += interval) {
			this.scheduler.schedule({ type: 'stabilize' }, t)
		}
	}

	private scheduleChurn(): void {
		const intervalMs = Math.floor(1000 / this.config.churnRatePerSec)
		for (let t = intervalMs; t < this.config.durationMs; t += intervalMs) {
			const alive = Array.from(this.peers.values()).filter((p) => p.alive)
			if (alive.length === 0) continue
			const leaving = this.rng.pick(alive)
			if (leaving) {
				this.scheduler.schedule({ type: 'leave', peerId: leaving.id }, t)
			}
		}
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
			case 'stabilize':
				this.handleStabilize()
				break
			case 'route':
				if (evt.peerId && evt.targetCoord) this.handleRoute(evt.peerId, evt.targetCoord)
				break
		}
	}

	private handleConnect(peerId: string): void {
		const peer = this.peers.get(peerId)
		if (!peer || !peer.alive) return

		const store = this.stores.get(peerId)
		if (!store) return

		const alivePeers = Array.from(this.peers.values())
			.filter((p) => p.id !== peerId && p.alive)
		const sample = this.rng.shuffle(alivePeers).slice(0, Math.min(5, alivePeers.length))
		for (const other of sample) {
			store.upsert(other.id, other.coord)
			peer.connected.add(other.id)
			this.metrics.recordConnection()
		}
	}

	private handleLeave(peerId: string): void {
		const peer = this.peers.get(peerId)
		if (!peer || !peer.alive) return

		peer.alive = false
		peer.connected.clear()
		peer.neighbors.clear()
		this.metrics.recordLeave()

		// Remove departed peer from other peers' stores (simulates leave notification)
		for (const [otherId, otherStore] of this.stores) {
			if (otherId === peerId) continue
			const otherPeer = this.peers.get(otherId)
			if (!otherPeer || !otherPeer.alive) continue
			otherStore.remove(peerId)
			otherPeer.connected.delete(peerId)
			otherPeer.neighbors.delete(peerId)
		}
	}

	private handleJoin(): void {
		const index = this.nextPeerIndex++
		const peer = this.addPeer(index)
		// Immediately connect the new peer to some existing alive peers
		this.handleConnect(peer.id)
	}

	private handleStabilize(): void {
		this.metrics.recordStabilization()
		const time = this.scheduler.getCurrentTime()

		for (const peer of this.peers.values()) {
			if (!peer.alive) continue

			const store = this.stores.get(peer.id)
			if (!store) continue

			// Compute this peer's neighbors from its store
			const right = store.neighborsRight(peer.coord, this.config.m)
			const left = store.neighborsLeft(peer.coord, this.config.m)
			const neighbors = new Set(
				[...right, ...left].filter((id) => {
					if (id === peer.id) return false
					const p = this.peers.get(id)
					return p && p.alive
				})
			)

			peer.neighbors = neighbors
			this.metrics.recordNeighbors(neighbors.size)

			// Exchange neighbor info with each neighbor (simulates snapshot exchange)
			for (const nid of neighbors) {
				const neighbor = this.peers.get(nid)
				if (!neighbor || !neighbor.alive) continue

				const nstore = this.stores.get(nid)
				if (!nstore) continue

				// Share S/P sets bidirectionally
				const peerRight = store.neighborsRight(peer.coord, this.config.m)
				const peerLeft = store.neighborsLeft(peer.coord, this.config.m)
				const nRight = nstore.neighborsRight(neighbor.coord, this.config.m)
				const nLeft = nstore.neighborsLeft(neighbor.coord, this.config.m)

				// Merge neighbor's view into peer's store
				for (const id of [...nRight, ...nLeft]) {
					const p = this.peers.get(id)
					if (p && p.alive) store.upsert(p.id, p.coord)
				}

				// Merge peer's view into neighbor's store
				for (const id of [...peerRight, ...peerLeft]) {
					const p = this.peers.get(id)
					if (p && p.alive) nstore.upsert(p.id, p.coord)
				}
			}

			// Prune dead peers from store
			for (const entry of store.list()) {
				if (entry.id === peer.id) continue
				const p = this.peers.get(entry.id)
				if (!p || !p.alive) store.remove(entry.id)
			}
		}

		// Record coverage snapshot
		const coverage = this.snapshotCoverage()
		this.metrics.recordCoverage(time, coverage)
	}

	private handleRoute(fromPeerId: string, targetCoord: Uint8Array): void {
		const from = this.peers.get(fromPeerId)
		if (!from || !from.alive) {
			this.metrics.recordRoute(false, 0)
			return
		}

		let current = fromPeerId
		const visited = new Set<string>()
		let hops = 0
		const maxHops = Math.ceil(Math.log2(this.aliveCount()) * 2) + 4

		while (hops < maxHops) {
			visited.add(current)
			const store = this.stores.get(current)
			if (!store) break

			// Check if current peer is the closest to the target
			const succ = store.successorOfCoord(targetCoord)
			const pred = store.predecessorOfCoord(targetCoord)
			if (!succ && !pred) break

			// If we're the successor or predecessor of the target, we found it
			const currentPeer = this.peers.get(current)
			if (currentPeer) {
				const right = store.neighborsRight(targetCoord, 1)
				const left = store.neighborsLeft(targetCoord, 1)
				const anchor = right[0] ?? left[0]
				if (anchor === current || (succ && succ.id === current) || (pred && pred.id === current)) {
					this.metrics.recordRoute(true, hops)
					return
				}
			}

			// Find next hop: closest alive peer to target that we haven't visited
			const candidates = [
				...store.neighborsRight(targetCoord, this.config.m),
				...store.neighborsLeft(targetCoord, this.config.m),
			].filter((id) => {
				if (visited.has(id)) return false
				const p = this.peers.get(id)
				return p && p.alive
			})

			if (candidates.length === 0) break

			current = candidates[0]!
			hops++
		}

		this.metrics.recordRoute(false, hops)
	}

	snapshotCoverage(): number {
		const alivePeers = Array.from(this.peers.values()).filter((p) => p.alive)
		if (alivePeers.length <= 1) return 1

		let totalCoverage = 0
		for (const peer of alivePeers) {
			const store = this.stores.get(peer.id)
			if (!store) continue

			const right = store.neighborsRight(peer.coord, this.config.m)
				.filter((id) => {
					if (id === peer.id) return false
					const p = this.peers.get(id)
					return p && p.alive
				})
			const left = store.neighborsLeft(peer.coord, this.config.m)
				.filter((id) => {
					if (id === peer.id) return false
					const p = this.peers.get(id)
					return p && p.alive
				})

			const idealPerSide = Math.min(this.config.m, alivePeers.length - 1)
			const actual = new Set([...right, ...left]).size
			const ideal = Math.min(idealPerSide * 2, alivePeers.length - 1)
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

			const right = store.neighborsRight(peer.coord, this.config.m)
				.filter((id) => id !== peer.id)
			const left = store.neighborsLeft(peer.coord, this.config.m)
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
}
