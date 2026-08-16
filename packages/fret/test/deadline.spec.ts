import { describe, it } from 'mocha'
import { expect } from 'chai'
import { deadline, DeadlineExpiredError, abortReasonError } from '../src/utils/deadline.js'

/**
 * Resolve when `signal` aborts.
 *
 * Preferred over sleeping past the budget and then asserting: the property is "it aborts, and
 * not appreciably before its budget", and a fixed sleep can only ever check the first half. A
 * deadline that never fires falls through to mocha's own per-test timeout — which is the exact
 * failure mode this module exists to prevent, so failing that way reads correctly.
 */
function aborted(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve()
	return new Promise<void>(resolve => {
		signal.addEventListener('abort', () => { resolve() }, { once: true })
	})
}

const sleep = (ms: number): Promise<void> => new Promise(r => { setTimeout(r, ms) })

/** `AbortSignal.reason` is typed `any`; narrow it once here rather than casting at each site. */
function reasonOf(signal: AbortSignal): unknown {
	return (signal as { reason?: unknown }).reason
}

// A budget far longer than any test here, so only the parent (or `cancel()`) can end these
// deadlines — the timer arm is then provably not what produced the result.
const NEVER_MS = 60_000

describe('deadline', () => {
	it('fires after ms, aborting with a DeadlineExpiredError', async () => {
		const d = deadline(50)
		const t0 = Date.now()
		try {
			await aborted(d.signal)
			expect(d.signal.aborted, 'aborted').to.equal(true)
			expect(reasonOf(d.signal), 'reason').to.be.instanceOf(DeadlineExpiredError)
			// Lower bound only, and slack: timers may fire a tick early on some runtimes, and the
			// property is "not appreciably before the budget", not scheduler precision.
			expect(Date.now() - t0, 'elapsed').to.be.at.least(40)
		} finally {
			d.cancel()
		}
	})

	it('cancel() before the budget leaves the signal un-aborted and clears the timer', async () => {
		const d = deadline(30)
		d.cancel()

		await sleep(120) // well past the budget the timer was armed for

		// The signal staying un-aborted *is* the cleared-timer assertion: the timer's only effect
		// is to abort. The other half — that the handle no longer holds the process open — is
		// asserted by the suite completing at all, since the repo's mocha exit watchdog fails the
		// run on a live handle 10s after the last test.
		expect(d.signal.aborted, 'aborted after cancel').to.equal(false)
	})

	it('propagates a parent abort to the child immediately', () => {
		const parent = new AbortController()
		const d = deadline(NEVER_MS, parent.signal)
		expect(d.signal.aborted, 'before parent abort').to.equal(false)

		parent.abort(new Error('caller gave up'))

		// Asserted without awaiting a tick: `EventTarget` dispatch is synchronous, and callers
		// such as `openRpcStream` read `signal.aborted` synchronously before dialing.
		expect(d.signal.aborted, 'after parent abort').to.equal(true)
		expect((reasonOf(d.signal) as Error).message, 'reason carried through').to.equal('caller gave up')
		d.cancel()
	})

	it('cancel() after a parent abort is safe', () => {
		const parent = new AbortController()
		const d = deadline(NEVER_MS, parent.signal)
		parent.abort(new Error('caller gave up'))

		// The parent-abort handler already cancelled; every holder still calls `cancel()` from a
		// `finally`, so the second call must not throw and must not undo the abort.
		expect(() => { d.cancel() }, 'cancel after parent abort').to.not.throw()
		expect(d.signal.aborted, 'still aborted').to.equal(true)
	})

	it('yields an already-aborted child synchronously for an already-aborted parent', () => {
		const parent = new AbortController()
		parent.abort(new Error('already gone'))

		const d = deadline(NEVER_MS, parent.signal)

		// No `await` anywhere above: a child that only aborted on the microtask queue would still
		// let `openRpcStream`'s pre-dial check pass, and the dial would go out after `stop()`.
		expect(d.signal.aborted, 'aborted synchronously').to.equal(true)
		expect((reasonOf(d.signal) as Error).message, 'parent reason').to.equal('already gone')
		d.cancel()
	})

	it('double cancel() is a no-op', () => {
		const parent = new AbortController()
		const d = deadline(NEVER_MS, parent.signal)

		d.cancel()
		expect(() => { d.cancel() }, 'second cancel').to.not.throw()
		expect(d.signal.aborted, 'cancel must never abort').to.equal(false)
	})

	it('cancel() detaches the parent listener, so a later parent abort does not reach the child', () => {
		const parent = new AbortController()
		const d = deadline(NEVER_MS, parent.signal)

		d.cancel()
		parent.abort(new Error('too late'))

		// The `removeEventListener` half of `cancel()`. Nothing else pins it, and a leaked listener
		// accumulates one entry per RPC on a long-lived run signal.
		expect(d.signal.aborted, 'child after cancel then parent abort').to.equal(false)
	})
})

describe('abortReasonError', () => {
	it('passes an Error reason through unchanged', () => {
		const c = new AbortController()
		const original = new Error('caller gave up')
		c.abort(original)

		expect(abortReasonError(c.signal), 'same instance').to.equal(original)
	})

	it('wraps a non-Error reason as an AbortError', () => {
		const c = new AbortController()
		c.abort('gave up')

		const err = abortReasonError(c.signal)
		expect(err, 'wrapped').to.be.instanceOf(Error)
		expect(err.name, 'name').to.equal('AbortError')
		expect(err.message, 'message').to.equal('gave up')
	})

	it('names a missing reason "aborted"', () => {
		// Node populates `reason` with a DOMException (itself an Error) when `abort()` is called
		// with no argument, so the null case is only reachable on the older/polyfilled runtimes
		// the normalization exists for — stubbed here rather than left untested.
		const err = abortReasonError({ reason: undefined } as unknown as AbortSignal)
		expect(err.name, 'name').to.equal('AbortError')
		expect(err.message, 'message').to.equal('aborted')
	})
})
