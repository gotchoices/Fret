const DEFAULT_TIMEOUT_MS = 12000
const DEFAULT_STEP_MS = 25

/**
 * Poll `predicate` until it returns true, instead of sleeping a fixed duration and hoping the
 * work finished in time. Throws (rather than returning silently) if the deadline is reached
 * first, so a chain of waits fails at the wait that actually stalled instead of surfacing as an
 * opaque mocha timeout at the assertion several waits later.
 *
 * A predicate must describe convergence the ring cannot reach on its own. A node's store holds
 * its own entry from `start()`, and a ring walk anchored at self returns self first on *both*
 * sides — so `listPeers().length >= 2` and `getNeighbors(selfCoord, …).length > 0` are already
 * true before a single stabilization tick and wait on nothing. Count remote peers only.
 *
 * The predicate may be async — a condition read through an async API (the libp2p peerStore, say)
 * waits here rather than growing a second copy of this loop next to the test that needs it.
 *
 * NOTE: `label` is last, behind two timing parameters most callers do not want to restate, so
 * most call sites omit it and their timeout reads only `waitFor timed out after 12000ms`. The
 * stack trace still names the line; if that stops being enough, move `label` to the second
 * parameter and push `timeoutMs` / `stepMs` into an options bag.
 */
export async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
	stepMs: number = DEFAULT_STEP_MS,
	label?: string
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await predicate()) return
		await new Promise((r) => setTimeout(r, stepMs))
	}
	if (await predicate()) return
	throw new Error(`waitFor timed out after ${timeoutMs}ms${label ? `: ${label}` : ''}`)
}
