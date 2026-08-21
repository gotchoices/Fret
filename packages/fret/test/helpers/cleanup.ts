import { afterEach } from 'mocha'

/**
 * Per-case teardown registry.
 *
 * A case registers what it built *as it builds it* instead of stopping it on its last statement.
 * A failing assertion earlier in the body then still tears down — otherwise the libp2p nodes and
 * their stabilization timers stay live and the mocha exit watchdog
 * (`test/mocha-exit-watchdog.ts`) fails the run a *second* time with an open-handle dump, burying
 * the assertion failure the developer actually needs to see.
 *
 * Registering at construction time rather than at the end of the body is the load-bearing half:
 * it also covers a throw from the *setup* statements that follow the one being registered.
 *
 * Entries unwind in reverse construction order (services before the nodes under them, newest
 * first), and each entry is best-effort: one throwing `stop()` is logged and cannot strand the
 * entries behind it. That is the `Promise.allSettled` property stated as a sequential loop —
 * teardown order matters here, so these cannot run concurrently.
 */
export interface Cleanup {
	/** Register one teardown step. Runs after the entries registered before it. */
	add(fn: () => Promise<void> | void): void
	/** Unwind everything registered so far and empty the registry. Never throws. */
	run(): Promise<void>
}

/**
 * Build a registry and install the `afterEach` that unwinds it.
 *
 * **Call this inside the `describe` whose cases it should clean up.** Called at module scope it
 * attaches to mocha's root suite instead, which runs the (empty, harmless) hook after every test
 * in the whole run rather than only this file's.
 */
export function useCleanup(): Cleanup {
	const fns: Array<() => Promise<void> | void> = []
	const cleanup: Cleanup = {
		add(fn) { fns.push(fn) },
		async run() {
			for (let i = fns.length - 1; i >= 0; i--) {
				// Surfaced, not swallowed: teardown continues past a failure, but a failure that
				// happened is still reported — the point is "don't strand siblings", not "hide it".
				try { await fns[i]!() } catch (err) { console.error('[test cleanup] teardown step failed:', err) }
			}
			fns.length = 0
		}
	}
	afterEach(() => cleanup.run())
	return cleanup
}
