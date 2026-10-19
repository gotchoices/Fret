import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
	deadGraceMs,
	DEAD_GRACE_MIN_TENURE_MS,
	DEAD_GRACE_TENURE_RATIO,
	noteProven,
	provenTenureMs,
	stabilityFactor,
	STABILITY_MAX_BONUS,
	TENURE_GAP_TOLERANCE_MS,
	TENURE_STAMP_GRANULARITY_MS,
	type TenureFields,
} from '../src/store/tenure.js'

// Session tenure is a pure, clock-free policy (callers pass `now`), so each rule is one row with
// no sleeps. The service seam that stamps it (`FretService.noteProofOfLife`) is driven end to end
// by the dead-grace integration test.

describe('session tenure', () => {
	const T0 = 1_700_000_000_000
	const LAST = T0 + 60 * 60_000
	const running: TenureFields = { sessionStartedAt: T0, lastProvenAliveAt: LAST }

	it('noteProven continues a session within the gap tolerance and starts a new one otherwise', () => {
		const rows: Array<{ name: string; cur: TenureFields; now: number; want: TenureFields | undefined }> = [
			{ name: 'never proven → new session', cur: { sessionStartedAt: 0, lastProvenAliveAt: 0 }, now: T0, want: { sessionStartedAt: T0, lastProvenAliveAt: T0 } },
			{ name: 'gap within tolerance → continue', cur: running, now: LAST + 5 * 60_000, want: { sessionStartedAt: T0, lastProvenAliveAt: LAST + 5 * 60_000 } },
			{ name: 'gap exactly at tolerance → continue', cur: running, now: LAST + TENURE_GAP_TOLERANCE_MS, want: { sessionStartedAt: T0, lastProvenAliveAt: LAST + TENURE_GAP_TOLERANCE_MS } },
			{ name: 'gap over tolerance → new session', cur: running, now: LAST + TENURE_GAP_TOLERANCE_MS + 1, want: { sessionStartedAt: LAST + TENURE_GAP_TOLERANCE_MS + 1, lastProvenAliveAt: LAST + TENURE_GAP_TOLERANCE_MS + 1 } },
			{ name: 'advance under granularity → nothing to write', cur: running, now: LAST + TENURE_STAMP_GRANULARITY_MS - 1, want: undefined },
			{ name: 'clock backwards → new session, never negative', cur: running, now: LAST - 1, want: { sessionStartedAt: LAST - 1, lastProvenAliveAt: LAST - 1 } },
		]
		for (const r of rows) expect(noteProven(r.cur, r.now), r.name).to.deep.equal(r.want)
	})

	it('provenTenureMs stays finite when the stamps subtract past the float range', () => {
		// Both values are legal JSON, so a persisted table can carry them; the difference is Infinity.
		expect(provenTenureMs({ sessionStartedAt: -Number.MAX_VALUE, lastProvenAliveAt: Number.MAX_VALUE })).to.equal(0)
	})

	it('stabilityFactor is 1 at zero tenure, strictly increasing, and bounded below 1 + max bonus', () => {
		expect(stabilityFactor(0)).to.equal(1)
		const day = 24 * 60 * 60_000
		const tenures = [0, 1_000, 5 * 60_000, 60 * 60_000, day, 30 * day, 10_000 * day]
		const factors = tenures.map(stabilityFactor)
		for (let i = 1; i < factors.length; i++) {
			expect(factors[i], `factor at ${tenures[i]} ms`).to.be.greaterThan(factors[i - 1]!)
			expect(factors[i], `factor at ${tenures[i]} ms`).to.be.lessThan(1 + STABILITY_MAX_BONUS)
		}
	})

	it('deadGraceMs is 0 below the tenure floor, the tenure ratio above it, and never past the cap', () => {
		const CAP = 5 * 60_000
		const hour = 60 * 60_000
		const rows: Array<{ name: string; tenure: number; cap: number; want: number }> = [
			{ name: 'below the floor (a phone up 5 min) → no grace', tenure: 5 * 60_000, cap: CAP, want: 0 },
			{ name: 'just below the floor → no grace', tenure: DEAD_GRACE_MIN_TENURE_MS - 1, cap: CAP, want: 0 },
			{ name: 'at the floor → ratio', tenure: DEAD_GRACE_MIN_TENURE_MS, cap: CAP, want: DEAD_GRACE_MIN_TENURE_MS * DEAD_GRACE_TENURE_RATIO },
			{ name: 'above the floor (30 min) → ratio', tenure: 30 * 60_000, cap: CAP, want: 150_000 },
			{ name: 'way above (a week) → cap', tenure: 7 * 24 * hour, cap: CAP, want: CAP },
			{ name: 'cap 0 disables grace', tenure: 7 * 24 * hour, cap: 0, want: 0 },
			{ name: 'NaN tenure → no grace, never a NaN that disables the verdict', tenure: NaN, cap: CAP, want: 0 },
		]
		for (const r of rows) expect(deadGraceMs(r.tenure, r.cap), r.name).to.equal(r.want)
	})
})
