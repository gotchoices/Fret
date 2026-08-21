import { describe, it } from 'mocha'
import { expect } from 'chai'
import fc from 'fast-check'
import { DigitreeStore, type PeerEntry } from '../src/store/digitree-store.js'
import { coordToBase64url } from '../src/ring/hash.js'

function randomCoord(len = 32): Uint8Array {
	const u = new Uint8Array(len)
	for (let i = 0; i < len; i++) u[i] = Math.floor(Math.random() * 256)
	return u
}

/** `coordAt(i)` ascends with `i`, so a ring built from 0..n-1 is in ring order p0..p(n-1). */
function coordAt(i: number): Uint8Array {
	const c = new Uint8Array(32)
	c[0] = i * 7
	c[31] = i
	return c
}

function ringStore(n: number): DigitreeStore {
	const store = new DigitreeStore()
	for (let i = 0; i < n; i++) store.upsert(`p${i}`, coordAt(i))
	return store
}

const ZERO = new Uint8Array(32)

// Both walks start *on* the entry sitting at the probe coordinate — ZERO is exactly p0's
// coordinate — so the left walk is p0 then backwards with a wrap, not a plain reverse.
const leftOrder = (order: string[]) => [order[0]!, ...order.slice(1).reverse()]

describe('DigitreeStore neighbors invariants', () => {
	it('successor/predecessor wrap-around and uniqueness', () => {
		fc.assert(
			fc.property(fc.array(fc.string({ minLength: 1, maxLength: 32 }), { minLength: 1, maxLength: 200 }), (ids) => {
				const uniq = Array.from(new Set(ids.filter((s) => /^[0-9a-zA-Z]+$/.test(s))))
				const store = new DigitreeStore()
				for (const id of uniq) store.upsert(id, randomCoord())
				const list = store.list()
				if (list.length === 0) return true
				const center = list[Math.floor(list.length / 2)]!.coord
				const right = store.neighborsRight(center, Math.min(list.length, 8))
				const left = store.neighborsLeft(center, Math.min(list.length, 8))
				const all = [...right, ...left]
				// bounded unique coverage
				const uniqueLen = new Set(all).size
				return uniqueLen <= Math.min(list.length, 16)
			})
		)
	})
})

// Unfiltered, `maxScan` is `Infinity`, so before the early exit landed a walk on a ring
// smaller than `count` kept circling — re-collecting ids it had already seen until it had
// pushed `count` of them — and the trailing dedup hid it. Cost was O(count), not O(ring size).
// The exit fires on the first repeat, which proves a lap because the store holds exactly one
// tree entry per peer id.
describe('DigitreeStore ring walks exit on a lap', () => {
	it('returns every id exactly once when count exceeds the ring size', () => {
		const store = ringStore(4)
		const order = store.list().map((e) => e.id)

		expect(store.neighborsRight(ZERO, 4000)).to.deep.equal(order)
		expect(store.neighborsLeft(ZERO, 4000)).to.deep.equal(leftOrder(order))
	})

	// The headline cost case. Old behavior did `count` loop iterations regardless of ring
	// size, so a million-wide ask on a four-entry ring ran a million tree steps; the exit makes
	// it ~5. It is counted rather than timed: a wall-clock assertion cannot discriminate here,
	// because the old loop is cheap per iteration — measured, the pre-exit walk completed a
	// million-wide ask on a four-entry ring in 46 ms, so any threshold loose enough to be safe
	// on shared CI passes at the pre-exit HEAD and guards nothing.
	//
	// Counting steps needs no production hook: the walk advances the ordered index one `next`
	// per iteration, so wrapping that method on the store's own index counts loop iterations
	// exactly. Reaching past `private` is deliberate — this is a white-box test of the store's
	// cost, and the alternative was widening the public surface for observability alone.
	it('does work proportional to the ring, not to count', () => {
		const store = ringStore(4)
		const index = (store as unknown as { byKey: { next: (p: unknown) => unknown } }).byKey
		const next = index.next.bind(index)
		let steps = 0
		index.next = (p: unknown) => {
			steps++
			return next(p)
		}

		try {
			const ids = store.neighborsRight(ZERO, 1_000_000)
			expect(ids).to.have.length(4)
		} finally {
			index.next = next
		}

		// One step per entry plus the one that walks off the last entry and wraps.
		expect(steps, 'a lapping walk must not scale with count').to.be.at.most(8)
	})

	// Filed here for adjacency, but it guards `maxScan`, not the lap exit: with a filter
	// `maxScan` is `size()` and `scanned` counts every visit, so the walk is cut off at one lap
	// before any id can repeat and the exit never fires. It passes unchanged at the pre-exit
	// HEAD. Keep it — it is the regression test for the filtered walk's bound.
	it('visits each entry at most once when a pass-all filter is supplied (bounded by maxScan, not the lap exit)', () => {
		const store = ringStore(6)
		const visits = new Map<string, number>()
		const counting = (e: PeerEntry) => {
			visits.set(e.id, (visits.get(e.id) ?? 0) + 1)
			return true
		}

		const ids = store.neighborsRight(ZERO, 600, counting)

		expect(ids).to.have.length(6)
		for (const [id, n] of visits) expect(n, `${id} visited ${n} times`).to.be.at.most(1)
	})

	it('returns every id in ring order when count is exactly the ring size', () => {
		const store = ringStore(6)
		const order = store.list().map((e) => e.id)

		expect(store.neighborsRight(ZERO, 6)).to.deep.equal(order)
		expect(store.neighborsLeft(ZERO, 6)).to.deep.equal(leftOrder(order))
	})

	it('returns the single entry of a one-peer ring, once', () => {
		const store = ringStore(1)
		expect(store.neighborsRight(ZERO, 5)).to.deep.equal(['p0'])
		expect(store.neighborsLeft(ZERO, 5)).to.deep.equal(['p0'])
	})

	it('returns empty on an empty store without spinning', function () {
		this.timeout(5000)
		const store = new DigitreeStore()
		expect(store.neighborsRight(ZERO, 1_000_000)).to.deep.equal([])
		expect(store.neighborsLeft(ZERO, 1_000_000)).to.deep.equal([])
	})

	it('returns empty for a count of zero or negative', () => {
		const store = ringStore(4)
		expect(store.neighborsRight(ZERO, 0)).to.deep.equal([])
		expect(store.neighborsLeft(ZERO, 0)).to.deep.equal([])
		expect(store.neighborsRight(ZERO, -3)).to.deep.equal([])
		expect(store.neighborsLeft(ZERO, -3)).to.deep.equal([])
	})

	// The case the early exit *cannot* catch: nothing is ever added to the set, so no repeat is
	// ever seen and only the bounded-scan guard stops the wrap-around. This is the regression a
	// careless refactor of the loop deletes.
	it('terminates in one lap when a filter matches nothing', function () {
		this.timeout(5000)
		const store = ringStore(8)
		let calls = 0
		const never = () => {
			calls++
			return false
		}

		expect(store.neighborsRight(ZERO, 1_000_000, never)).to.deep.equal([])
		expect(calls, 'the bounded-scan guard caps a zero-match walk at one lap').to.equal(8)

		calls = 0
		expect(store.neighborsLeft(ZERO, 1_000_000, never)).to.deep.equal([])
		expect(calls).to.equal(8)
	})

	it('still skip-scans past sparse non-matches', () => {
		const store = ringStore(8)
		const wanted = new Set(['p2', 'p6'])

		expect(store.neighborsRight(ZERO, 2, (e) => wanted.has(e.id))).to.deep.equal(['p2', 'p6'])
	})
})

// The tree key is derived from an entry object and cached against that object's identity.
// Every write path replaces the entry rather than mutating it, so a re-key is a cache *miss*
// by construction. These pin that: a stale key would leave the entry sitting at its old ring
// position while `getById` still resolved it, which no structural check catches.
describe('DigitreeStore tree-key cache', () => {
	it('moves an entry in ring order after update({ coord }) and keeps the id index consistent', () => {
		const store = ringStore(4) // p0..p3 ascending
		expect(store.neighborsRight(ZERO, 4)).to.deep.equal(['p0', 'p1', 'p2', 'p3'])

		// Move p0 past p3 — a re-key, which must recompute the key rather than reuse the old one.
		store.update('p0', { coord: coordAt(9) })

		expect(store.neighborsRight(ZERO, 4), 'ring order must reflect the new coordinate').to.deep.equal([
			'p1',
			'p2',
			'p3',
			'p0',
		])
		const moved = store.getById('p0')
		expect(moved, 'p0 unreachable by id after re-key').to.not.equal(undefined)
		expect(Array.from(moved!.coord)).to.deep.equal(Array.from(coordAt(9)))
		expect(store.size()).to.equal(4)
		expect(store.list()).to.have.length(4)

		// The orphan tell: an entry left behind under its old key survives `remove`.
		store.remove('p0')
		expect(store.size()).to.equal(3)
		expect(store.list().map((e) => e.id)).to.deep.equal(['p1', 'p2', 'p3'])
	})

	it('recomputes on re-insert of the same id at an identical coordinate', () => {
		const store = ringStore(3)
		store.update('p1', { relevance: 5 })

		store.upsert('p1', coordAt(1)) // new object, same coordinate

		expect(store.size()).to.equal(3)
		expect(store.list()).to.have.length(3)
		expect(store.getById('p1')?.relevance, 'upsert preserves mutable stats').to.equal(5)
		expect(store.neighborsRight(ZERO, 3)).to.deep.equal(['p0', 'p1', 'p2'])
	})

	it('keys two entries sharing a coordinate distinctly, and reaches both', () => {
		const store = new DigitreeStore()
		const shared = coordAt(2)
		store.upsert('alpha', shared)
		store.upsert('beta', shared)

		expect(store.size()).to.equal(2)
		expect(store.list()).to.have.length(2)
		expect(store.getById('alpha')).to.not.equal(undefined)
		expect(store.getById('beta')).to.not.equal(undefined)
		expect(store.neighborsRight(ZERO, 2).slice().sort()).to.deep.equal(['alpha', 'beta'])

		store.remove('alpha')
		expect(store.list().map((e) => e.id)).to.deep.equal(['beta'])
	})

	// importEntries replaces by id over entries whose predecessors are already cached, and a
	// record may move its peer. Both halves have to land on the freshly built entry object.
	it('relocates an already-held id through importEntries', () => {
		const store = ringStore(3)
		const relocated = store
			.exportEntries()
			.map((e) => (e.id === 'p0' ? { ...e, coord: coordToBase64url(coordAt(9)) } : e))

		expect(store.importEntries(relocated)).to.equal(3)

		expect(store.size()).to.equal(3)
		expect(store.list()).to.have.length(3)
		expect(store.neighborsRight(ZERO, 3)).to.deep.equal(['p1', 'p2', 'p0'])
		expect(Array.from(store.getById('p0')!.coord)).to.deep.equal(Array.from(coordAt(9)))
	})
})



// `successorOfCoord` / `predecessorOfCoord` are the two single-entry walks. Their filtered
// branch is the one the shared-walker extraction rewrote most, and it had no direct coverage:
// the only callers today are the simulator (`test/simulation/fret-sim.ts`), which passes no
// filter. These pin the four behaviors the extraction has to preserve — wrap, empty ring,
// skip-and-keep-advancing, and terminate-on-zero-match.
describe('DigitreeStore single-entry ring walks', () => {
	const HIGH = new Uint8Array(32).fill(255)

	it('wraps past the end of the ring', () => {
		const store = ringStore(4)
		const order = store.list().map((e) => e.id)

		// HIGH sits past every entry, so the successor walk wraps to the ring start and the
		// predecessor walk starts on the ring end without wrapping.
		expect(store.successorOfCoord(HIGH)?.id).to.equal(order[0]!)
		expect(store.predecessorOfCoord(HIGH)?.id).to.equal(order[order.length - 1]!)

		// ZERO is exactly p0's coordinate, so both walks start *on* p0.
		expect(store.successorOfCoord(ZERO)?.id).to.equal('p0')
		expect(store.predecessorOfCoord(ZERO)?.id).to.equal('p0')
	})

	it('returns undefined on an empty store, filtered or not', () => {
		const store = new DigitreeStore()
		expect(store.successorOfCoord(ZERO)).to.equal(undefined)
		expect(store.predecessorOfCoord(ZERO)).to.equal(undefined)
		expect(store.successorOfCoord(ZERO, () => true)).to.equal(undefined)
		expect(store.predecessorOfCoord(ZERO, () => true)).to.equal(undefined)
	})

	it('skips filter misses rather than stopping on the first one', () => {
		const store = ringStore(6)
		const wanted = (e: PeerEntry) => e.id === 'p4'

		// p4 is four entries clockwise of ZERO and two counter-clockwise of it (via the wrap),
		// so both directions must skip past non-matches — and the left walk must wrap to do it.
		expect(store.successorOfCoord(ZERO, wanted)?.id).to.equal('p4')
		expect(store.predecessorOfCoord(ZERO, wanted)?.id).to.equal('p4')
	})

	// The bounded-scan guard: nothing ever matches, so only `maxScan` stops the wrap-around.
	// Deleting it here spins forever rather than failing an assertion, hence the timeout.
	it('terminates in one lap when a filter matches nothing', function () {
		this.timeout(5000)
		const store = ringStore(200)
		const never = () => false
		expect(store.successorOfCoord(ZERO, never)).to.equal(undefined)
		expect(store.predecessorOfCoord(ZERO, never)).to.equal(undefined)
	})

	// Each visited entry counts toward the scan bound, match or miss, so a lone match anywhere
	// on the ring is still found — the bound is one lap, not one lap of *matches*.
	it('finds a lone match at the far end of the lap', () => {
		const store = ringStore(200)
		const order = store.list().map((e) => e.id)
		const last = order[order.length - 1]!

		expect(store.successorOfCoord(ZERO, (e) => e.id === last)?.id).to.equal(last)
		expect(store.predecessorOfCoord(ZERO, (e) => e.id === order[1]!)?.id).to.equal(order[1]!)
	})
})
