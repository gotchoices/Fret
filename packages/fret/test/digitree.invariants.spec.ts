import { describe, it } from 'mocha'
import { expect } from 'chai'
import fc from 'fast-check'
import {
	DigitreeStore,
	type MembershipState,
	type PeerState,
	type RingCursor,
	type SerializedPeerEntry,
} from '../src/store/digitree-store.js'
import { coordToBase64url } from '../src/ring/hash.js'

// The store keeps two views of the same population: the ordered tree (every ring walk,
// `list`, `exportEntries`) and the id index (`getById`, `remove`, `update`, `size`).
// Because the tree key embeds the coordinate, a coordinate change is a *re-key*, and every
// write path that re-derives that bookkeeping for itself has a way to get it wrong. The
// invariant that everything above the store rests on:
//
//   Exactly one tree entry exists per peer id, and the id index maps that id to that
//   entry's current key.
//
// The property test below drives an arbitrary op sequence and asserts it. It is the part
// that retires the bug class: a future write path that bypasses the store's internal `put`
// seam fails here rather than shipping. The targeted cases after it document the concrete
// failures that motivated the seam.

const ID_POOL = 8
const COORD_POOL = 8

// Small pools on purpose: with 32 random bytes per coordinate, a re-key or a key collision
// would be astronomically unlikely to ever occur, and the property would pass vacuously.
const ids = Array.from({ length: ID_POOL }, (_, i) => `p${i}`)
const coords = Array.from({ length: COORD_POOL }, (_, i) => {
	const c = new Uint8Array(32)
	c[0] = i * 29
	c[31] = i
	return c
})

const STATES: PeerState[] = ['connected', 'disconnected', 'dead']
const MEMBERSHIPS: MembershipState[] = ['unknown', 'member', 'foreign']

type Op =
	| { kind: 'upsert'; id: number; coord: number }
	| { kind: 'recoord'; id: number; coord: number }
	| { kind: 'touch'; id: number; relevance: number }
	| { kind: 'import'; records: Array<{ id: number; coord: number }> }
	| { kind: 'reimport' }
	| { kind: 'remove'; id: number }
	| { kind: 'state'; id: number; state: PeerState }
	| { kind: 'membership'; id: number; membership: MembershipState }

const idArb = fc.integer({ min: 0, max: ID_POOL - 1 })
const coordArb = fc.integer({ min: 0, max: COORD_POOL - 1 })

const opArb: fc.Arbitrary<Op> = fc.oneof(
	fc.record({ kind: fc.constant('upsert' as const), id: idArb, coord: coordArb }),
	fc.record({ kind: fc.constant('recoord' as const), id: idArb, coord: coordArb }),
	fc.record({ kind: fc.constant('touch' as const), id: idArb, relevance: fc.double({ min: 0, max: 100, noNaN: true }) }),
	fc.record({
		kind: fc.constant('import' as const),
		records: fc.array(fc.record({ id: idArb, coord: coordArb }), { minLength: 1, maxLength: 4 }),
	}),
	fc.record({ kind: fc.constant('reimport' as const) }),
	fc.record({ kind: fc.constant('remove' as const), id: idArb }),
	fc.record({ kind: fc.constant('state' as const), id: idArb, state: fc.constantFrom(...STATES) }),
	fc.record({ kind: fc.constant('membership' as const), id: idArb, membership: fc.constantFrom(...MEMBERSHIPS) })
)

function serialized(id: string, coord: Uint8Array, over: Partial<SerializedPeerEntry> = {}): SerializedPeerEntry {
	return {
		id,
		coord: coordToBase64url(coord),
		relevance: 0,
		lastAccess: 0,
		state: 'disconnected',
		membership: 'unknown',
		accessCount: 0,
		successCount: 0,
		failureCount: 0,
		avgLatencyMs: null,
		...over,
	}
}

/**
 * The expected content of one entry. Everything the store derives from a clock
 * (`lastAccess`) is left out; the rest is fully determined by the op sequence.
 */
interface ModelEntry {
	coord: Uint8Array
	relevance: number
	state: PeerState
	membership: MembershipState
	accessCount: number
	successCount: number
	failureCount: number
	avgLatencyMs: number | null
	negotiateFailures: number
}

type Model = Map<string, ModelEntry>

const DEFAULTS: Omit<ModelEntry, 'coord'> = {
	relevance: 0,
	state: 'disconnected',
	membership: 'unknown',
	accessCount: 0,
	successCount: 0,
	failureCount: 0,
	avgLatencyMs: null, // never measured — the store's default for a fresh entry
	negotiateFailures: 0,
}

// Each op is applied to the store and to an independent model of what the store should
// hold. Checking structure alone is not enough: a write path can keep the two structures
// consistent in *count* while silently discarding the data it was asked to store (that is
// exactly what a conflicting tree insert does), so the model comparison is what makes this
// property catch a lost write rather than only a lost entry.
function applyOp(store: DigitreeStore, model: Model, op: Op): void {
	switch (op.kind) {
		case 'upsert': {
			const id = ids[op.id]!
			const coord = coords[op.coord]!
			store.upsert(id, coord)
			// "Ensure an entry exists": refresh the coord, preserve every other field.
			const prev = model.get(id)
			model.set(id, prev ? { ...prev, coord } : { ...DEFAULTS, coord })
			return
		}
		case 'recoord': {
			// Only meaningful on an existing entry; `update` no-ops on an unknown id.
			const id = ids[op.id]!
			const coord = coords[op.coord]!
			store.update(id, { coord })
			const prev = model.get(id)
			if (prev) model.set(id, { ...prev, coord })
			return
		}
		case 'touch': {
			const id = ids[op.id]!
			store.update(id, { relevance: op.relevance })
			const prev = model.get(id)
			if (prev) model.set(id, { ...prev, relevance: op.relevance })
			return
		}
		case 'import': {
			store.importEntries(op.records.map((r) => serialized(ids[r.id]!, coords[r.coord]!)))
			// Replace-by-id: the snapshot wins outright, including a coordinate move.
			for (const r of op.records) model.set(ids[r.id]!, { ...DEFAULTS, coord: coords[r.coord]! })
			return
		}
		case 'reimport': {
			// Feed the store its own export. Every record collides with a live id at the same
			// key, so this is the replace-at-an-existing-key path applied to the whole
			// population at once — the one shape a single-record import never reaches.
			store.importEntries(store.exportEntries())
			// Import forces liveness and handshake history back to their cold-start values;
			// everything else round-trips unchanged.
			for (const [id, prev] of model)
				model.set(id, { ...prev, state: 'disconnected', negotiateFailures: 0 })
			return
		}
		case 'remove': {
			const id = ids[op.id]!
			store.remove(id)
			model.delete(id)
			return
		}
		case 'state': {
			const id = ids[op.id]!
			store.setState(id, op.state)
			const prev = model.get(id)
			if (prev) model.set(id, { ...prev, state: op.state })
			return
		}
		case 'membership': {
			const id = ids[op.id]!
			store.setMembership(id, op.membership)
			const prev = model.get(id)
			if (prev) model.set(id, { ...prev, membership: op.membership })
			return
		}
	}
}

function coordsEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
	return true
}

function checkAgainstModel(store: DigitreeStore, model: Model, context: string): void {
	if (store.size() !== model.size)
		throw new Error(`${context}: size() ${store.size()} !== expected ${model.size}`)
	for (const [id, want] of model) {
		const got = store.getById(id)
		if (!got) throw new Error(`${context}: ${id} missing`)
		if (!coordsEqual(got.coord, want.coord)) throw new Error(`${context}: ${id} coord differs`)
		for (const field of [
			'relevance',
			'state',
			'membership',
			'accessCount',
			'successCount',
			'failureCount',
			'avgLatencyMs',
			'negotiateFailures',
		] as const) {
			if (got[field] !== want[field])
				throw new Error(`${context}: ${id}.${field} is ${String(got[field])}, expected ${String(want[field])}`)
		}
	}
}

function checkInvariants(store: DigitreeStore, context: string): void {
	const listed = store.list()

	// Tree population === id-index population. A mismatch means an orphaned tree entry
	// (invisible to getById/remove, still walked by the ring) or a dangling id mapping.
	if (listed.length !== store.size())
		throw new Error(`${context}: list().length ${listed.length} !== size() ${store.size()}`)

	// One tree entry per id.
	const seen = new Set<string>()
	for (const e of listed) {
		if (seen.has(e.id)) throw new Error(`${context}: duplicate tree entry for ${e.id}`)
		seen.add(e.id)
	}

	// The id index points at the *current* entry, not a stale one.
	for (const e of listed) {
		const byId = store.getById(e.id)
		if (!byId) throw new Error(`${context}: listed entry ${e.id} unreachable via getById`)
		if (!coordsEqual(byId.coord, e.coord))
			throw new Error(`${context}: getById(${e.id}) coord differs from the listed entry's`)
	}

	// The ring walks see exactly the same population. Both walks count per pushed id and
	// de-duplicate only at the end, so a duplicated id consumes two slots and the walk
	// returns fewer distinct peers than asked for — this is the assertion that catches it.
	const n = store.size()
	for (const probe of [coords[0]!, coords[COORD_POOL - 1]!]) {
		const right = store.neighborsRight(probe, n)
		const left = store.neighborsLeft(probe, n)
		if (right.length !== n) throw new Error(`${context}: neighborsRight returned ${right.length} distinct of ${n}`)
		if (left.length !== n) throw new Error(`${context}: neighborsLeft returned ${left.length} distinct of ${n}`)
	}

	// The O(1) tallies must agree with a manual recount over the same `listed` population —
	// pinning both directions: a tally that over-reports (never decremented) and one that
	// under-reports (decremented on a no-op write) are equally wrong.
	for (const s of STATES) {
		const want = listed.filter((e) => e.state === s).length
		const got = store.countByState(s)
		if (got !== want) throw new Error(`${context}: countByState(${s}) is ${got}, expected ${want}`)
	}
	for (const m of MEMBERSHIPS) {
		const want = listed.filter((e) => e.membership === m).length
		const got = store.countByMembership(m)
		if (got !== want) throw new Error(`${context}: countByMembership(${m}) is ${got}, expected ${want}`)
	}
}

describe('DigitreeStore index/tree invariant', () => {
	it('holds after any sequence of writes', () => {
		fc.assert(
			fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (ops) => {
				const store = new DigitreeStore()
				const model: Model = new Map()
				for (let i = 0; i < ops.length; i++) {
					const context = `after op ${i} (${ops[i]!.kind})`
					applyOp(store, model, ops[i]!)
					checkInvariants(store, context)
					checkAgainstModel(store, model, context)
				}
				return true
			})
		)
	})

	describe('importEntries', () => {
		it('relocates an existing id rather than orphaning its old entry', () => {
			const store = new DigitreeStore()
			store.upsert('p1', coords[1]!)

			const restored = store.importEntries([serialized('p1', coords[5]!)])

			if (restored !== 1) throw new Error(`expected 1 restored, got ${restored}`)
			if (store.size() !== 1) throw new Error(`expected size 1, got ${store.size()}`)
			const listed = store.list()
			if (listed.length !== 1) throw new Error(`expected 1 tree entry, got ${listed.length}`)
			if (!coordsEqual(listed[0]!.coord, coords[5]!)) throw new Error('tree entry not at the imported coord')
			const found = store.getById('p1')
			if (!found || !coordsEqual(found.coord, coords[5]!)) throw new Error('getById does not resolve to the imported coord')

			// The orphan's tell: it survived `remove` and kept showing up in ring walks.
			store.remove('p1')
			if (store.size() !== 0) throw new Error(`expected empty after remove, got size ${store.size()}`)
			if (store.list().length !== 0) throw new Error(`expected empty tree after remove, got ${store.list().length}`)
		})

		it('replaces an existing entry with the snapshot data', () => {
			const store = new DigitreeStore()
			store.upsert('p1', coords[2]!)

			store.importEntries([
				serialized('p1', coords[2]!, {
					relevance: 99,
					membership: 'member',
					accessCount: 7,
					successCount: 5,
					failureCount: 2,
					avgLatencyMs: 42,
				}),
			])

			const e = store.getById('p1')
			if (!e) throw new Error('p1 missing after import')
			if (e.relevance !== 99) throw new Error(`relevance ${e.relevance} !== 99`)
			if (e.membership !== 'member') throw new Error(`membership ${e.membership} !== member`)
			if (e.accessCount !== 7) throw new Error(`accessCount ${e.accessCount} !== 7`)
			if (e.successCount !== 5) throw new Error(`successCount ${e.successCount} !== 5`)
			if (e.failureCount !== 2) throw new Error(`failureCount ${e.failureCount} !== 2`)
			if (e.avgLatencyMs !== 42) throw new Error(`avgLatencyMs ${e.avgLatencyMs} !== 42`)
		})

		it('reports distinct ids stored, not input records', () => {
			const store = new DigitreeStore()

			const restored = store.importEntries([
				serialized('p1', coords[1]!),
				serialized('p1', coords[3]!),
			])

			if (restored !== 1) throw new Error(`expected 1 distinct id, got ${restored}`)
			if (store.size() !== 1) throw new Error(`expected size 1, got ${store.size()}`)
			if (store.list().length !== 1) throw new Error(`expected 1 tree entry, got ${store.list().length}`)
		})
	})

	describe('counts', () => {
		it('is zero for every label on an empty store', () => {
			const store = new DigitreeStore()
			for (const s of STATES) if (store.countByState(s) !== 0) throw new Error(`countByState(${s}) !== 0 on empty store`)
			for (const m of MEMBERSHIPS)
				if (store.countByMembership(m) !== 0) throw new Error(`countByMembership(${m}) !== 0 on empty store`)
		})

		it('setMembership shifts both membership counters by one, leaving state counts unchanged', () => {
			const store = new DigitreeStore()
			store.upsert('p1', coords[1]!) // membership: 'unknown', state: 'disconnected'
			const deadBefore = store.countByState('disconnected')

			store.setMembership('p1', 'member')

			if (store.countByMembership('unknown') !== 0) throw new Error('unknown count did not decrement')
			if (store.countByMembership('member') !== 1) throw new Error('member count did not increment')
			if (store.countByState('disconnected') !== deadBefore) throw new Error('state counts moved on a membership-only change')
		})

		it('setState(dead) shifts state counters only, membership counts unchanged', () => {
			const store = new DigitreeStore()
			store.upsert('p1', coords[1]!)
			store.setMembership('p1', 'foreign')
			const foreignBefore = store.countByMembership('foreign')

			store.setState('p1', 'dead')

			if (store.countByState('disconnected') !== 0) throw new Error('disconnected count did not decrement')
			if (store.countByState('dead') !== 1) throw new Error('dead count did not increment')
			if (store.countByMembership('foreign') !== foreignBefore) throw new Error('membership counts moved on a state-only change')
		})

		it('remove of a dead foreign peer decrements both its state and membership counts', () => {
			const store = new DigitreeStore()
			store.upsert('p1', coords[1]!)
			store.setMembership('p1', 'foreign')
			store.setState('p1', 'dead')

			store.remove('p1')

			if (store.countByState('dead') !== 0) throw new Error(`countByState('dead') !== 0 after remove`)
			if (store.countByMembership('foreign') !== 0) throw new Error(`countByMembership('foreign') !== 0 after remove`)
		})

		it('importEntries replacing an existing id recounts rather than summing old and new labels', () => {
			const store = new DigitreeStore()
			store.upsert('p1', coords[1]!) // 'unknown' / 'disconnected'
			store.setState('p1', 'dead')

			// importEntries always forces state to 'disconnected' regardless of the serialized
			// state field (connection liveness cannot survive a restart — see docs/fret.md), so
			// 'dead' -> 'disconnected' is what exercises the state recount here.
			store.importEntries([serialized('p1', coords[2]!, { membership: 'member', state: 'connected' })])

			if (store.countByMembership('unknown') !== 0) throw new Error('old membership count not decremented on replace')
			if (store.countByState('dead') !== 0) throw new Error('old state count not decremented on replace')
			if (store.countByMembership('member') !== 1) throw new Error('new membership count not incremented on replace')
			if (store.countByState('disconnected') !== 1) throw new Error('new state count not incremented on replace')
		})

		it('never goes negative when removing an id twice, or an id never inserted', () => {
			const store = new DigitreeStore()
			store.upsert('p1', coords[1]!)
			store.setMembership('p1', 'member')

			store.remove('p1')
			store.remove('p1') // second remove: no-op
			store.remove('does-not-exist') // never inserted: no-op

			if (store.countByMembership('member') !== 0) throw new Error('member count went negative or stayed after double remove')
			for (const s of STATES) if (store.countByState(s) !== 0) throw new Error(`countByState(${s}) !== 0 after double remove`)
			for (const m of MEMBERSHIPS)
				if (store.countByMembership(m) !== 0) throw new Error(`countByMembership(${m}) !== 0 after double remove`)
		})
	})

	describe('update', () => {
		it('re-keys the entry on a coordinate change without throwing', () => {
			const store = new DigitreeStore()
			store.upsert('p1', coords[1]!)
			const before = store.neighborsRight(coords[0]!, 1)

			store.update('p1', { coord: coords[6]! })

			const e = store.getById('p1')
			if (!e) throw new Error('p1 unreachable via getById after re-key')
			if (!coordsEqual(e.coord, coords[6]!)) throw new Error('entry did not take the new coord')
			if (store.size() !== 1) throw new Error(`expected size 1, got ${store.size()}`)
			const listed = store.list()
			if (listed.length !== 1) throw new Error(`expected 1 tree entry, got ${listed.length}`)
			if (!coordsEqual(listed[0]!.coord, coords[6]!)) throw new Error('tree entry did not move')

			// Ring position actually moved: the old coord no longer has a peer sitting on it.
			if (before.length !== 1) throw new Error('precondition: expected one neighbor before the re-key')
			const succOfOld = store.successorOfCoord(coords[2]!)
			if (!succOfOld || !coordsEqual(succOfOld.coord, coords[6]!))
				throw new Error('successor walk did not observe the moved entry')
		})

		it('preserves untouched fields across a re-key', () => {
			const store = new DigitreeStore()
			store.upsert('p1', coords[1]!)
			store.update('p1', { relevance: 12, membership: 'member', successCount: 3 })

			store.update('p1', { coord: coords[7]! })

			const e = store.getById('p1')
			if (!e) throw new Error('p1 missing after re-key')
			if (e.relevance !== 12) throw new Error(`relevance ${e.relevance} !== 12`)
			if (e.membership !== 'member') throw new Error(`membership ${e.membership} !== member`)
			if (e.successCount !== 3) throw new Error(`successCount ${e.successCount} !== 3`)
		})
	})
})

// `walkFrom` is what lets a caller sweep the whole ring in bounded pages without restarting —
// the property `FretPeerDiscovery` rests on. The cases below pin the three parts that make a
// resumed sweep cover the ring exactly once per lap: strictly-after resumption, the wrap, and
// filter misses advancing the walk instead of ending it.
describe('DigitreeStore.walkFrom', () => {
	/** `coords[i]` ascends with `i` (its leading byte is `i * 29`), so ring order is p0..p(n-1). */
	function ringStore(n: number): DigitreeStore {
		const store = new DigitreeStore()
		for (let i = 0; i < n; i++) store.upsert(ids[i]!, coords[i]!)
		return store
	}

	const idsOf = (entries: Array<{ id: string }>) => entries.map((e) => e.id)

	it('visits every entry exactly once per lap, in ring order', () => {
		const store = ringStore(COORD_POOL)
		const order = idsOf(store.list())

		const visited: string[] = []
		let cursor: RingCursor | null = null
		for (let i = 0; i < COORD_POOL; i++) {
			const page = store.walkFrom(cursor, 1)
			expect(idsOf(page.entries), `page ${i} should yield exactly one entry`).to.have.length(1)
			visited.push(page.entries[0]!.id)
			cursor = page.next
		}

		expect(visited).to.deep.equal(order)
	})

	it('wraps past the end of the ring', () => {
		const store = ringStore(COORD_POOL)
		const order = idsOf(store.list())

		const lap = store.walkFrom(null, COORD_POOL)
		expect(idsOf(lap.entries)).to.deep.equal(order)

		const wrapped = store.walkFrom(lap.next, 2)
		expect(idsOf(wrapped.entries)).to.deep.equal([order[0]!, order[1]!])
	})

	// One page never yields an id twice, even asked for more than the ring holds — the bounded
	// scan stops at one full lap rather than looping round onto entries it already returned.
	it('caps a single page at one full lap', () => {
		const store = ringStore(3)
		const page = store.walkFrom(null, 10)
		expect(idsOf(page.entries)).to.deep.equal(idsOf(store.list()))
	})

	it('re-yields the only entry of a single-peer ring', () => {
		const store = ringStore(1)
		const first = store.walkFrom(null, 1)
		expect(idsOf(first.entries)).to.deep.equal([ids[0]!])

		// "Strictly after X, wrapping" on a one-entry ring is X itself, which is what keeps a
		// lone peer re-announced once its debounce lapses instead of never again.
		const again = store.walkFrom(first.next, 1)
		expect(idsOf(again.entries)).to.deep.equal([ids[0]!])
	})

	it('skips filter misses rather than spending page slots on them', () => {
		const store = ringStore(COORD_POOL)
		const wanted = new Set([ids[5]!, ids[6]!])

		const page = store.walkFrom(null, 2, (e) => wanted.has(e.id))

		expect(idsOf(page.entries)).to.deep.equal([ids[5]!, ids[6]!])
	})

	it('terminates and holds position when the filter matches nothing', () => {
		const store = ringStore(COORD_POOL)
		const first = store.walkFrom(null, 1)

		const empty = store.walkFrom(first.next, 5, () => false)

		expect(empty.entries).to.have.length(0)
		expect(empty.next, 'an empty page must not move the cursor').to.equal(first.next)
	})

	it('terminates on an empty ring', () => {
		const store = new DigitreeStore()
		const page = store.walkFrom(null, 5)
		expect(page.entries).to.have.length(0)
		expect(page.next).to.equal(null)
	})

	// A cursor is a position, not a handle: the entry it names can be evicted between pages, and
	// the sweep must resume at the next ring position rather than restarting from the ring start.
	it('resumes after a cursor whose entry has since been removed', () => {
		const store = ringStore(COORD_POOL)
		const order = idsOf(store.list())

		const first = store.walkFrom(null, 1)
		expect(idsOf(first.entries)).to.deep.equal([order[0]!])
		store.remove(order[0]!)

		const next = store.walkFrom(first.next, 1)
		expect(idsOf(next.entries)).to.deep.equal([order[1]!])
	})

	it('yields nothing for a non-positive count, leaving the cursor untouched', () => {
		const store = ringStore(COORD_POOL)
		const first = store.walkFrom(null, 1)

		const page = store.walkFrom(first.next, 0)

		expect(page.entries).to.have.length(0)
		expect(page.next).to.equal(first.next)
	})
})
