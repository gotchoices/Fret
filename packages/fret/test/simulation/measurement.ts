import type { DigitreeStore } from '../../src/store/digitree-store.js'
import type { PartitionModel } from './reachability.js'
import { notDead } from './liveness.js'

/**
 * Structural slice of `SimPeer` that measurement reads — a local type rather than an import
 * from fret-sim.ts so this module never imports back into the composer (no cycles). `SimPeer`
 * is assignable to it.
 */
export interface MeasurablePeer {
	id: string
	coord: Uint8Array
	alive: boolean
}

export interface MeasurementDeps {
	/** The simulation's live peer map — a stable reference mutated in place, safe to hold. */
	peers: ReadonlyMap<string, MeasurablePeer>
	/** The simulation's per-peer store map — same stable-reference contract. */
	stores: ReadonlyMap<string, DigitreeStore>
	/** Neighbor window size (S/P set size) each measure walks per side. */
	m: number
	partition: PartitionModel
}

/** Read-only ring-health measures over the simulation's peers and stores. */
export class SimMeasurement {
	private readonly peers: ReadonlyMap<string, MeasurablePeer>
	private readonly stores: ReadonlyMap<string, DigitreeStore>
	private readonly m: number
	private readonly partition: PartitionModel

	constructor(deps: MeasurementDeps) {
		this.peers = deps.peers
		this.stores = deps.stores
		this.m = deps.m
		this.partition = deps.partition
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
		const partitionActive = this.partition.isActive()
		const aliveByGroup = new Map<number, number>()
		if (partitionActive) {
			for (const p of alivePeers) {
				const g = this.partition.groupOf(p.id)
				aliveByGroup.set(g, (aliveByGroup.get(g) ?? 0) + 1)
			}
		}

		let totalCoverage = 0
		for (const peer of alivePeers) {
			const store = this.stores.get(peer.id)
			if (!store) continue

			// `aliveByGroup` was built from this same list, so the lookup always hits.
			const reachableAlive = partitionActive
				? aliveByGroup.get(this.partition.groupOf(peer.id))!
				: alivePeers.length
			const reachableOthers = reachableAlive - 1

			const liveFilter = (id: string): boolean => {
				if (id === peer.id) return false
				if (!this.partition.reachable(peer.id, id)) return false
				const p = this.peers.get(id)
				return !!p && p.alive
			}
			const right = store.neighborsRight(peer.coord, this.m, notDead).filter(liveFilter)
			const left = store.neighborsLeft(peer.coord, this.m, notDead).filter(liveFilter)

			const idealPerSide = Math.min(this.m, reachableOthers)
			const actual = new Set([...right, ...left]).size
			// A singleton side has reachableOthers = 0 → ideal 0 → contributes 1 (it fully
			// covers its empty reachable world) — defined, no NaN.
			const ideal = Math.min(idealPerSide * 2, reachableOthers)
			totalCoverage += ideal > 0 ? actual / ideal : 1
		}

		return totalCoverage / alivePeers.length
	}

	/** Mean per-peer fraction of neighbor-window entries whose peer is no longer alive. */
	deadNeighborRatio(): number {
		const alivePeers = Array.from(this.peers.values()).filter((p) => p.alive)
		if (alivePeers.length === 0) return 0

		let totalRatio = 0
		let count = 0
		for (const peer of alivePeers) {
			const store = this.stores.get(peer.id)
			if (!store) continue

			const right = store.neighborsRight(peer.coord, this.m, notDead)
				.filter((id) => id !== peer.id)
			const left = store.neighborsLeft(peer.coord, this.m, notDead)
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
}
