// Mulberry32 PRNG for deterministic simulation
export class DeterministicRNG {
	private state: number

	constructor(seed: number) {
		this.state = seed >>> 0
	}

	next(): number {
		let t = (this.state += 0x6d2b79f5)
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}

	nextInt(min: number, max: number): number {
		return Math.floor(min + this.next() * (max - min))
	}

	pick<T>(arr: T[]): T | undefined {
		if (arr.length === 0) return undefined
		return arr[this.nextInt(0, arr.length)]
	}

	shuffle<T>(arr: T[]): T[] {
		const copy = [...arr]
		for (let i = copy.length - 1; i > 0; i--) {
			const j = this.nextInt(0, i + 1)
			;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
		}
		return copy
	}

	/** Box-Muller transform: returns a standard normal deviate (mean=0, stddev=1). */
	nextGaussian(): number {
		const u1 = this.next()
		const u2 = this.next()
		// Clamp u1 away from 0 to avoid log(0)
		const safeU1 = Math.max(1e-10, u1)
		return Math.sqrt(-2 * Math.log(safeU1)) * Math.cos(2 * Math.PI * u2)
	}

	/** Generate a random BigInt uniformly distributed in [0, 2^bits). */
	nextBigInt(bits: number): bigint {
		let result = 0n
		let remaining = bits
		while (remaining > 0) {
			const chunk = Math.min(remaining, 30) // stay within safe integer range
			const maxVal = 1 << chunk
			const val = this.nextInt(0, maxVal)
			result = (result << BigInt(chunk)) | BigInt(val)
			remaining -= chunk
		}
		return result
	}
}

