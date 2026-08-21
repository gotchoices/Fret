import type { DigitreeStore, PeerEntry } from '../../src/store/digitree-store.js'
import type { SparsityModel } from '../../src/store/relevance.js'
import { normalizedLogDistance, recordFailure, recordSuccess } from '../../src/store/relevance.js'

/**
 * Ring-shaped reads skip entries the probing peer has marked `dead` in its own store. This is
 * liveness only — the sim does not model `membership` — and it is deliberately *not* the global
 * `alive` oracle: it reads only what this peer's own contact attempts recorded.
 */
export const notDead = (e: PeerEntry): boolean => e.state !== 'dead'

export interface LivenessConfig {
	/** Consecutive failed contacts before an entry is marked dead (production: 3). */
	deadAfterFailures: number
	/** Dead entries each peer re-probes per stabilization tick (production's dead arm: 2). */
	deadReprobePerTick: number
}

export interface LivenessDeps {
	/**
	 * The counting reachability predicate (`PartitionModel.contactAllowed`) — a refusal here is
	 * booked as a blocked contact. This is the model's only view of reachability: liveness
	 * consumes the partition state through this predicate alone, never a copy of it.
	 */
	contactAllowed: (a: string, b: string) => boolean
	/**
	 * True when the id names a currently-alive peer. This is the one global-`alive` read in the
	 * sweep, and it stands in for a departed peer's leave notice rather than for knowledge a
	 * peer could not have.
	 */
	isAlive: (id: string) => boolean
	/**
	 * The sparsity (KDE) model belonging to `selfId`. One model **per peer**: a model shared
	 * across peers would make every peer's sparsity bonus a function of every other peer's
	 * observations, which no real node can see.
	 */
	modelFor: (selfId: string) => SparsityModel
	/** Ring coordinate of a peer id — the self-to-peer distance every scoring call takes. */
	coordOf: (id: string) => Uint8Array
}

/**
 * Per-peer contact-failure escalation and dead-entry recovery — the sim's collapsed version of
 * production's near / classify / re-probe passes (see docs/fret.md, Stabilization and churn
 * handling). One instance serves every peer; each call is scoped by the `selfId` whose store is
 * being swept.
 */
export class LivenessModel {
	private readonly deadAfterFailures: number
	private readonly deadReprobePerTick: number
	private readonly contactAllowed: (a: string, b: string) => boolean
	private readonly isAlive: (id: string) => boolean
	private readonly modelFor: (selfId: string) => SparsityModel
	private readonly coordOf: (id: string) => Uint8Array

	constructor(cfg: LivenessConfig, deps: LivenessDeps) {
		this.deadAfterFailures = cfg.deadAfterFailures
		this.deadReprobePerTick = cfg.deadReprobePerTick
		this.contactAllowed = deps.contactAllowed
		this.isAlive = deps.isAlive
		this.modelFor = deps.modelFor
		this.coordOf = deps.coordOf
	}

	/**
	 * One contact attempt per store entry per tick: prune peers that left the network, strike
	 * entries whose peer cannot be reached, and clear the strike run on a successful contact.
	 * The prune is the one global-`alive` read left here (via the injected `isAlive`), and it
	 * stands in for a departed peer's leave notice rather than for knowledge a peer could not
	 * have; the strike/clear arithmetic itself lives in `recordContactFailure` /
	 * `recordContactSuccess`, shared with the routing path so the two escalations cannot drift.
	 * At `deadAfterFailures` strikes the entry is marked `dead` and drops out of every
	 * ring-shaped read via the `notDead` filter.
	 *
	 * Production spaces strikes ≥ 500 ms apart so a burst of concurrent failures counts once
	 * (docs/fret.md — Ring membership). *This sweep* strikes an entry at most once per tick,
	 * so within the sweep the independence the spacing rule buys holds by construction and no
	 * spacing check is re-implemented — a property of the tick, not of the clock: a driver
	 * that processes several ticks at one simulated timestamp still sweeps once per tick.
	 * NOTE: that is no longer the whole picture — `handleRoute` (fret-sim.ts) strikes through
	 * the same `recordContactFailure`, so an entry can take a sweep strike and one route strike
	 * (and one per further route) at the same simulated timestamp, escalating to `dead` faster
	 * than the sweep alone would. Harmless while routes are scheduled sparsely by the specs;
	 * if a suite ever fires many routes per tick through the same unreachable window, add the
	 * production spacing check (≥ 500 ms since `lastContactFailureAt`) inside
	 * `recordContactFailure` rather than re-deriving it per call site.
	 * Production also spreads its contacts across budgeted passes (near / classify /
	 * re-probe) rather than touching every entry each tick; the sim collapses those into one
	 * per-tick sweep, so a fully unreachable population escalates in `deadAfterFailures`
	 * ticks flat.
	 */
	contactSweep(selfId: string, store: DigitreeStore, time: number): void {
		for (const entry of store.list()) {
			if (entry.id === selfId) continue
			if (!this.isAlive(entry.id)) {
				store.remove(entry.id)
				continue
			}
			if (entry.state === 'dead') continue // dead entries belong to the re-probe arm
			if (!this.contactAllowed(selfId, entry.id)) {
				this.recordContactFailure(selfId, store, entry, time)
			} else {
				this.recordContactSuccess(selfId, store, entry, time)
			}
		}
	}

	/**
	 * One failed contact against a store entry: extend the strike run, and at
	 * `deadAfterFailures` mark the entry dead. Called from the per-tick `contactSweep` and
	 * from the routing path's contact attempts (`handleRoute`, fret-sim.ts), which is the whole
	 * point of sharing it — two copies of this arithmetic is how the sweep and the router
	 * drift apart.
	 */
	recordContactFailure(selfId: string, store: DigitreeStore, entry: PeerEntry, time: number): void {
		const strikes = Math.min(entry.contactFailures + 1, this.deadAfterFailures)
		const x = normalizedLogDistance(this.coordOf(selfId), entry.coord)
		const scored = recordFailure(entry, x, this.modelFor(selfId), time)
		// lastAccess ← sim time: the re-probe arm orders by ascending lastAccess, and only
		// sim-clock stamps keep two same-seed runs picking identical candidates (Date.now()
		// stamps differ between runs and would break deterministic replay). Scoring stamps it
		// on *every* failure now, where the old code stamped it only on the dead transition,
		// so the re-probe candidate rotation shifts - see simulation.partition.spec.ts.
		const patch = {
			relevance: scored.relevance,
			failureCount: scored.failureCount,
			lastAccess: time,
			contactFailures: strikes,
		}
		if (strikes >= this.deadAfterFailures) {
			store.update(entry.id, { ...patch, state: 'dead' })
		} else {
			store.update(entry.id, patch)
		}
	}

	/**
	 * A successful contact clears the strike run *and* scores the entry, since proven contact is
	 * what production's success path (`recordSuccess`) records. Latency is deliberately
	 * `undefined`: the sim models no link latency, so there is no sample to blend and
	 * `avgLatencyMs` must stay `null` rather than be fabricated as a 0 ms measurement.
	 *
	 * `time` is sim time, passed by the caller exactly as `recordContactFailure` takes it —
	 * the scoring helpers default `now` to `Date.now()`, and a wall-clock stamp would make two
	 * same-seed replays diverge (recency's half-life is 60 s against sim runs of 4-60 s). It is
	 * a parameter rather than an injected clock because the scheduler's `getCurrentTime()` and
	 * the event's own `time` are not the same number on the `processEvent` / `advanceTo` paths.
	 *
	 * NOTE: `contactSweep` calls this for every reachable non-dead entry on every tick, so
	 * `accessCount` and the KDE occupancy each grow by one per entry per tick - O(store size)
	 * scoring writes per peer per tick, not one per real RPC. That is intended shared-seam
	 * behavior (production's sweep is proven contact), but it means frequency saturates quickly
	 * on long runs; if a suite ever needs frequency to discriminate, give the sweep its own
	 * cadence rather than scoring per tick.
	 */
	recordContactSuccess(selfId: string, store: DigitreeStore, entry: PeerEntry, time: number): void {
		const x = normalizedLogDistance(this.coordOf(selfId), entry.coord)
		const scored = recordSuccess(entry, undefined, x, this.modelFor(selfId), time)
		store.update(entry.id, {
			relevance: scored.relevance,
			lastAccess: scored.lastAccess,
			accessCount: scored.accessCount,
			successCount: scored.successCount,
			contactFailures: 0,
		})
	}

	/**
	 * Re-probe up to `deadReprobePerTick` of this peer's dead entries; a reachable one returns
	 * to `disconnected` with its strike run cleared. Without this, nothing would ever contact a
	 * dead entry again and the merge half of a partition would be untestable — the same trap
	 * production solves with the dead arm of its re-probe pass. Candidates are ordered by
	 * ascending lastAccess (id tie-break) so a truncated pass rotates instead of re-deriving
	 * the same head — the production ordering rule. The sim has no backoff model and does not
	 * need one: production backs dead re-probes off exponentially; here the tick cadence bounds
	 * the rate.
	 *
	 * NOTE: accepted tradeoff — a successful re-probe here restores the entry but applies no
	 * success scoring, where production's dead arm treats the answered ping as proven contact and
	 * scores it. Deliberate: `contactSweep` runs *before* this pass on every tick (fret-sim.ts),
	 * and a restored entry is no longer `dead`, so the very next tick's sweep contacts it and
	 * scores it through `recordContactSuccess`. The whole divergence is therefore one tick of
	 * deferred success credit, weighed against a change that would rewrite stored relevance and
	 * `lastAccess` — the key the re-probe rotation and any capacity-bounded eviction order by.
	 * Revisit if the sweep ever stops running every tick (e.g. it is given its own cadence, as
	 * the magnitude NOTE at `recordContactSuccess` contemplates), or if a spec ever needs a
	 * recovered entry scored within the tick that recovered it.
	 */
	reprobeDeadEntries(selfId: string, store: DigitreeStore, time: number): void {
		const dead = store.list().filter((e) => e.state === 'dead')
		if (dead.length === 0) return
		dead.sort((a, b) => a.lastAccess - b.lastAccess || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		for (const entry of dead.slice(0, this.deadReprobePerTick)) {
			// Stamp before the outcome so the next pass starts past this candidate either way.
			store.update(entry.id, { lastAccess: time })
			if (!this.contactAllowed(selfId, entry.id)) continue
			store.update(entry.id, { state: 'disconnected', contactFailures: 0 })
		}
	}
}
