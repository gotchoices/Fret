/**
 * Bounded task pool: run `tasks` with at most `concurrency` in flight, so a caller stops
 * serializing behind one slow item at a time without also stampeding an unbounded burst of
 * work at once.
 */

export type PoolResult<T> =
	| { status: 'fulfilled'; value: T }
	| { status: 'rejected'; reason: unknown }
	/** Never started — the pool's signal aborted before a worker reached it. */
	| { status: 'skipped' };

export interface PoolOptions {
	/** Clamped to ≥ 1; a non-finite value (`NaN`, `Infinity`) clamps to 1 — "unbounded" is not
	 *  a writable concurrency, the same precedent `ExpiringMap`'s capacity clamp sets. */
	concurrency: number;
	/** Checked before each task is pulled off the queue. The pool never aborts on its own —
	 *  cancellation is entirely the caller's. */
	signal?: AbortSignal;
}

/**
 * Run `tasks` with at most `concurrency` in flight. Never rejects; results are index-aligned
 * with `tasks`, which is what lets a caller attribute a result back to its peer.
 *
 * A shared index cursor plus `min(concurrency, tasks.length)` worker loops drain `tasks` in
 * order of availability, not in index order across workers — but every worker keeps draining
 * the cursor until it is exhausted, so the returned array is always dense and always
 * `tasks.length` long, even after an abort.
 *
 * `skipped` is a distinct status rather than a rejection because it is not evidence about the
 * task — the same rule the RPC cancellation work established for a peer we never contacted
 * (see "Our own cancellation is not evidence about the peer" in `docs/fret.md`), restated here
 * in the type so a caller cannot score a task the pool never ran.
 *
 * A task that throws synchronously, before returning a promise, is caught the same as a
 * rejected one — nothing escapes the pool.
 */
export function runPooled<T>(
	tasks: ReadonlyArray<() => Promise<T>>,
	opts: PoolOptions
): Promise<Array<PoolResult<T>>> {
	const concurrency = normalizeConcurrency(opts.concurrency);
	const { signal } = opts;
	const results: Array<PoolResult<T>> = new Array(tasks.length);
	if (tasks.length === 0) return Promise.resolve(results);

	let cursor = 0;

	async function worker(): Promise<void> {
		for (;;) {
			const index = cursor++;
			if (index >= tasks.length) return;
			if (signal?.aborted === true) {
				results[index] = { status: 'skipped' };
				continue;
			}
			try {
				results[index] = { status: 'fulfilled', value: await tasks[index]!() };
			} catch (reason) {
				results[index] = { status: 'rejected', reason };
			}
		}
	}

	const workerCount = Math.min(concurrency, tasks.length);
	return Promise.all(Array.from({ length: workerCount }, () => worker())).then(() => results);
}

function normalizeConcurrency(concurrency: number): number {
	if (!Number.isFinite(concurrency)) return 1;
	return Math.max(1, Math.floor(concurrency));
}
