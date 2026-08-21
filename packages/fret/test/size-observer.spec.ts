import { expect } from 'chai'
import { SizeObserver } from '../src/service/size-observer.js'
import type { LocalSizeEstimate } from '../src/service/size-observer.js'

/**
 * `SizeObserver` reads nothing but its own observation array and its injected clock, so every case
 * below runs without a service or a libp2p node — which is the point of the extraction. The clock
 * is a plain mutable number, so ageing is *set* rather than slept for.
 */

/** A clock the test drives directly. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void; at: () => number } {
	let t = start
	return { now: () => t, advance: (ms: number) => { t += ms }, at: () => t }
}

const WINDOW = 300_000
const local = (n: number, confidence: number): LocalSizeEstimate => ({ n, confidence })

describe('SizeObserver', () => {
	describe('report: trimming', () => {
		it('drops observations older than the window on append', () => {
			const c = clock()
			const obs = new SizeObserver({ now: c.now })

			obs.report(100, 0.5, 'old')
			c.advance(WINDOW + 1)
			obs.report(200, 0.5, 'new')

			expect(obs.observations().map(o => o.source)).to.deep.equal(['new'],
				'an observation older than the 5-minute window must be dropped when the next one lands')
		})

		it('applies the age cutoff strictly', () => {
			// The filter is `timestamp > cutoff`, so an observation sitting exactly `windowMs` back
			// is dropped and one a millisecond younger survives.
			const atEdge = clock()
			const dropped = new SizeObserver({ now: atEdge.now })
			dropped.report(100, 0.5, 'edge')
			atEdge.advance(WINDOW)
			dropped.report(200, 0.5, 'new')
			expect(dropped.observations().map(o => o.source)).to.deep.equal(['new'])

			const inside = clock()
			const kept = new SizeObserver({ now: inside.now })
			kept.report(100, 0.5, 'edge')
			inside.advance(WINDOW - 1)
			kept.report(200, 0.5, 'new')
			expect(kept.observations().map(o => o.source)).to.deep.equal(['edge', 'new'],
				'one millisecond inside the window must survive')
		})

		it('bounds by count, dropping the oldest first', () => {
			const c = clock()
			const obs = new SizeObserver({ maxObservations: 3, now: c.now })

			for (const n of [1, 2, 3, 4, 5]) {
				obs.report(n, 0.5, 's' + n)
				c.advance(1)
			}

			expect(obs.observations().map(o => o.estimate)).to.deep.equal([3, 4, 5],
				'the newest `maxObservations` survive; the oldest are the ones dropped')
		})

		it('applies the count bound to observations that are all inside the window', () => {
			// The two bounds interact: nothing here is stale, so only the count bound can bite.
			const c = clock()
			const obs = new SizeObserver({ maxObservations: 2, now: c.now })
			obs.report(10, 0.5, 'a')
			obs.report(20, 0.5, 'b')
			obs.report(30, 0.5, 'c')

			expect(obs.observations().map(o => o.source)).to.deep.equal(['b', 'c'])
			expect(obs.observations().every(o => o.timestamp === c.at())).to.equal(true)
		})

		it('refuses non-finite input rather than poisoning every subsequent blend', () => {
			const obs = new SizeObserver()
			obs.report(NaN, 0.9, 'nan-estimate')
			obs.report(100, NaN, 'nan-confidence')
			obs.report(Infinity, 0.9, 'inf-estimate')
			obs.report(100, -Infinity, 'inf-confidence')

			expect(obs.observations()).to.have.length(0, 'no non-finite observation may be stored')

			const blended = obs.blend(local(50, 0.8))
			expect(Number.isFinite(blended.size_estimate)).to.equal(true)
			expect(Number.isFinite(blended.confidence)).to.equal(true)
			expect(blended.size_estimate).to.equal(50)
		})

		it('refuses a confidence outside [0, 1] — it is a blend weight, not just a report', () => {
			// `FretService.reportNetworkSize` is public API and passes straight through, so this
			// is the boundary for a local caller as well as for the two wire parsers. An
			// out-of-range confidence re-scales every *other* observation's contribution: 5
			// outvotes five honest reports, and a negative one subtracts from `totalWeight`.
			const obs = new SizeObserver()
			obs.report(100, 5, 'over')
			obs.report(100, -1, 'under')
			obs.report(100, 1.0000001, 'just-over')
			expect(obs.observations()).to.have.length(0, 'no out-of-range confidence may be stored')

			// The boundaries themselves are legal.
			obs.report(100, 0, 'zero')
			obs.report(100, 1, 'one')
			expect(obs.observations().map(o => o.source)).to.deep.equal(['zero', 'one'])
		})

		it('a refused confidence cannot outvote honest reports in the blend', () => {
			// The point of the refusal, stated as behavior rather than as storage: without it the
			// weight (recency × confidence) of the crafted report dominates the sum.
			const obs = new SizeObserver()
			obs.report(1_000_000, 1000, 'crafted')
			obs.report(100, 1, 'honest')

			expect(obs.blend(local(100, 1)).size_estimate).to.equal(100)
		})

		it('accepts a negative estimate — the > 0 gate lives at the caller, not here', () => {
			// `calibrateSizeFromSnapshot` gates on `size_estimate > 0`; the observer carries today's
			// behavior across unchanged rather than adding a second, differently-placed gate.
			const obs = new SizeObserver()
			obs.report(-5, 0.5, 'negative')
			expect(obs.observations()).to.have.length(1)
		})

		it('hands out a defensive copy', () => {
			const obs = new SizeObserver()
			obs.report(100, 0.5, 'a')

			const snapshot = obs.observations()
			snapshot[0]!.estimate = 999
			snapshot.push({ estimate: 1, confidence: 1, timestamp: 0, source: 'injected' })

			expect(obs.observations()).to.have.length(1)
			expect(obs.observations()[0]!.estimate).to.equal(100)
		})
	})

	describe('blend', () => {
		it('returns the local estimate alone when nothing has been reported', () => {
			const obs = new SizeObserver()

			const out = obs.blend(local(42, 0.7))
			expect(out.size_estimate).to.equal(42)
			expect(out.confidence).to.be.closeTo(0.7, 1e-12)
			expect(out.sources).to.equal(1, 'the local estimate is always the first observation')
		})

		// The regression the two-denominator rule exists for: `size_estimate` is weighted by
		// recency × confidence while the reported *confidence* is weighted by recency only.
		// Dividing the recency-weighted numerator by an unweighted observation count instead made
		// four agreeing observations at confidence 0.5 report 0.23.
		it('reports the agreed confidence for agreeing observations spread across the window', () => {
			const c = clock()
			const obs = new SizeObserver({ now: c.now })

			// Lay three down oldest-first by advancing the clock between reports, ending at ages
			// 240s / 120s / 60s. The local estimate joins them at age 0 — four in total, all at 0.5.
			obs.report(200, 0.5, 'aged-240')
			c.advance(120_000)
			obs.report(200, 0.5, 'aged-120')
			c.advance(60_000)
			obs.report(200, 0.5, 'aged-60')
			c.advance(60_000)

			const out = obs.blend(local(200, 0.5))
			expect(out.sources).to.equal(4)
			expect(out.confidence).to.be.closeTo(0.5, 1e-9,
				'four agreeing observations at 0.5 must report 0.5, not the 0.23 an unweighted ' +
				'denominator produced; got ' + out.confidence)
			expect(out.size_estimate).to.equal(200)
		})

		it('weights the size by recency × confidence, so a recent observation dominates', () => {
			const c = clock()
			const obs = new SizeObserver({ now: c.now })
			obs.report(1000, 0.9, 'old-and-confident')
			c.advance(WINDOW - 1) // still inside the window, but heavily decayed

			const out = obs.blend(local(100, 0.9))
			expect(out.size_estimate).to.be.lessThan(300,
				'a nearly-window-old observation must not drag the blend to the midpoint')
			expect(out.size_estimate).to.be.greaterThan(100)
		})

		it('returns the guarded degenerate answer when every observation carries confidence 0', () => {
			const obs = new SizeObserver()
			obs.report(500, 0, 'zero-a')
			obs.report(700, 0, 'zero-b')

			expect(obs.blend(local(300, 0))).to.deep.equal({ size_estimate: 0, confidence: 0, sources: 0 },
				'`totalWeight === 0` is reachable and must not divide by zero')
		})

		it('still weights observations older than the window rather than dividing by zero', () => {
			// `report` trims on append, so the array can only hold stale entries when nothing has
			// been reported since. Their recency weight is tiny, not zero.
			const c = clock()
			const obs = new SizeObserver({ now: c.now })
			obs.report(1000, 0.9, 'stale')
			c.advance(WINDOW * 4)

			const out = obs.blend(local(10, 0.5))
			expect(Number.isFinite(out.size_estimate)).to.equal(true)
			expect(Number.isFinite(out.confidence)).to.equal(true)
			expect(out.sources).to.equal(2, 'the stale entry is still in the array; blend does not trim')
			expect(out.size_estimate).to.equal(10, 'its weight is negligible against the local estimate')
		})

		it('does not divide by zero or exceed confidence 1 when the clock never advances', () => {
			const obs = new SizeObserver({ now: () => 5_000 })
			for (let i = 0; i < 5; i++) obs.report(100, 1, 'same-instant-' + i)

			const out = obs.blend(local(100, 1))
			expect(out.size_estimate).to.equal(100)
			expect(out.confidence).to.equal(1, '`Math.min(1, avgConfidence)` is the guard')
			expect(out.sources).to.equal(6)
		})

		it('clamps a local confidence above 1', () => {
			expect(new SizeObserver().blend(local(100, 3)).confidence).to.equal(1)
		})
	})

	describe('churnPerMinute', () => {
		it('returns 0 with fewer than two observations', () => {
			const obs = new SizeObserver()
			expect(obs.churnPerMinute()).to.equal(0)
			obs.report(100, 0.5)
			expect(obs.churnPerMinute()).to.equal(0)
		})

		it('returns 0 when every observation is in the recent half', () => {
			const c = clock()
			const obs = new SizeObserver({ now: c.now })
			obs.report(100, 0.5)
			c.advance(1000)
			obs.report(200, 0.5)

			expect(obs.churnPerMinute()).to.equal(0, 'no older half → undecidable')
		})

		it('returns 0 when every observation is in the older half', () => {
			const c = clock()
			const obs = new SizeObserver({ now: c.now })
			obs.report(100, 0.5)
			obs.report(200, 0.5)
			c.advance(WINDOW / 2) // both now sit exactly at the cutoff; the filter is `> cutoff`

			expect(obs.churnPerMinute()).to.equal(0, 'no recent half → undecidable')
		})

		it('reports growth per minute across the two halves', () => {
			const c = clock()
			const obs = new SizeObserver({ now: c.now })
			obs.report(100, 0.5, 'older')
			c.advance(WINDOW / 2)
			obs.report(250, 0.5, 'recent')

			// recentAvg 250, olderAvg 100 → (150 / 150_000) * 60_000 = 60 per minute
			expect(obs.churnPerMinute()).to.be.closeTo(60, 1e-9)
		})

		it('reports a negative rate when the network is shrinking', () => {
			const c = clock()
			const obs = new SizeObserver({ now: c.now })
			obs.report(400, 0.5, 'older')
			c.advance(WINDOW / 2)
			obs.report(100, 0.5, 'recent')

			expect(obs.churnPerMinute()).to.be.closeTo(-120, 1e-9)
		})
	})

	describe('detectPartition', () => {
		/** Lay down `count` observations at `estimate`, spaced `spacingMs` apart. */
		function fill(
			obs: SizeObserver,
			c: ReturnType<typeof clock>,
			count: number,
			estimate: number,
			confidence: number,
			spacingMs: number
		): void {
			for (let i = 0; i < count; i++) {
				obs.report(estimate, confidence, 'f' + i)
				c.advance(spacingMs)
			}
		}

		/**
		 * A ring that has collapsed: `oldCount` observations at 1000 sitting well past the 30 s
		 * "old" line, then `recentCount` at 100 in the last second. The blend is dominated by the
		 * recent, barely-decayed observations, so `size_estimate / oldAvg` lands near 0.1.
		 *
		 * Shaping the *observations* is what makes the drop arm reachable — passing a low `local`
		 * against a history of high observations does not, because `local` is one observation among
		 * many and the blend simply outvotes it.
		 */
		function collapsed(oldCount: number, recentCount: number, confidence: number): SizeObserver {
			const c = clock()
			const obs = new SizeObserver({ now: c.now })
			fill(obs, c, oldCount, 1000, confidence, 1_000)
			c.advance(200_000)
			fill(obs, c, recentCount, 100, confidence, 100)
			return obs
		}

		it('returns false with fewer than 10 observations', () => {
			// Same collapse shape as the firing case below, one observation short of the floor.
			const obs = collapsed(4, 5, 0.9)
			expect(obs.observations()).to.have.length(9)
			expect(obs.detectPartition(local(100, 0.9))).to.equal(false)
		})

		it('proceeds at exactly 10 observations (the comparison is `< 10`)', () => {
			const obs = collapsed(5, 5, 0.9)
			expect(obs.observations()).to.have.length(10)
			expect(obs.detectPartition(local(100, 0.9))).to.equal(true,
				'10 observations must be enough for the drop check to run and fire')
		})

		it('returns false when the blended confidence is below 0.3', () => {
			// The same collapse that fires at 0.9 must be refused at 0.2 — the gate, not the shape.
			const obs = collapsed(6, 6, 0.2)
			expect(obs.detectPartition(local(100, 0.2))).to.equal(false)
		})

		it('proceeds at exactly confidence 0.3 (the comparison is `< 0.3`)', () => {
			// Every observation and the local estimate agree at 0.3, so the recency-weighted
			// average of the confidences is exactly 0.3 — the boundary value itself.
			const obs = collapsed(6, 6, 0.3)
			expect(obs.blend(local(100, 0.3)).confidence).to.be.closeTo(0.3, 1e-9)
			expect(obs.detectPartition(local(100, 0.3))).to.equal(true)
		})

		it('returns false when fewer than 3 observations are older than 30 s', () => {
			const c = clock()
			const obs = new SizeObserver({ now: c.now })
			// Two old ones, then ten fresh ones inside the 30 s line — twelve in total, so the
			// count floor is cleared and only the old-observation floor of 3 can refuse.
			fill(obs, c, 2, 1000, 0.9, 1_000)
			c.advance(200_000)
			fill(obs, c, 10, 100, 0.9, 100)

			expect(obs.detectPartition(local(100, 0.9))).to.equal(false,
				'the old-observation floor is 3')
		})

		it('fires on a sudden drop of more than 50%', () => {
			const obs = collapsed(6, 6, 0.9)
			expect(obs.blend(local(100, 0.9)).size_estimate / 1000).to.be.lessThan(0.5)
			expect(obs.detectPartition(local(100, 0.9))).to.equal(true)
		})

		it('does not fire on a stable ring', () => {
			const c = clock()
			const obs = new SizeObserver({ now: c.now })
			// All twelve agree with the local estimate and are old, so the drop ratio is 1.0 and
			// the churn is 0 (everything sits in the recent half of the 5-minute window).
			fill(obs, c, 12, 1000, 0.9, 1_000)
			c.advance(30_001)

			expect(obs.detectPartition(local(1000, 0.9))).to.equal(false)
		})

		it('fires on churn above 10% of the blended size per minute without a 50% drop', () => {
			const c = clock()
			const obs = new SizeObserver({ now: c.now })
			// Older half sits at 1000, recent half at 1400 — growth, so the drop ratio stays well
			// above 0.5 and only the churn arm can fire.
			fill(obs, c, 6, 1000, 0.9, 1_000)
			c.advance(WINDOW / 2)
			fill(obs, c, 6, 1400, 0.9, 1_000)
			c.advance(30_001)

			const blended = obs.blend(local(1400, 0.9))
			expect(blended.size_estimate / 1000).to.be.greaterThan(0.5)
			expect(Math.abs(obs.churnPerMinute())).to.be.greaterThan(blended.size_estimate * 0.1)
			expect(obs.detectPartition(local(1400, 0.9))).to.equal(true)
		})
	})

	describe('clear', () => {
		it('drops every observation, and blend afterwards returns the local estimate alone', () => {
			const obs = new SizeObserver()
			obs.report(1000, 0.9, 'a')
			obs.report(2000, 0.9, 'b')
			expect(obs.observations()).to.have.length(2)

			obs.clear()

			expect(obs.observations()).to.have.length(0)
			// `stop()` may land while a stabilization tick is between its awaits, so a blend right
			// after a clear must answer rather than throw.
			expect(obs.blend(local(7, 0.6))).to.deep.equal({ size_estimate: 7, confidence: 0.6, sources: 1 })
			expect(obs.churnPerMinute()).to.equal(0)
			expect(obs.detectPartition(local(7, 0.6))).to.equal(false)
		})
	})
})
