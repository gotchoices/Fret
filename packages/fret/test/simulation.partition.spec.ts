import { describe, it } from 'mocha'
import { expect } from 'chai'
import { FretSimulation, type SimConfig } from './simulation/fret-sim.js'
import type { SimMetrics } from './simulation/sim-metrics.js'

/**
 * Partition / merge behavior of the deterministic simulation harness.
 *
 * Each scenario runs one seeded ring through three phases — converge, cut (partition), heal —
 * and asserts that nothing crosses the cut, each half re-forms its own ring via contact-failure
 * escalation, and the halves knit back together via the dead-entry re-probe path after heal().
 */

/** Baseline coverage threshold — the same bar the churn-recovery suite calibrates against. */
const COVERAGE_THRESHOLD = 0.8

/**
 * Drive every event scheduled up to `uptoMs`, one at a time, then park the clock there.
 *
 * Deliberately not `for (const evt of scheduler.advanceTo(uptoMs))`: that shifts the whole
 * batch first and leaves the clock at `uptoMs`, so every tick in the window is processed at
 * the *window's* timestamp rather than its own — which the dead-entry re-probe reads when it
 * stamps and orders candidates.
 */
function pump(sim: FretSimulation, uptoMs: number): void {
	while ((sim.scheduler.peek()?.time ?? Infinity) <= uptoMs) {
		sim.processEvent(sim.scheduler.nextEvent()!)
	}
	sim.scheduler.advanceTo(uptoMs)
}

function compareCoords(a: Uint8Array, b: Uint8Array): number {
	for (let i = 0; i < a.length; i++) {
		if (a[i]! !== b[i]!) return a[i]! - b[i]!
	}
	return 0
}

/** Alive peer ids in ring-coordinate order — the basis for contiguous group splits. */
function aliveByCoord(sim: FretSimulation): string[] {
	return Array.from(sim.getPeers().values())
		.filter((p) => p.alive)
		.sort((a, b) => compareCoords(a.coord, b.coord))
		.map((p) => p.id)
}

/**
 * Contiguous halves by ring coordinate. Contiguity matters for the routing assertions: a
 * coordinate well inside one arc has both its ring successor and predecessor on that side,
 * so a cross-cut route cannot "succeed" by landing on a same-side predecessor.
 */
function contiguousHalves(sim: FretSimulation): [string[], string[]] {
	const ids = aliveByCoord(sim)
	const mid = Math.floor(ids.length / 2)
	return [ids.slice(0, mid), ids.slice(mid)]
}

function coordOf(sim: FretSimulation, id: string): Uint8Array {
	return sim.getPeers().get(id)!.coord
}

/** Schedule one route, pump past it, and report whether it succeeded. */
function routeOnce(sim: FretSimulation, fromId: string, target: Uint8Array, atMs: number): boolean {
	const before = sim.metrics.getMetrics()
	const attempts = before.routingAttempts
	const successes = before.routingSuccesses
	sim.scheduleRoute(fromId, target, atMs)
	pump(sim, atMs + 1)
	const after = sim.metrics.getMetrics()
	expect(after.routingAttempts, 'route event should have fired').to.equal(attempts + 1)
	return after.routingSuccesses === successes + 1
}

/** Every entry a `sideA` store holds for a `sideB` peer must be dead (or absent). */
function assertNoLiveCross(sim: FretSimulation, sideA: string[], sideB: string[], label: string): void {
	for (const aId of sideA) {
		const store = sim.getStores().get(aId)!
		for (const bId of sideB) {
			const entry = store.getById(bId)
			if (entry && entry.state !== 'dead') {
				throw new Error(`${label}: ${aId} holds live entry for ${bId} (state=${entry.state})`)
			}
		}
	}
}

/** No alive peer's store may hold any dead entry (post-heal recovery check). */
function assertNoDeadEntries(sim: FretSimulation, label: string): void {
	for (const [id, store] of sim.getStores()) {
		const peer = sim.getPeers().get(id)
		if (!peer || !peer.alive) continue
		for (const entry of store.list()) {
			if (entry.state === 'dead') {
				throw new Error(`${label}: ${id} still holds dead entry for ${entry.id}`)
			}
		}
	}
}

describe('Partition and merge simulation', function () {
	this.timeout(60000)

	it('two-way split: halves escalate, re-form their rings, and heal back together', () => {
		const sim = new FretSimulation({
			seed: 4242,
			n: 40,
			k: 15,
			m: 8,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 20000,
		})
		sim.initialize()

		// Phase 1: converge.
		pump(sim, 3000)
		const baseline = sim.snapshotCoverage()
		console.log('  Baseline coverage:', (baseline * 100).toFixed(1) + '%')
		expect(baseline).to.be.at.least(COVERAGE_THRESHOLD)

		const [groupA, groupB] = contiguousHalves(sim)
		const fromA = groupA[Math.floor(groupA.length / 2)]!
		const interiorB = groupB[Math.floor(groupB.length / 2)]!
		const interiorA = groupA[Math.floor(groupA.length / 4)]!

		// Baseline route across what will become the cut.
		expect(routeOnce(sim, fromA, coordOf(sim, interiorB), 3010), 'pre-cut A→B route').to.be.true

		// Phase 2: cut.
		sim.partition([groupA, groupB])
		expect(sim.crossPartitionBlocked()).to.equal(0)

		// deadAfterFailures (3) strikes at one per tick, plus slack.
		pump(sim, 5600)
		expect(sim.crossPartitionBlocked(), 'contacts must have been refused').to.be.greaterThan(0)
		assertNoLiveCross(sim, groupA, groupB, 'A-side after escalation')
		assertNoLiveCross(sim, groupB, groupA, 'B-side after escalation')

		// Let each half re-gossip its own arc, then measure per-reachable-population coverage.
		pump(sim, 7500)
		const cutCoverage = sim.snapshotCoverage()
		console.log('  Coverage during cut (per reachable population):', (cutCoverage * 100).toFixed(1) + '%')
		expect(cutCoverage).to.be.at.least(COVERAGE_THRESHOLD)

		// Neighbor sets are side-pure: nothing crossed the cut.
		const bSet = new Set(groupB)
		for (const aId of groupA) {
			for (const nid of sim.getPeers().get(aId)!.neighbors) {
				expect(bSet.has(nid), `${aId} neighbors cross-side ${nid}`).to.be.false
			}
		}

		// Routing respects the cut: A→A succeeds, A→B fails. Asserted BEFORE the mid-split
		// join below: the joiner's fresh coordinate can land inside B's arc while it belongs
		// to group 0, and knowing no B entries it would honestly claim anchor-hood there —
		// a legitimate local view, but not the cross-cut refusal this assertion pins.
		expect(routeOnce(sim, fromA, coordOf(sim, interiorA), 7510), 'A→A route during cut').to.be.true
		expect(routeOnce(sim, fromA, coordOf(sim, interiorB), 7530), 'A→B route during cut').to.be.false

		// A joiner during the split lands in group 0 (the A side) and must see only that side.
		const preJoinIds = new Set(sim.getPeers().keys())
		sim.scheduleBatchJoin(1, 7550)
		pump(sim, 8000)
		const joinerId = Array.from(sim.getPeers().keys()).find((id) => !preJoinIds.has(id))!
		const joinerStore = sim.getStores().get(joinerId)!
		for (const entry of joinerStore.list()) {
			if (entry.id === joinerId) continue
			expect(bSet.has(entry.id), `joiner learned cross-side ${entry.id}`).to.be.false
		}

		// Phase 3: heal. Re-probe revives ~20 dead entries per store at 2/tick.
		sim.heal()
		pump(sim, 15500)
		assertNoDeadEntries(sim, 'post-heal')
		const healedCoverage = sim.snapshotCoverage()
		console.log('  Post-heal coverage:', (healedCoverage * 100).toFixed(1) + '%')
		expect(healedCoverage).to.be.at.least(COVERAGE_THRESHOLD)
		expect(routeOnce(sim, fromA, coordOf(sim, interiorB), 15600), 'post-heal A→B route').to.be.true
	})

	it('a route across a fresh cut fails by refused contacts, not by an oracle filter', () => {
		// The lifecycle test above asserts the A→B route fails *after* escalation, by which
		// point every cross entry is already dead and the pool is empty — a correct outcome
		// that would also hold if the router filtered candidates by the global partition map.
		// This one routes in the window between the cut and escalation, where the cross
		// entries are still alive in the store, so the only way the route can fail is by
		// attempting contacts and having them refused. That is what pins the router to local
		// knowledge.
		const sim = new FretSimulation({
			seed: 4242,
			n: 40,
			k: 15,
			m: 8,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 20000,
		})
		sim.initialize()
		pump(sim, 3000)

		const [groupA, groupB] = contiguousHalves(sim)
		const fromA = groupA[Math.floor(groupA.length / 2)]!
		const interiorB = groupB[Math.floor(groupB.length / 2)]!
		expect(routeOnce(sim, fromA, coordOf(sim, interiorB), 3010), 'pre-cut A→B route').to.be.true

		sim.partition([groupA, groupB])
		const blockedBefore = sim.crossPartitionBlocked()

		// No pump between the cut and the route: nothing has struck a cross entry yet.
		const store = sim.getStores().get(fromA)!
		const liveCross = groupB.filter((id) => {
			const e = store.getById(id)
			return e !== undefined && e.state !== 'dead'
		})
		expect(liveCross.length, 'cross entries must still be live for this to prove anything')
			.to.be.greaterThan(0)

		expect(routeOnce(sim, fromA, coordOf(sim, interiorB), 3020), 'A→B route across a fresh cut')
			.to.be.false
		expect(
			sim.crossPartitionBlocked() - blockedBefore,
			'the route itself must have attempted contacts and had them refused',
		).to.be.greaterThan(0)

		// Each refusal struck exactly one entry, so a cross entry the route actually tried now
		// carries a strike it did not carry before.
		const struck = groupB.filter((id) => (store.getById(id)?.contactFailures ?? 0) > 0)
		expect(struck.length, 'a refused contact must strike that entry').to.be.greaterThan(0)
	})

	it('singleton split: coverage stays defined and the peer recovers after heal', () => {
		const sim = new FretSimulation({
			seed: 909,
			n: 24,
			k: 15,
			m: 8,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 12000,
			// 23 dead entries to revive on the singleton — widen the per-tick budget so the
			// merge completes inside the heal window.
			deadReprobePerTick: 8,
		})
		sim.initialize()
		pump(sim, 3000)
		expect(sim.snapshotCoverage()).to.be.at.least(COVERAGE_THRESHOLD)

		const ids = aliveByCoord(sim)
		const singleton = ids[0]!
		const rest = ids.slice(1)
		sim.partition([[singleton], rest])

		pump(sim, 5600)
		const single = sim.getPeers().get(singleton)!
		expect(single.neighbors.size, 'singleton live neighbor count').to.equal(0)
		const cutCoverage = sim.snapshotCoverage()
		expect(Number.isFinite(cutCoverage), 'coverage must be defined').to.be.true
		expect(Number.isNaN(cutCoverage)).to.be.false
		expect(cutCoverage).to.be.at.least(COVERAGE_THRESHOLD)

		sim.heal()
		pump(sim, 10000)
		assertNoDeadEntries(sim, 'post-heal singleton')
		expect(single.neighbors.size, 'singleton neighbors after heal').to.be.at.least(8)
		expect(sim.snapshotCoverage()).to.be.at.least(COVERAGE_THRESHOLD)
	})

	it('three-way split escalates all pairs and heals from all three groups at once', () => {
		const sim = new FretSimulation({
			seed: 333,
			n: 30,
			k: 15,
			m: 8,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 14000,
			deadReprobePerTick: 6,
		})
		sim.initialize()
		pump(sim, 3000)
		expect(sim.snapshotCoverage()).to.be.at.least(COVERAGE_THRESHOLD)

		const ids = aliveByCoord(sim)
		const third = Math.floor(ids.length / 3)
		const groups = [ids.slice(0, third), ids.slice(third, 2 * third), ids.slice(2 * third)]
		sim.partition(groups)

		pump(sim, 5600)
		expect(sim.crossPartitionBlocked()).to.be.greaterThan(0)
		for (let i = 0; i < groups.length; i++) {
			for (let j = 0; j < groups.length; j++) {
				if (i === j) continue
				assertNoLiveCross(sim, groups[i]!, groups[j]!, `group ${i} vs ${j}`)
			}
		}

		pump(sim, 6500)
		expect(sim.snapshotCoverage(), 'per-group coverage during 3-way cut').to.be.at.least(COVERAGE_THRESHOLD)

		sim.heal()
		pump(sim, 13500)
		assertNoDeadEntries(sim, 'post-heal three-way')
		expect(sim.snapshotCoverage()).to.be.at.least(COVERAGE_THRESHOLD)
	})

	it('a leave during a cut notifies only the leaver own side', () => {
		const sim = new FretSimulation({
			seed: 5150,
			n: 24,
			k: 10,
			m: 6,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 10000,
		})
		sim.initialize()
		pump(sim, 3000)

		const [groupA, groupB] = contiguousHalves(sim)
		sim.partition([groupA, groupB])
		const blockedBeforeLeave = sim.crossPartitionBlocked()

		// Depart between ticks, before any escalation has run: both sides still hold a live
		// entry for the leaver, so what removes it on the A side can only be the notice.
		const leaver = groupA[1]!
		sim.scheduler.scheduleAt({ type: 'leave', peerId: leaver }, 3100)
		pump(sim, 3200)

		// The notice fan-out walks every alive peer once, so the refusals it books are exactly
		// the far side's population — nothing else ran in this window to add to the count.
		expect(sim.crossPartitionBlocked() - blockedBeforeLeave, 'refusals booked by the leave fan-out')
			.to.equal(groupB.length)

		for (const aId of groupA) {
			if (aId === leaver) continue
			expect(sim.getStores().get(aId)!.getById(leaver), `${aId} should have taken the notice`)
				.to.equal(undefined)
		}
		const bStillHolding = groupB.filter((bId) => sim.getStores().get(bId)!.getById(leaver))
		expect(bStillHolding.length, 'the far side must not have been told').to.be.greaterThan(0)

		// The far side finds out on its own, without a notice.
		pump(sim, 5000)
		for (const bId of groupB) {
			expect(sim.getStores().get(bId)!.getById(leaver), `${bId} should have swept the departed peer`)
				.to.equal(undefined)
		}
	})

	it('messages in flight at the cut are dropped at delivery, not delivered late', () => {
		const sim = new FretSimulation({
			seed: 606,
			n: 20,
			k: 10,
			m: 5,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 6000,
			messageBus: {
				defaultLatencyMs: 200,
				defaultLossRate: 0,
				// Large queues so the only drops this test can record are partition drops.
				defaultQueueCapacity: 10000,
				latencyDistribution: 'constant',
				latencyJitter: 0,
			},
		})
		sim.initialize()

		// The stabilize tick at t=3000 sends snapshots due at t=3200 — in flight at the cut.
		pump(sim, 3000)
		const dropsBefore = sim.metrics.getMetrics().messageDrops
		const [a, b] = contiguousHalves(sim)
		sim.partition([a, b])

		pump(sim, 3600)
		const dropsAfter = sim.metrics.getMetrics().messageDrops
		expect(dropsAfter, 'in-flight cross-cut messages must be dropped').to.be.greaterThan(dropsBefore)
		expect(sim.crossPartitionBlocked()).to.be.greaterThan(0)
	})

	it('bus mode runs the whole cut/escalate/heal lifecycle, not just the in-flight drop', () => {
		const sim = new FretSimulation({
			seed: 8080,
			n: 24,
			k: 10,
			m: 6,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 24000,
			deadReprobePerTick: 6,
			messageBus: {
				defaultLatencyMs: 50,
				defaultLossRate: 0,
				defaultQueueCapacity: 10000,
				latencyDistribution: 'constant',
				latencyJitter: 0,
			},
		})
		sim.initialize()
		pump(sim, 5000)
		expect(sim.snapshotCoverage(), 'bus-mode baseline').to.be.at.least(COVERAGE_THRESHOLD)

		const [groupA, groupB] = contiguousHalves(sim)
		sim.partition([groupA, groupB])

		pump(sim, 11000)
		expect(sim.crossPartitionBlocked()).to.be.greaterThan(0)
		assertNoLiveCross(sim, groupA, groupB, 'bus A-side after escalation')
		assertNoLiveCross(sim, groupB, groupA, 'bus B-side after escalation')
		expect(sim.snapshotCoverage(), 'bus-mode coverage during cut').to.be.at.least(COVERAGE_THRESHOLD)

		sim.heal()
		pump(sim, 20000)
		assertNoDeadEntries(sim, 'bus post-heal')
		expect(sim.snapshotCoverage(), 'bus-mode coverage after heal').to.be.at.least(COVERAGE_THRESHOLD)
	})

	it('heal without partition, single-group partition, and duplicate listing are all benign', () => {
		const sim = new FretSimulation({
			seed: 11,
			n: 8,
			k: 5,
			m: 3,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 8000,
		})
		sim.initialize()

		// heal() with no partition active: defined no-op.
		sim.heal()
		pump(sim, 2000)
		expect(sim.crossPartitionBlocked()).to.equal(0)

		const ids = aliveByCoord(sim)

		// An id naming no peer is rejected: it reads back identically to a mid-split joiner, so
		// accepting one would sort every real peer into a single group and make the split a
		// silent no-op the calling test would still pass.
		expect(() => sim.partition([['peer-nope'], ids])).to.throw(/unknown peer id/)
		expect(sim.crossPartitionBlocked()).to.equal(0)

		// A single group blocks nothing (everyone resolves to group 0, absent ids included).
		sim.partition([ids])
		pump(sim, 3000)
		expect(sim.crossPartitionBlocked()).to.equal(0)

		// A peer listed in two groups keeps its last listing — here everyone lands in group 1,
		// so nothing is blocked and the map is not corrupted.
		sim.partition([[ids[0]!], ids])
		pump(sim, 4000)
		expect(sim.crossPartitionBlocked()).to.equal(0)

		// A second partition() replaces the first: after replacing a real split with a single
		// group, refusals stop accruing.
		sim.partition([[ids[0]!], ids.slice(1)])
		pump(sim, 4500)
		const blockedDuringSplit = sim.crossPartitionBlocked()
		expect(blockedDuringSplit).to.be.greaterThan(0)
		sim.partition([ids])
		pump(sim, 6000)
		expect(sim.crossPartitionBlocked()).to.equal(blockedDuringSplit)
		sim.heal()
	})

	it('deterministic replay: same seed and same partition/heal schedule → identical metrics', () => {
		function scriptedRun(): { metrics: SimMetrics; blocked: number } {
			const config: SimConfig = {
				seed: 7331,
				n: 30,
				k: 15,
				m: 8,
				churnRatePerSec: 0,
				stabilizationIntervalMs: 500,
				durationMs: 13000,
			}
			const sim = new FretSimulation(config)
			sim.initialize()
			pump(sim, 2500)
			const [a, b] = contiguousHalves(sim)
			sim.partition([a, b])
			pump(sim, 5000)
			sim.scheduleRoute(a[2]!, coordOf(sim, b[3]!), 5010)
			sim.scheduleRoute(a[2]!, coordOf(sim, a[5]!), 5020)
			sim.scheduleBatchJoin(1, 5030)
			pump(sim, 6000)
			sim.heal()
			pump(sim, 12500)
			return { metrics: sim.metrics.finalize(), blocked: sim.crossPartitionBlocked() }
		}

		const run1 = scriptedRun()
		const run2 = scriptedRun()
		expect(JSON.stringify(run1.metrics)).to.equal(JSON.stringify(run2.metrics))
		expect(run1.blocked).to.equal(run2.blocked)
	})
})
