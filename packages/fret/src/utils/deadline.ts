/**
 * A composed cancellation source: a wall-clock budget, optionally subordinate to a caller's
 * own signal.
 *
 * `cancel()` is **mandatory**, not hygiene. An uncleared `setTimeout` keeps the Node process
 * alive past the last test and the repo's mocha exit watchdog fails the whole run on exactly
 * that; an undetached parent listener accumulates one entry per RPC on a long-lived run signal.
 * Every holder therefore calls it in a `finally`.
 */
export interface Deadline {
	readonly signal: AbortSignal;
	/** Clear the timer and detach the parent listener. Idempotent. MUST be called in a `finally`. */
	cancel(): void;
}

/** The error a deadline aborts with when its own budget — rather than the parent — expires. */
export class DeadlineExpiredError extends Error {
	constructor(ms: number) {
		super(`deadline expired after ${ms}ms`);
		this.name = 'DeadlineExpiredError';
	}
}

/**
 * A signal that aborts after `ms`, or as soon as `parent` aborts, whichever comes first.
 *
 * Built from `AbortController` + `setTimeout` + a parent `abort` listener rather than
 * `AbortSignal.timeout` / `AbortSignal.any`: both are absent on React Native (Hermes) and
 * older browsers, and this codebase is cross-platform by rule.
 *
 * An already-aborted `parent` yields an already-aborted signal **synchronously**, so a caller
 * that checks `signal.aborted` before dialing never issues the dial at all.
 */
export function deadline(ms: number, parent?: AbortSignal): Deadline {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onParentAbort: (() => void) | undefined;

	const cancel = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (onParentAbort !== undefined && parent !== undefined) {
			parent.removeEventListener('abort', onParentAbort);
			onParentAbort = undefined;
		}
	};

	if (parent?.aborted === true) {
		controller.abort(abortReasonError(parent));
		return { signal: controller.signal, cancel };
	}

	timer = setTimeout(() => {
		timer = undefined;
		controller.abort(new DeadlineExpiredError(ms));
		cancel();
	}, ms);

	if (parent !== undefined) {
		onParentAbort = () => {
			controller.abort(abortReasonError(parent));
			cancel();
		};
		parent.addEventListener('abort', onParentAbort, { once: true });
	}

	return { signal: controller.signal, cancel };
}

/**
 * The `Error` an aborted signal should surface as.
 *
 * `AbortSignal.reason` is whatever the aborting party passed, and older/polyfilled runtimes
 * populate it with a plain `DOMException` (or nothing at all) — so it is normalized here once
 * rather than at each site that has to throw or hand an `Error` to `Stream.abort`.
 */
export function abortReasonError(signal: AbortSignal): Error {
	const reason = (signal as { reason?: unknown }).reason;
	if (reason instanceof Error) return reason;
	const err = new Error(reason == null ? 'aborted' : String(reason));
	err.name = 'AbortError';
	return err;
}
