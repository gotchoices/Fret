/**
 * How long the stabilization loop waits between passes while nothing changes — a pure state
 * machine with no timer and no clock, so the loop in `fret-service.ts` stays a thin scheduler and
 * the policy is unit-testable without sleeps.
 *
 * The ladder: the delay starts at `baseMs` and doubles after every **quiet** pass up to `capMs`,
 * so at the shipped numbers (1.5 s base, 60 s cap) it runs 1.5 → 3 → 6 → 12 → 24 → 48 → 60 s and
 * the seventh quiet pass reaches the cap about 95 s after the last change. It snaps back to the
 * base the moment a **change** is noted — anything the next pass could act on (a connection
 * forming or dropping, a new entry, a label or liveness transition, an address becoming known) —
 * and holds at the base, without counting as a change, while a pass left work **pending**
 * (off-ring peers it selected for probing, a redial it outlived).
 *
 * A change is recorded as a bump of a monotonic counter, and a pass snapshots that counter when it
 * opens: {@link endPass} compares the two, so a change that lands *during* a pass is seen at that
 * pass's end with no flag to clear at the right moment. A change that lands *between* passes is
 * the service's wake path's business — {@link noteChange} drops {@link delayMs} to the base at
 * once, which is what that path reads to decide whether to shorten an armed timer.
 *
 * `capMs` at or below `baseMs` disables backoff: the effective cap is `max(capMs, baseMs)`, so the
 * delay never leaves the base. That is the host's off switch; it needs no boolean.
 */
export class IdleBackoff {
	readonly baseMs: number;
	readonly capMs: number;
	private delay: number;
	private quiet = 0;
	/** Monotonic; bumped by every {@link noteChange}. */
	private changes = 0;
	/** The value of `changes` when the open pass began. */
	private changesAtBegin = 0;
	private pending = false;

	constructor(opts: { baseMs: number; capMs: number }) {
		this.baseMs = opts.baseMs;
		this.capMs = Math.max(opts.capMs, opts.baseMs);
		this.delay = this.baseMs;
	}

	/** The delay the next pass will be armed at. Starts at `baseMs`. */
	get delayMs(): number {
		return this.delay;
	}

	/** Consecutive passes that found nothing; 0 after any change. Diagnostics only. */
	get quietPasses(): number {
		return this.quiet;
	}

	/**
	 * Something the next pass could act on happened — during or between passes. Drops the delay to
	 * the base immediately, so a caller that arms a timer right after this reads the base.
	 */
	noteChange(): void {
		this.changes++;
		this.quiet = 0;
		this.delay = this.baseMs;
	}

	/** Open a pass: snapshot the change counter and clear the pending flag. */
	beginPass(): void {
		this.changesAtBegin = this.changes;
		this.pending = false;
	}

	/**
	 * The open pass left work no event will announce the outcome of — it selected off-ring peers to
	 * probe, or a redial it started is still running. Holds the next delay at the base. Not a
	 * change: nothing happened yet, and counting it would reset the quiet count on every pass that
	 * merely *looked* at a dead peer inside its backoff window.
	 */
	notePending(): void {
		this.pending = true;
	}

	/**
	 * Close the pass and return the delay to arm: the base if a change landed since
	 * {@link beginPass} or the pass is pending, otherwise double the current delay, capped.
	 */
	endPass(): number {
		if (this.changes !== this.changesAtBegin || this.pending) {
			this.quiet = 0;
			this.delay = this.baseMs;
		} else {
			this.quiet++;
			this.delay = Math.min(this.delay * 2, this.capMs);
		}
		return this.delay;
	}

	/** A run ended: back to the base, nothing pending, quiet count 0. */
	reset(): void {
		this.delay = this.baseMs;
		this.quiet = 0;
		this.pending = false;
		this.changesAtBegin = this.changes;
	}
}
