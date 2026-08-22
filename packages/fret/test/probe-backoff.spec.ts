import { describe, it } from 'mocha'
import { expect } from 'chai'
import { ProbeBackoff } from '../src/service/probe-backoff.js'

/**
 * Pure unit tests: no libp2p node, no sleeps. One fake clock drives both the backoff window and
 * the retention TTL, which is the whole point of the extraction — the arithmetic is testable
 * without swapping the backing map in or hand-writing an expired `until`.
 */

/** A caller-stepped clock. `at` is unix-ms-shaped but arbitrary; nothing here reads the wall clock. */
function fakeClock(start = 1_000_000) {
	let at = start
	return {
		now: () => at,
		advance(ms: number) { at += ms },
	}
}

const BASE_MS = 1000
const MAX_FACTOR = 32
const RETAIN_MS = 300_000

function makeBackoff(overrides: { capacity?: number; baseMs?: number; maxFactor?: number; retainMs?: number } = {}) {
	const clock = fakeClock()
	const backoff = new ProbeBackoff({
		capacity: overrides.capacity ?? 64,
		baseMs: overrides.baseMs ?? BASE_MS,
		maxFactor: overrides.maxFactor ?? MAX_FACTOR,
		retainMs: overrides.retainMs ?? RETAIN_MS,
		now: clock.now,
	})
	return { backoff, clock }
}

/** Fail once, then step past the window that failure opened, leaving the entry retained. */
function failAndCloseWindow(backoff: ProbeBackoff, clock: { advance(ms: number): void }, id: string) {
	backoff.record(id)
	clock.advance(BASE_MS * backoff.factor(id) + 1)
}

describe('ProbeBackoff', () => {
	describe('escalation', () => {
		it('first record yields factor 1 and a window of baseMs', () => {
			const { backoff, clock } = makeBackoff()
			backoff.record('a')

			expect(backoff.factor('a')).to.equal(1)
			expect(backoff.isBackedOff('a')).to.equal(true)

			// Still inside the window one tick before it closes...
			clock.advance(BASE_MS - 1)
			expect(backoff.isBackedOff('a')).to.equal(true)
			// ...and out of it one tick after.
			clock.advance(2)
			expect(backoff.isBackedOff('a')).to.equal(false)
		})

		it('doubles on each further failure: 1, 2, 4, 8, 16, 32', () => {
			const { backoff, clock } = makeBackoff()
			const seen: number[] = []

			for (let i = 0; i < 6; i++) {
				backoff.record('a')
				seen.push(backoff.factor('a'))
				// Close the window this failure opened, well inside the retention lifetime, so the
				// next record escalates rather than restarting.
				clock.advance(BASE_MS * backoff.factor('a') + 1)
			}

			expect(seen).to.deep.equal([1, 2, 4, 8, 16, 32])
		})

		it('two failures inside one still-open window both escalate', () => {
			const { backoff, clock } = makeBackoff()
			backoff.record('a')
			expect(backoff.factor('a')).to.equal(1)

			// No clock.advance — second failure lands inside the first window.
			backoff.record('a')
			expect(backoff.factor('a')).to.equal(2)

			// The second call's later stamp pushed `until` out too: still backed off well past
			// where the *first* call's window alone would have closed.
			clock.advance(BASE_MS - 1)
			expect(backoff.isBackedOff('a')).to.equal(true)
		})

		it('caps at maxFactor and stays there across further records', () => {
			const { backoff, clock } = makeBackoff()

			// Climb to the cap, then keep failing.
			for (let i = 0; i < 12; i++) {
				backoff.record('a')
				clock.advance(BASE_MS * backoff.factor('a') + 1)
			}

			expect(backoff.factor('a')).to.equal(MAX_FACTOR)
			backoff.record('a')
			expect(backoff.factor('a')).to.equal(MAX_FACTOR)
			// The window is baseMs * maxFactor, not something longer.
			expect(backoff.isBackedOff('a')).to.equal(true)
			clock.advance(BASE_MS * MAX_FACTOR + 1)
			expect(backoff.isBackedOff('a')).to.equal(false)
		})
	})

	describe('closed window vs forgotten entry', () => {
		// These are different states that both make `isBackedOff` false and `penalty` 0; only
		// `factor` tells them apart. Confusing them is the original bug retention exists to
		// prevent — a gate that *deleted* on expiry, so escalation always restarted at 1.
		it('retains the escalation once the window closes', () => {
			const { backoff, clock } = makeBackoff()
			failAndCloseWindow(backoff, clock, 'a')

			expect(backoff.isBackedOff('a')).to.equal(false)
			expect(backoff.penalty('a')).to.equal(0)
			expect(backoff.factor('a')).to.equal(1)

			// The retained factor is what the next failure escalates from.
			backoff.record('a')
			expect(backoff.factor('a')).to.equal(2)
		})

		it('forgets the escalation once retainMs elapses with no further record', () => {
			const { backoff, clock } = makeBackoff()
			failAndCloseWindow(backoff, clock, 'a')
			expect(backoff.factor('a')).to.equal(1)

			clock.advance(RETAIN_MS)

			expect(backoff.factor('a')).to.equal(0)
			expect(backoff.isBackedOff('a')).to.equal(false)
			expect(backoff.penalty('a')).to.equal(0)

			// And the next failure starts over rather than escalating.
			backoff.record('a')
			expect(backoff.factor('a')).to.equal(1)
		})

		it('measures retention from the last failure, not the first', () => {
			const { backoff, clock } = makeBackoff()
			backoff.record('a')

			// Just short of the retention lifetime, fail again: the record must re-`set` the key
			// and so restart the TTL. A read-modify-write that skipped `set` would let the entry
			// expire here despite the fresh failure.
			clock.advance(RETAIN_MS - 1)
			backoff.record('a')
			expect(backoff.factor('a')).to.equal(2)

			// Another near-full retention window later, the escalation is still remembered —
			// total elapsed is ~2× retainMs, so a first-failure-anchored TTL would have dropped it.
			clock.advance(RETAIN_MS - 1)
			expect(backoff.factor('a')).to.equal(2)
		})
	})

	describe('the two readers of one entry', () => {
		it('penalty and isBackedOff agree across a whole escalation schedule', () => {
			const { backoff, clock } = makeBackoff()

			// Sample the pair at every interesting instant: fresh failure, mid-window, just past
			// the window, and past retention.
			const check = (id: string, note: string) => {
				expect(backoff.penalty(id) > 0, note).to.equal(backoff.isBackedOff(id))
			}

			check('a', 'absent')
			for (let i = 0; i < 6; i++) {
				backoff.record('a')
				check('a', `fresh failure ${i}`)
				clock.advance(Math.floor((BASE_MS * backoff.factor('a')) / 2))
				check('a', `mid-window ${i}`)
				clock.advance(BASE_MS * backoff.factor('a'))
				check('a', `window closed ${i}`)
			}
			clock.advance(RETAIN_MS)
			check('a', 'retention expired')
		})

		it('penalty equals min(1, factor / maxFactor) while the window is open', () => {
			const { backoff, clock } = makeBackoff()

			for (const expected of [1, 2, 4, 8, 16, 32]) {
				backoff.record('a')
				expect(backoff.factor('a')).to.equal(expected)
				expect(backoff.penalty('a')).to.equal(Math.min(1, expected / MAX_FACTOR))
				clock.advance(BASE_MS * expected + 1)
			}

			// At the cap the term saturates at exactly 1.
			expect(backoff.penalty('a')).to.equal(0) // window closed
			backoff.record('a')
			expect(backoff.penalty('a')).to.equal(1)
		})
	})

	describe('forgetting', () => {
		it('clear forgets one peer and leaves the others', () => {
			const { backoff } = makeBackoff()
			backoff.record('a')
			backoff.record('b')

			backoff.clear('a')

			expect(backoff.factor('a')).to.equal(0)
			expect(backoff.isBackedOff('a')).to.equal(false)
			expect(backoff.factor('b')).to.equal(1)
			expect(backoff.isBackedOff('b')).to.equal(true)

			// The follow-up: clear() left 'a' forgotten, not merely retained at 0 — the next
			// failure must restart at factor 1, same shape as the retention-expiry case above.
			backoff.record('a')
			expect(backoff.factor('a')).to.equal(1)
		})

		it('clearAll forgets every peer', () => {
			const { backoff } = makeBackoff()
			backoff.record('a')
			backoff.record('b')
			backoff.record('c')

			backoff.clearAll()

			expect(backoff.size).to.equal(0)
			for (const id of ['a', 'b', 'c']) {
				expect(backoff.factor(id)).to.equal(0)
				expect(backoff.isBackedOff(id)).to.equal(false)
			}
		})

		it('prune drops entries the predicate rejects and keeps the ones it accepts', () => {
			const { backoff } = makeBackoff()
			for (const id of ['keep-1', 'drop-1', 'keep-2', 'drop-2']) backoff.record(id)

			backoff.prune(id => id.startsWith('keep'))

			expect(backoff.factor('keep-1')).to.equal(1)
			expect(backoff.factor('keep-2')).to.equal(1)
			expect(backoff.factor('drop-1')).to.equal(0)
			expect(backoff.factor('drop-2')).to.equal(0)
			expect(backoff.size).to.equal(2)
		})

		it('prune and sweep are orthogonal — neither does the other job', () => {
			// A peer that left the store but is well inside its retention window: only `prune`
			// can see that, since no TTL knows a peer was evicted.
			const { backoff, clock } = makeBackoff()
			backoff.record('gone')
			backoff.sweep()
			expect(backoff.factor('gone'), 'sweep must not drop a live entry').to.equal(1)
			backoff.prune(() => false)
			expect(backoff.size).to.equal(0)

			// Conversely a retention-expired entry for a peer still in the store is sweep's job.
			// `RETAIN_MS + 1`, not `RETAIN_MS`: an entry is still live *at* its expiry instant, and
			// at exactly `RETAIN_MS` the entry below is live — which would make the `prune` claim
			// vacuous (prune walks the *live* key snapshot, so it never sees an expired entry).
			backoff.record('stale')
			clock.advance(RETAIN_MS + 1)
			backoff.prune(() => true)
			expect(backoff.size, 'prune must not drop an expired entry the predicate accepts').to.equal(1)
			backoff.sweep()
			expect(backoff.size).to.equal(0)
		})
	})

	describe('capacity', () => {
		it('binds: size never exceeds capacity', () => {
			const capacity = 8
			const { backoff } = makeBackoff({ capacity })
			expect(backoff.capacity).to.equal(capacity)

			for (let i = 0; i < capacity + 1; i++) {
				backoff.record(`peer-${i}`)
				expect(backoff.size).to.be.at.most(capacity)
			}

			// Deliberately no assertion on *which* id was evicted: `ExpiringMap` evicts the
			// nearest-to-expiry entry, and a wrong eviction costs one peer its escalation
			// (its next failure restarts at factor 1) — cheap, and stated as acceptable at the
			// `FretService` construction site.
			expect(backoff.size).to.equal(capacity)
		})
	})

	describe('shipped defaults', () => {
		it('retention comfortably exceeds the longest backoff window', () => {
			// Read off the statics rather than copies, with a type guard on each so a typo'd name
			// cannot make the comparison vacuous (`undefined > undefined` is false, but so is
			// every other comparison — the guard is what turns a rename into a failure).
			expect(ProbeBackoff.DEFAULT_BASE_MS).to.be.a('number')
			expect(ProbeBackoff.DEFAULT_MAX_FACTOR).to.be.a('number')
			expect(ProbeBackoff.DEFAULT_RETAIN_MS).to.be.a('number')

			expect(ProbeBackoff.DEFAULT_RETAIN_MS).to.be.greaterThan(
				ProbeBackoff.DEFAULT_BASE_MS * ProbeBackoff.DEFAULT_MAX_FACTOR
			)
		})

		it('applies the defaults when the options omit them', () => {
			const backoff = new ProbeBackoff({ capacity: 16 })
			expect(backoff.baseMs).to.equal(ProbeBackoff.DEFAULT_BASE_MS)
			expect(backoff.maxFactor).to.equal(ProbeBackoff.DEFAULT_MAX_FACTOR)
			expect(backoff.retainMs).to.equal(ProbeBackoff.DEFAULT_RETAIN_MS)
		})
	})
})
