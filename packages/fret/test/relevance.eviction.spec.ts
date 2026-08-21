import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import type { Libp2p } from 'libp2p'
import { createMemNode } from './helpers/libp2p.js'
import { ringOffset } from './helpers/ring.js'
import { serializedPeer, tableOf } from './helpers/serialized-table.js'
import { FretService } from '../src/service/fret-service.js'
import { hashPeerId, COORD_BYTES } from '../src/ring/hash.js'
import { createSparsityModel, initialRelevance, recordSuccess } from '../src/store/relevance.js'
import type { MembershipState, PeerEntry, PeerState, SerializedPeerEntry } from '../src/store/digitree-store.js'

/**
 * Capacity enforcement and victim selection — the service-level half of relevance scoring.
 * (The scoring functions themselves are covered by `relevance.properties.spec.ts`.)
 *
 * `docs/fret.md` describes successor/predecessor members as carrying "infinite relevance".
 * There is no infinite score anywhere in the code: it is implemented as a *protection set* in
 * `FretService.enforceCapacity`, which asks the store for the live members immediately around
 * self and skips them while evicting lowest-relevance-first. These tests pin that — including
 * the cases where protection is *not* granted (dead, foreign, unknown) and the case where it
 * outweighs the cap entirely.
 *
 * `enforceCapacity` and `stabilizeOnce` are private; `importTable` is the public call that runs
 * enforcement, so it is the lever throughout (see `enforce()` below).
 */

const NETWORK = 'relevance-eviction-test'

/**
 * Fixed clock and ring position for the one fixture below that *derives* its relevances instead
 * of stating them.
 *
 * Every scoring call blends in a recency term, so `lastAccess` and `now` must be the same
 * instant or the derived numbers move by however long the test took. `X_SHARED` is the
 * normalized log distance both arms are scored at — the same value for each, so the comparison
 * is between frequency credit and hearsay rather than between two ring positions.
 */
const FIXED_NOW = 1_700_000_000_000
const X_SHARED = 0.5

/** A peer to place on the ring relative to self, with the state a fixture cares about. */
interface Placed {
	id: string
	coord: Uint8Array
	relevance: number
	membership?: MembershipState
	state?: PeerState
}

/**
 * Four peers immediately around self (two clockwise, two counter-clockwise) at relevances far
 * below every far peer, plus six far peers at ascending relevance 1.0 … 6.0.
 *
 * Offsets are exact modulo 2^256 (`ringOffset`), so the clockwise order from self is
 * `self, +1, +2, +1000 … +6000, -2, -1` whatever self's coordinate is — including when the
 * arithmetic wraps, which the store's ring walks handle by wrapping too.
 *
 * Every relevance is **distinct**, including among the four near peers. Equal-relevance entries
 * evict in `Array.prototype.sort` order, which is not a documented contract, so no fixture here
 * may have an outcome that depends on it.
 */
function standardLayout(self: Uint8Array): Placed[] {
	return [
		{ id: 'near-cw-1', coord: ringOffset(self, 1), relevance: 0.01 },
		{ id: 'near-cw-2', coord: ringOffset(self, 2), relevance: 0.02 },
		{ id: 'near-ccw-1', coord: ringOffset(self, -1), relevance: 0.03 },
		{ id: 'near-ccw-2', coord: ringOffset(self, -2), relevance: 0.04 },
		...Array.from({ length: 6 }, (_, i) => ({
			id: `far-${i + 1}`,
			coord: ringOffset(self, (i + 1) * 1000),
			relevance: i + 1,
		})),
	]
}

const NEAR_IDS = ['near-cw-1', 'near-cw-2', 'near-ccw-1', 'near-ccw-2']

function records(peers: Placed[]): SerializedPeerEntry[] {
	return peers.map((p) =>
		serializedPeer(p.id, p.coord, { relevance: p.relevance, membership: p.membership ?? 'member' })
	)
}

/**
 * Write peers straight into the store, bypassing import.
 *
 * Needed only for state a snapshot cannot express: `importEntries` forces every imported record
 * to `state: 'disconnected'`, so a `dead` peer has no snapshot representation at all.
 */
function place(svc: FretService, peers: Placed[]): void {
	const store = svc.getStore()
	for (const p of peers) {
		store.upsert(p.id, p.coord)
		store.update(p.id, {
			relevance: p.relevance,
			membership: p.membership ?? 'member',
			state: p.state ?? 'disconnected',
		})
	}
}

/**
 * Run capacity enforcement over whatever the store currently holds.
 *
 * The table is **deliberately empty**: nothing is being imported, the peers were written by
 * `place()` above. `importTable` is simply the public call that runs the private
 * `enforceCapacity` afterwards.
 */
async function enforce(svc: FretService): Promise<void> {
	await svc.importTable(tableOf([], 'enforce-trigger'))
}

function survivors(svc: FretService): string[] {
	return svc.getStore().list().map((e) => e.id)
}

describe('FretService capacity enforcement and victim selection', function () {
	this.timeout(30000)

	let node: Libp2p
	let svc: FretService | undefined
	let selfId: string
	let self: Uint8Array

	beforeEach(async () => {
		node = await createMemNode()
		await node.start()
		selfId = node.peerId.toString()
		self = await hashPeerId(node.peerId)
	})

	afterEach(async () => {
		try { await svc?.stop() } catch { /* already stopped */ }
		svc = undefined
		try { await node.stop() } catch { /* already stopped */ }
	})

	/**
	 * A service whose store holds self and nothing else, with no background loop left running.
	 *
	 * `start()` is what seeds self into the store as a `member` at relevance 0 — the entry every
	 * protection case here turns on — but it also arms the stabilization loop, whose first tick
	 * fires immediately and would score peers underneath the assertions. Stopping straight away
	 * keeps the real seeding path and removes that: `stop()` bumps the run generation and aborts
	 * the run signal, so no further tick arms and an in-flight one scores nothing (a cancelled
	 * probe is not evidence about a peer). `enforceCapacity` reads no run state, so import and
	 * enforcement behave exactly as they would in a running service.
	 */
	async function seededService(cfg: { m: number; capacity: number }): Promise<FretService> {
		const created = new FretService(node, { networkName: NETWORK, ...cfg })
		await created.start()
		await created.stop()
		svc = created
		return created
	}

	// The headline case, and the doc-promised path in *Routing table persistence*: importing a
	// table larger than capacity evicts by relevance — except where protection says otherwise.
	it('protects the ring neighbors around self even though they score lowest in the table', async () => {
		// m 3 → `ringNeighborsBothSides(self, 3)` → self plus the 3 nearest live members
		// clockwise and the 3 nearest counter-clockwise: 7 protected ids (`2m + 1`). The walk
		// over-fetches by one per side so self does not consume a slot, which is what makes the
		// m-th successor and m-th predecessor protected rather than evictable.
		//
		// Only ±1 and ±2 are placed near self, so the 3rd member on each side is a *far* peer:
		// `far-1` clockwise and `far-6` counter-clockwise (by wrap-around).
		const service = await seededService({ m: 3, capacity: 8 })

		const stored = await service.importTable(tableOf(records(standardLayout(self))))

		expect(stored, 'all ten records stored; self is not in the snapshot').to.equal(10)
		// 11 entries (10 imported + self), capacity 8, so 3 evictions. The four near peers are
		// the *lowest*-scoring entries in the whole table and survive anyway; `far-2` … `far-4`
		// are evicted despite outscoring them by two orders of magnitude.
		expect(survivors(service)).to.have.members([
			selfId,
			...NEAR_IDS,
			'far-1',
			'far-5',
			'far-6',
		])
	})

	// The specific arm the `2m + 1` protection set buys: the *m-th* member on each side. Both
	// walks are anchored exactly on self, so before the over-fetch each spent a slot on self and
	// protected only `m - 1` peers per side, leaving these two evictable despite being genuine
	// S(p) / P(p) members. Here they are also the two lowest-scoring entries in the whole table,
	// so surviving can only be protection — nothing about their relevance would save them.
	it('protects the m-th successor and m-th predecessor, the outermost member on each side', async () => {
		const service = await seededService({ m: 3, capacity: 8 })
		const ring: Placed[] = [
			{ id: 'succ-1', coord: ringOffset(self, 1), relevance: 0.05 },
			{ id: 'succ-2', coord: ringOffset(self, 2), relevance: 0.04 },
			{ id: 'succ-3', coord: ringOffset(self, 3), relevance: 0.01 },
			{ id: 'pred-1', coord: ringOffset(self, -1), relevance: 0.06 },
			{ id: 'pred-2', coord: ringOffset(self, -2), relevance: 0.03 },
			{ id: 'pred-3', coord: ringOffset(self, -3), relevance: 0.02 },
		]
		const far: Placed[] = Array.from({ length: 4 }, (_, i) => ({
			id: `far-${i + 1}`,
			coord: ringOffset(self, (i + 1) * 1000),
			relevance: i + 1,
		}))

		await service.importTable(tableOf(records([...ring, ...far])))

		const ids = survivors(service)
		// 11 entries, capacity 8, so 3 evictions — and every one of them is a far peer scoring
		// one to two orders of magnitude above the ring members that survive.
		expect(ids, 'm-th successor protected').to.include('succ-3')
		expect(ids, 'm-th predecessor protected').to.include('pred-3')
		expect(ids).to.have.members([
			selfId, 'succ-1', 'succ-2', 'succ-3', 'pred-1', 'pred-2', 'pred-3', 'far-4',
		])
	})

	// Self is added to the protection set explicitly, not drawn from the ring walk. On a ring
	// whose only live member is self the walk returns nothing at all — a filtered walk that
	// matches only self yields an empty list, since self is excluded by id — so relying on the
	// walk to carry self would leave the lowest-scoring entry in the table unprotected.
	it('protects self when the ring walk returns nothing because no other peer is a live member', async () => {
		const service = await seededService({ m: 3, capacity: 1 })
		place(service, [
			{ id: 'foreign-1', coord: ringOffset(self, 1), relevance: 5, membership: 'foreign' },
			{ id: 'foreign-2', coord: ringOffset(self, -1), relevance: 6, membership: 'foreign' },
			{ id: 'foreign-3', coord: ringOffset(self, 2), relevance: 7, membership: 'foreign' },
		])

		await enforce(service)

		// Self alone is protected and is also the lowest-scoring entry (relevance 0), so a
		// protection set drawn purely from the walk would have evicted it first.
		expect(survivors(service)).to.deep.equal([selfId])
	})

	// `standardLayout` gives the far peers ascending relevance in ascending ring order, so
	// relevance order, ring order and insertion order all coincide there — an implementation that
	// evicted in `list()` (ring) order would satisfy the case above. This one breaks the tie:
	// the far peers score *descending* with ring distance, so only a relevance-ordered eviction
	// keeps the ring-nearest far peer.
	it('picks victims by relevance, not by ring position or insertion order', async () => {
		const service = await seededService({ m: 3, capacity: 8 })
		const layout: Placed[] = [
			...standardLayout(self).filter((p) => NEAR_IDS.includes(p.id)),
			...Array.from({ length: 6 }, (_, i) => ({
				id: `far-${i + 1}`,
				coord: ringOffset(self, (i + 1) * 1000),
				relevance: 6 - i,
			})),
		]

		await service.importTable(tableOf(records(layout)))

		// Protection is unchanged (self, the four near peers, and the 3rd member on each side —
		// `far-1` and `far-6`), so the one survivor decided by score is `far-2` at 5.0: the
		// ring-*nearest* unprotected far peer, and therefore the first a ring-ordered loop would
		// have evicted.
		expect(survivors(service)).to.have.members([selfId, ...NEAR_IDS, 'far-1', 'far-2', 'far-6'])
	})

	it('drops a dead neighbor from protection and shifts the window outward rather than shrinking it', async () => {
		const service = await seededService({ m: 3, capacity: 8 })
		place(service, standardLayout(self))
		// Written directly, not imported: `importEntries` forces every record to
		// `state: 'disconnected'`, so `dead` is unreachable through a snapshot.
		service.getStore().setState('near-cw-2', 'dead')

		await enforce(service)

		const ids = survivors(service)
		expect(ids, 'dead neighbor lost its protection').to.not.include('near-cw-2')
		// Both halves matter. The filtered ring walk *skips and keeps advancing*, so the
		// clockwise window does not shrink to two peers — it reaches past the dead peer to the
		// next live members, `far-1` and `far-2`. That is why both survive at relevance 1.0 and
		// 2.0 while `far-3` and `far-4` are evicted despite scoring higher.
		expect(ids, 'window reached past the dead peer').to.include('far-1')
		expect(ids).to.include('far-2')
		expect(ids).to.not.include('far-3')
		expect(ids).to.have.members([
			selfId, 'near-cw-1', 'near-ccw-1', 'near-ccw-2', 'far-1', 'far-2', 'far-5', 'far-6',
		])
	})

	// Protection is `membership === 'member' && state !== 'dead'`, so sitting next to self buys
	// an unclassified or confirmed-foreign peer nothing — it is evicted at its own low relevance
	// and the window reaches past it, exactly as for a dead peer.
	for (const membership of ['foreign', 'unknown'] as const) {
		it(`does not protect an adjacent peer labelled ${membership}`, async () => {
			const service = await seededService({ m: 3, capacity: 8 })
			const layout = standardLayout(self).map((p) =>
				p.id.startsWith('near-cw') ? { ...p, membership } : p
			)

			await service.importTable(tableOf(records(layout)))

			const ids = survivors(service)
			expect(ids).to.not.include('near-cw-1')
			expect(ids).to.not.include('near-cw-2')
			// The clockwise window reached past both of them, so the three nearest live members
			// clockwise are now `far-1` … `far-3` — protected despite being mid-table, while
			// `far-4` is evicted at a higher score.
			expect(ids).to.have.members([
				selfId, 'near-ccw-1', 'near-ccw-2', 'far-1', 'far-2', 'far-3', 'far-5', 'far-6',
			])
		})
	}

	// Self is seeded `member`, is never marked dead, and occupies a slot in *both* walks, so it
	// is protected in every case above. It is also the single lowest-scoring entry in the table
	// (`upsert` seeds relevance 0), which is what makes this worth asserting on its own: sorted
	// by relevance, self is the very first entry the eviction loop considers.
	it('never evicts self, even though self scores lowest of all', async () => {
		const service = await seededService({ m: 3, capacity: 6 })
		expect(service.getStore().getById(selfId)?.relevance, 'self is seeded at relevance 0').to.equal(0)

		await service.importTable(tableOf(records(standardLayout(self))))

		expect(survivors(service)).to.include(selfId)
	})

	// ------------------------------------------------------------------------------------
	// The user-visible point of scoring gossip flat: a peer we have actually contacted must
	// survive a capacity squeeze against one we have only ever been told about. Without that,
	// a peer named in hundreds of merged snapshots could outrank one we had pinged hundreds of
	// times, and eviction would drop the peer we can actually reach.
	//
	// The two relevances are **computed, not copied**. `place()` takes a literal number, so
	// hand-writing the values from the design work would assert on constants and would still
	// pass with `recordSuccess` / `initialRelevance` deleted. Derived here, the fixture *is*
	// the two scoring arms.
	//
	// One **shared** sparsity model, unlike the isolated ones `relevance.properties.spec.ts`
	// uses for the same comparison: `enforceCapacity` ranks the scores as *stored*, and every
	// stored score in a running service was written under one service-wide model. Sharing it is
	// the property under test here, where isolating it is the property under test there.
	//
	// Scoring the gossiped entry first is the conservative order: `recordSuccess` observes the
	// distance and `initialRelevance` does not, so the 500 successes raise the model occupancy
	// at `X_SHARED` and each one is scored under a *lower* sparsity bonus than the gossiped
	// entry got from the pristine model. Frequency credit wins anyway.
	// ------------------------------------------------------------------------------------
	it('evicts a peer we were only ever told about before one we actually contacted', async () => {
		const model = createSparsityModel()
		const fresh: PeerEntry = {
			id: 'derivation-only', coord: new Uint8Array(COORD_BYTES), relevance: 0,
			lastAccess: FIXED_NOW, state: 'disconnected', membership: 'member',
			negotiateFailures: 0, lastNegotiateFailureAt: 0,
			contactFailures: 0, lastContactFailureAt: 0,
			accessCount: 0, successCount: 0, failureCount: 0, avgLatencyMs: null,
		}

		// Named once and then named 500 more times: `FretService.noteDiscovered` scores a new
		// entry once from its own empty counters and leaves an id it already holds untouched,
		// so the further mentions write nothing. One `initialRelevance` is the whole arm.
		const gossipedRelevance = initialRelevance(fresh, X_SHARED, model, FIXED_NOW)

		let contactedEntry = fresh
		for (let i = 0; i < 500; i++) {
			contactedEntry = recordSuccess(contactedEntry, undefined, X_SHARED, model, FIXED_NOW)
		}
		const contactedRelevance = contactedEntry.relevance

		expect(contactedEntry.accessCount, 'only proven contact accrues frequency credit').to.equal(500)
		expect(contactedRelevance, 'the fixture is the ordering under test').to.be.greaterThan(gossipedRelevance)

		// m 3, so protection is self plus the 3 nearest live members on each side: the four
		// near peers, `far-1` clockwise, and `far-6` counter-clockwise by wrap-around. Both
		// fixture peers sit at +2000 / +3000 — the 4th and 5th live members clockwise — so
		// they are the *only* unprotected entries and relevance alone decides between them.
		const service = await seededService({ m: 3, capacity: 8 })
		place(service, [
			{ id: 'near-cw-1', coord: ringOffset(self, 1), relevance: 0.01 },
			{ id: 'near-cw-2', coord: ringOffset(self, 2), relevance: 0.02 },
			{ id: 'near-ccw-1', coord: ringOffset(self, -1), relevance: 0.03 },
			{ id: 'near-ccw-2', coord: ringOffset(self, -2), relevance: 0.04 },
			{ id: 'far-1', coord: ringOffset(self, 1000), relevance: 3 },
			{ id: 'contacted', coord: ringOffset(self, 2000), relevance: contactedRelevance },
			{ id: 'gossiped', coord: ringOffset(self, 3000), relevance: gossipedRelevance },
			{ id: 'far-6', coord: ringOffset(self, 6000), relevance: 4 },
		])

		await enforce(service)

		// 9 entries (8 placed + self) against a capacity of 8, so exactly one eviction.
		const ids = survivors(service)
		expect(ids, 'proven contact survives the squeeze').to.include('contacted')
		expect(ids, 'hearsay does not').to.not.include('gossiped')
		// `contacted` also sits *nearer* self in ring order than `gossiped`, so a ring-ordered
		// eviction loop would have taken it instead — the survival is relevance, not position.
		expect(ids).to.have.members([
			selfId, ...NEAR_IDS, 'far-1', 'contacted', 'far-6',
		])
	})

	// The tripwire recorded at `enforceCapacity`: protection wins over the cap, so a capacity
	// below the size of the protected set is not a bound at all. Only reachable by
	// misconfiguration (`capacity < 2m + 1`), and pinned here as current behavior rather than as
	// something desirable.
	it('leaves the table over capacity when the protected set is larger than the cap', async () => {
		const service = await seededService({ m: 8, capacity: 4 })
		// 20 live members packed around self at ±1 … ±10.
		place(service, Array.from({ length: 20 }, (_, i) => {
			const step = Math.floor(i / 2) + 1
			const sign = i % 2 === 0 ? 1 : -1
			return { id: `ring-${sign * step}`, coord: ringOffset(self, sign * step), relevance: 1 + i }
		}))

		await enforce(service)

		// Protection breadth 8: self + 8 clockwise + 8 counter-clockwise = 17 protected ids
		// (`2m + 1`). The four peers beyond that window (±9, ±10) are evicted and the loop then
		// runs out of candidates, more than four times over the configured cap of 4.
		expect(service.getStore().size(), 'protected set is the floor, not the capacity').to.equal(17)
		expect(service.getStore().size()).to.be.greaterThan(4)
		expect(survivors(service)).to.include(selfId)
	})

	it('protects neighbors on an import that runs before start() has cached the self coordinate', async () => {
		// Deliberately never started: `start()` is what hashes and caches self's ring coordinate
		// *and* what seeds self into the store, so neither is available here. Enforcement
		// `await`s `selfCoord()` rather than reading the cache, which is exactly what this
		// covers — without the await it has no coordinate to protect around.
		const service = new FretService(node, { networkName: NETWORK, m: 3, capacity: 6 })
		svc = service

		await service.importTable(tableOf(records(standardLayout(self))))

		const ids = survivors(service)
		expect(ids, 'self is not in the store before start()').to.not.include(selfId)
		// With no self entry the walks start at the first peer on each side, so the protected
		// set is the four near peers plus one far peer per side (`far-1` clockwise, and `far-6`
		// counter-clockwise by wrap-around).
		for (const id of NEAR_IDS) expect(ids, `${id} protected without a cached self coord`).to.include(id)
		expect(ids).to.have.members([...NEAR_IDS, 'far-1', 'far-6'])
	})

	it('handles an empty import without evicting self', async () => {
		const service = await seededService({ m: 3, capacity: 1 })

		const stored = await service.importTable(tableOf([]))

		expect(stored).to.equal(0)
		expect(survivors(service)).to.deep.equal([selfId])
	})

	it('handles a single-entry table at a capacity of 1', async () => {
		const service = await seededService({ m: 3, capacity: 1 })

		const stored = await service.importTable(tableOf(records([
			{ id: 'only-peer', coord: ringOffset(self, 1), relevance: 5 },
		])))

		expect(stored).to.equal(1)
		// Both entries are inside the protected window, so nothing is evictable and the table
		// stays one over the cap — the same protection-beats-capacity behavior as the
		// over-subscribed case above, reached here with the smallest possible table.
		expect(survivors(service)).to.have.members([selfId, 'only-peer'])
	})
})
