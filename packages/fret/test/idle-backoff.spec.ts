import { describe, it } from 'mocha'
import { expect } from 'chai'
import { IdleBackoff } from '../src/service/idle-backoff.js'

// The passive stabilization interval doubles while nothing changes and snaps back to the base
// on any change (gotchoices/Fret#2, suggestion 1). The policy is a clock-free state machine, so
// each rule below is one `it` with no sleeps. The loop that arms real timers from it is covered
// by the two-node case in `near-exchange.spec.ts` and the departure case in
// `address-less-departure.spec.ts`.

describe('IdleBackoff', () => {
	const BASE = 1500
	const CAP = 60_000
	const make = (capMs = CAP): IdleBackoff => new IdleBackoff({ baseMs: BASE, capMs })
	/** One quiet pass: open, nothing noted, close. Returns the delay it settled on. */
	const quietPass = (b: IdleBackoff): number => { b.beginPass(); return b.endPass() }

	it('doubles from the base after each quiet pass, reaches the cap, and holds there', () => {
		const b = make()
		expect(b.delayMs, 'starts at the base').to.equal(BASE)
		const settled: number[] = []
		for (let i = 0; i < 8; i++) settled.push(quietPass(b))
		expect(settled).to.deep.equal([3000, 6000, 12_000, 24_000, 48_000, 60_000, 60_000, 60_000])
		expect(b.quietPasses, 'every pass counted as quiet').to.equal(8)
	})

	it('a change between passes drops the next delay to the base at once', () => {
		const b = make()
		while (quietPass(b) < CAP) { /* climb */ }
		b.noteChange()
		expect(b.delayMs, 'what a wake path armed right after the change reads').to.equal(BASE)
		expect(b.quietPasses).to.equal(0)
		// The pass that follows snapshots the counter *after* the change, so if it finds nothing
		// itself the ladder restarts from the base rather than from where it was.
		expect(quietPass(b)).to.equal(2 * BASE)
	})

	it('a change during a pass makes that pass end at the base', () => {
		const b = make()
		while (quietPass(b) < CAP) { /* climb */ }
		b.beginPass()
		b.noteChange()
		expect(b.endPass(), 'seen at the end of the pass it landed in').to.equal(BASE)
		expect(b.quietPasses).to.equal(0)
	})

	it('pending work holds the base without counting as a change', () => {
		const b = make()
		b.beginPass(); b.notePending()
		expect(b.endPass(), 'held').to.equal(BASE)
		expect(b.quietPasses, 'a pending pass is not quiet').to.equal(0)
		// The flag is per pass: the next pass, with nothing pending, climbs.
		expect(quietPass(b)).to.equal(2 * BASE)
	})

	it('a cap at or below the base returns the base forever (the off switch)', () => {
		for (const cap of [BASE, BASE / 2]) {
			const b = make(cap)
			expect(b.capMs, `effective cap for ${cap}`).to.equal(BASE)
			for (let i = 0; i < 5; i++) expect(quietPass(b), `pass ${i + 1} at cap ${cap}`).to.equal(BASE)
		}
	})

	it('reset returns to the base with nothing pending and a zero quiet count', () => {
		const b = make()
		quietPass(b); quietPass(b)
		b.beginPass(); b.notePending()
		b.reset()
		expect(b.delayMs).to.equal(BASE)
		expect(b.quietPasses).to.equal(0)
		expect(quietPass(b), 'the pending flag did not survive the reset').to.equal(2 * BASE)
	})
})
