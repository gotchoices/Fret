export interface PartitionDeps {
	/** True when the id names a peer the simulation knows (alive or departed). */
	hasPeer: (id: string) => boolean
}

/**
 * The simulation's partition oracle: which peers can exchange traffic at all. One instance per
 * simulation; every cross-peer site consults it. Pool-filtering sites (candidate lists,
 * coverage math) use `reachable` silently; sites that model a real contact attempt use
 * `contactAllowed`, which counts the refusal, so `blocked()` reads as "contacts refused",
 * not "ids filtered".
 */
export class PartitionModel {
	private readonly hasPeer: (id: string) => boolean

	// Active partition: peer id → group index. Empty map = no partition.
	private readonly partitionOf = new Map<string, number>()
	private crossPartitionBlockedCount = 0

	constructor(deps: PartitionDeps) {
		this.hasPeer = deps.hasPeer
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
				if (!this.hasPeer(id)) throw new Error(`partition(): unknown peer id ${id}`)
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
	blocked(): number {
		return this.crossPartitionBlockedCount
	}

	/**
	 * The one reachability predicate every cross-peer site consults: true when no partition is
	 * active, or when both ids resolve to the same group (absent id → group 0).
	 */
	reachable(a: string, b: string): boolean {
		if (this.partitionOf.size === 0) return true
		return (this.partitionOf.get(a) ?? 0) === (this.partitionOf.get(b) ?? 0)
	}

	/**
	 * `reachable`, counting a refusal. Used at sites that model an actual contact attempt
	 * (a probe, a send, a delivery); pool-filtering sites (candidate lists, coverage math)
	 * use `reachable` directly so the counter stays "contacts refused", not "ids filtered".
	 */
	contactAllowed(a: string, b: string): boolean {
		if (this.reachable(a, b)) return true
		this.crossPartitionBlockedCount++
		return false
	}

	/** True while a partition is applied (any group assignment present). */
	isActive(): boolean {
		return this.partitionOf.size > 0
	}

	/** Group the id resolves to (absent id → group 0 — the mid-split-joiner rule above). */
	groupOf(id: string): number {
		return this.partitionOf.get(id) ?? 0
	}
}
