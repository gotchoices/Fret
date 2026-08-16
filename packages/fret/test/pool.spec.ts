import { describe, it } from 'mocha'
import { expect } from 'chai'
import fc from 'fast-check'
import { runPooled } from '../src/utils/pool.js'

describe('runPooled', () => {
	describe('concurrency bound', () => {
		// `delays` varies both the task count (including below, at, and above `concurrency`) and
		// the resolution order: a task with fewer microtask hops settles before one with more, so
		// completion order is decoupled from index order. Asserts on the generated distribution
		// (`nexthop-cost.spec.ts` / `peer-discovery.spec.ts` house pattern) so the interesting
		// regions — more tasks than concurrency, and the bound actually saturated — are provably
		// reached rather than merely possible.
		it('never runs more than `concurrency` tasks at once, across task counts and resolution orders', async () => {
			const outcome = { moreTasksThanConcurrency: 0, saturated: 0 }

			await fc.assert(fc.asyncProperty(
				fc.integer({ min: 1, max: 6 }),
				fc.array(fc.integer({ min: 0, max: 8 }), { minLength: 0, maxLength: 24 }),
				async (concurrency, delays) => {
					let inFlight = 0
					let maxInFlight = 0
					const tasks = delays.map((ticks) => async () => {
						inFlight++
						maxInFlight = Math.max(maxInFlight, inFlight)
						for (let i = 0; i < ticks; i++) await Promise.resolve()
						inFlight--
						return ticks
					})

					const results = await runPooled(tasks, { concurrency })

					expect(maxInFlight).to.be.at.most(concurrency)
					expect(results).to.have.length(tasks.length)
					expect(results.every((r) => r.status === 'fulfilled')).to.equal(true)

					if (tasks.length > concurrency) outcome.moreTasksThanConcurrency++
					if (maxInFlight === concurrency) outcome.saturated++
					return true
				}
			), { numRuns: 200 })

			expect(outcome.moreTasksThanConcurrency, 'tasks > concurrency region was never generated').to.be.greaterThan(0)
			expect(outcome.saturated, 'the concurrency bound was never actually saturated').to.be.greaterThan(0)
		})
	})

	describe('result shape', () => {
		it('is index-aligned and carries the right status for resolving, rejecting, and synchronously-throwing tasks', async () => {
			const asyncRejectError = new Error('async-reject')
			const tasks: Array<() => Promise<number>> = [
				async () => 1,
				async () => { throw asyncRejectError },
				// Throws before ever returning a promise — the worker must catch this the same as
				// an async rejection, not let it escape `runPooled` itself.
				() => { throw new Error('sync-throw') },
				async () => 4,
			]

			const results = await runPooled(tasks, { concurrency: 2 })
			expect(results).to.have.length(4)

			const r0 = results[0]!
			const r1 = results[1]!
			const r2 = results[2]!
			const r3 = results[3]!

			expect(r0).to.deep.equal({ status: 'fulfilled', value: 1 })
			expect(r3).to.deep.equal({ status: 'fulfilled', value: 4 })

			expect(r1.status).to.equal('rejected')
			if (r1.status === 'rejected') expect(r1.reason).to.equal(asyncRejectError)

			expect(r2.status).to.equal('rejected')
			if (r2.status === 'rejected') expect((r2.reason as Error).message).to.equal('sync-throw')
		})
	})

	describe('abort mid-run', () => {
		function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
			let resolve!: (v: T) => void
			const promise = new Promise<T>((res) => { resolve = res })
			return { promise, resolve }
		}

		it('settles already-started tasks, skips the remainder, and never rejects', async () => {
			const controller = new AbortController()
			const started: number[] = []
			const gates = Array.from({ length: 6 }, () => deferred<void>())

			const tasks = gates.map((gate, i) => async () => {
				started.push(i)
				await gate.promise
				return i
			})

			// `runPooled` spawns its worker loops synchronously before returning, so by this point
			// the first `concurrency` (3) tasks have already run up to their `await gate.promise` —
			// "already started" needs no extra tick to arrange.
			const resultsPromise = runPooled(tasks, { concurrency: 3, signal: controller.signal })
			expect(started.slice().sort()).to.deep.equal([0, 1, 2], 'the first 3 workers must have already claimed a task')

			controller.abort()
			for (const gate of gates) gate.resolve()

			const results = await resultsPromise

			expect(results).to.have.length(6, 'the array stays full length even though half never ran')
			for (let i = 0; i < 3; i++) {
				expect(results[i]).to.deep.equal({ status: 'fulfilled', value: i }, `already-started task ${i} must settle`)
			}
			for (let i = 3; i < 6; i++) {
				expect(results[i]).to.deep.equal({ status: 'skipped' }, `never-started task ${i} must be skipped, not run`)
			}
			expect(started).to.deep.equal([0, 1, 2], 'an aborted pool must never pull a fresh index')
		})
	})

	describe('degenerate concurrency', () => {
		for (const [label, given] of [
			['zero', 0], ['negative', -5], ['NaN', NaN], ['Infinity', Infinity],
		] as Array<[string, number]>) {
			it(`clamps a ${label} concurrency to a single worker rather than throwing`, async () => {
				let inFlight = 0
				let maxInFlight = 0
				const tasks = Array.from({ length: 4 }, () => async () => {
					inFlight++
					maxInFlight = Math.max(maxInFlight, inFlight)
					await Promise.resolve()
					inFlight--
					return true
				})

				const results = await runPooled(tasks, { concurrency: given })

				expect(results.every((r) => r.status === 'fulfilled')).to.equal(true)
				expect(maxInFlight).to.equal(1, '"unbounded" must not be a reachable concurrency')
			})
		}

		it('empty task list resolves to [] without running or skipping anything', async () => {
			const results = await runPooled([], { concurrency: 4 })
			expect(results).to.deep.equal([])
		})
	})
})
