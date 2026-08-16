const DEFAULT_TIMEOUT_MS = 12000
const DEFAULT_STEP_MS = 25

/**
 * Poll `predicate` until it returns true, instead of sleeping a fixed duration and hoping the
 * work finished in time. Throws (rather than returning silently) if the deadline is reached
 * first, so a chain of waits fails at the wait that actually stalled instead of surfacing as an
 * opaque mocha timeout at the assertion several waits later.
 */
export async function waitFor(
	predicate: () => boolean,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
	stepMs: number = DEFAULT_STEP_MS,
	label?: string
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise((r) => setTimeout(r, stepMs))
	}
	if (predicate()) return
	throw new Error(`waitFor timed out after ${timeoutMs}ms${label ? `: ${label}` : ''}`)
}
