import { DeterministicRNG } from './deterministic-rng.js'
import { toCoord } from '../helpers/ring.js'

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

export interface PlacementOptions {
	placement?: PlacementStrategy
	clusterConfig?: ClusterConfig
	/** Initial population — evenly spaced initial peers divide the ring by this. */
	n: number
}

/**
 * Hands out ring coordinates per the configured placement strategy, owning the cluster-center
 * state `clustered` mode draws at construction.
 *
 * Determinism constraint (critical): RNG call order must be byte-identical across same-seed
 * runs, so the composing simulation constructs this at exactly the point it used to draw its
 * cluster centers — immediately after the message bus is created (the bus constructor consumes
 * no RNG) — keeping same-seed replays identical.
 */
export class CoordPlacement {
	private readonly rng: DeterministicRNG
	private readonly placement: PlacementStrategy
	private readonly clusterConfig: ClusterConfig | undefined
	private readonly n: number

	// Placement state for clustered mode
	private clusterCenters: bigint[] | undefined

	constructor(rng: DeterministicRNG, opts: PlacementOptions) {
		this.rng = rng
		this.placement = opts.placement ?? 'uniform'
		this.clusterConfig = opts.clusterConfig
		this.n = opts.n

		if (opts.placement === 'clustered' && opts.clusterConfig) {
			this.clusterCenters = []
			for (let i = 0; i < opts.clusterConfig.numClusters; i++) {
				this.clusterCenters.push(this.rng.nextBigInt(256))
			}
		}
	}

	/** Generate a ring coordinate based on placement strategy. */
	generateCoord(index: number, isJoin: boolean): Uint8Array {
		switch (this.placement) {
			case 'uniform':
				return isJoin ? this.randomCoord() : this.uniformCoord(index, this.n)
			case 'clumped-joiners':
				// The pre-fix bug, on purpose. fret-sim.ts's handleJoin does `nextPeerIndex++`
				// before creating the peer, so the old `uniformCoord(index, this.nextPeerIndex)`
				// was exactly `index / (index + 1)` of the ring — 40/41, 41/42, ... — all
				// converging on the same point. Spelled out as `index + 1` rather than read back
				// off the mutable counter so the intent survives any future change to when the
				// counter is bumped. Initial peers are placed evenly, exactly as `uniform` does.
				return isJoin ? this.uniformCoord(index, index + 1) : this.uniformCoord(index, this.n)
			case 'clustered':
				return this.clusteredCoord()
			case 'skewed':
				return this.skewedCoord()
		}
	}

	/** Evenly spaced on the 256-bit ring, over a fixed population. */
	private uniformCoord(index: number, population: number): Uint8Array {
		const range = (1n << 256n) / BigInt(Math.max(1, population))
		return toCoord(BigInt(index) * range)
	}

	/** Seeded-random ring position for a mid-run joiner — models placement by hash of peer id. */
	private randomCoord(): Uint8Array {
		return toCoord(this.rng.nextBigInt(256))
	}

	/** Gaussian spread around cluster centers. */
	private clusteredCoord(): Uint8Array {
		const centers = this.clusterCenters!
		const center = centers[this.rng.nextInt(0, centers.length)]!
		const spreadBits = this.clusterConfig?.spreadBits ?? 32
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
}
