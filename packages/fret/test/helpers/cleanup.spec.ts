import { describe, it } from 'mocha'
import { expect } from 'chai'
import { useCleanup } from './cleanup.js'

/**
 * Direct cover for the teardown registry every migrated spec now depends on. Its three stated
 * properties — reverse unwind order, an emptied registry after `run()`, and best-effort
 * continuation past a throwing step — are all drivable by calling `run()` directly; the
 * `afterEach` that `useCleanup` installs is pinned separately at the bottom, since a case cannot
 * observe its own teardown.
 */
describe('test helpers: cleanup registry', () => {
	const cleanup = useCleanup()

	it('unwinds newest-first, so a service registered after its node stops before it', async () => {
		const order: string[] = []
		cleanup.add(() => { order.push('node') })
		cleanup.add(async () => { await Promise.resolve(); order.push('service') })
		cleanup.add(() => { order.push('rig') })
		await cleanup.run()
		expect(order).to.deep.equal(['rig', 'service', 'node'])
	})

	it('awaits an async step before starting the one behind it', async () => {
		const order: string[] = []
		cleanup.add(() => { order.push('older-start') })
		cleanup.add(async () => {
			order.push('newer-start')
			await new Promise(resolve => setTimeout(resolve, 5))
			order.push('newer-end')
		})
		await cleanup.run()
		expect(order).to.deep.equal(['newer-start', 'newer-end', 'older-start'])
	})

	it('empties the registry, so a second run is a no-op', async () => {
		let runs = 0
		cleanup.add(() => { runs++ })
		await cleanup.run()
		expect(runs).to.equal(1)
		await cleanup.run()
		expect(runs).to.equal(1, 'a re-run must not re-tear-down an already-unwound resource')
	})

	it('empties the registry even when a step threw', async () => {
		let runs = 0
		cleanup.add(() => { runs++; throw new Error('boom') })
		await withConsoleErrorCaptured(() => cleanup.run())
		await cleanup.run()
		expect(runs).to.equal(1)
	})

	it('runs the entries behind a throwing step, and reports the failure', async () => {
		const order: string[] = []
		cleanup.add(() => { order.push('oldest') })
		cleanup.add(() => { throw new Error('sync boom') })
		cleanup.add(async () => { await Promise.reject(new Error('async boom')) })
		cleanup.add(() => { order.push('newest') })

		const logged = await withConsoleErrorCaptured(() => cleanup.run())

		expect(order).to.deep.equal(['newest', 'oldest'], 'a failed stop must not strand its siblings')
		expect(logged).to.have.lengthOf(2, 'both failures surfaced, not swallowed')
		expect(logged.map(args => String(args[1]))).to.deep.equal(
			['Error: async boom', 'Error: sync boom'],
			'reported in unwind order'
		)
	})

	it('never rejects, whatever the steps do', async () => {
		cleanup.add(() => { throw new Error('boom') })
		// The bare `await` is the assertion: an unwind that rejected would fail this case.
		await withConsoleErrorCaptured(() => cleanup.run())
	})
})

/**
 * The `afterEach` half. The first case registers a step and the second asserts it ran — mocha
 * executes cases in declaration order, so the hook between them is the only thing that could
 * have unwound it.
 */
describe('test helpers: cleanup afterEach installation', () => {
	const cleanup = useCleanup()
	let unwound = false

	it('leaves a registered step alone during the case that registers it', () => {
		cleanup.add(() => { unwound = true })
		expect(unwound).to.equal(false)
	})

	it('has unwound the previous case registration before this one starts', () => {
		expect(unwound).to.equal(true)
	})
})

/** Run `fn` with `console.error` captured, returning the argument lists it was called with. */
async function withConsoleErrorCaptured(fn: () => Promise<void>): Promise<unknown[][]> {
	const captured: unknown[][] = []
	const original = console.error
	console.error = (...args: unknown[]) => { captured.push(args) }
	try { await fn() } finally { console.error = original }
	return captured
}
