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

/** The value {@link awaitUnlessAborted} resolves to when the signal fired before the promise settled. */
export const ABORTED: unique symbol = Symbol('aborted');

/**
 * Wait for `promise`, but stop waiting — **without cancelling the promise** — the moment `signal`
 * aborts. Resolves to the promise's value, or to {@link ABORTED} if the signal fired first.
 *
 * The caller keeps a budget the awaited work deliberately does not share: a stabilization tick
 * waits on a redial only for the rest of its own phase, while the redial runs on under its own
 * dial budget and is reclaimed by the next tick. `promise` must never reject — once the signal has
 * fired nothing is listening to it any more, so a later rejection would surface as an unhandled
 * rejection with no caller to attribute it to.
 *
 * No `signal` means wait unconditionally (the never-started service in tests has no run signal).
 */
export function awaitUnlessAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
	if (signal === undefined) return promise;
	if (signal.aborted) return Promise.resolve(ABORTED);
	return new Promise<T | typeof ABORTED>((resolve) => {
		const onAbort = (): void => resolve(ABORTED);
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
			() => { signal.removeEventListener('abort', onAbort); resolve(ABORTED); }
		);
	});
}
