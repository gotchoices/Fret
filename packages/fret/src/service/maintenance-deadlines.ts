/**
 * The deadlines FRET talks to a peer under over an **open** connection, derived from one host
 * declaration: the round trip of the slowest link between any two nodes that talk, relayed hops
 * included (`FretConfig.linkRoundTripMs`). Store-free and clock-free, like `idle-backoff.ts`.
 *
 * The service keeps its shipped constants (`FretService.MAINTENANCE_RPC_TIMEOUT_MS` and its
 * siblings, `RPC_TIMEOUT_MS`) and hands them in as **floors**: a declaration can only lengthen a
 * deadline, never shorten one below today's value, and an undeclared link returns the floors
 * exactly. The floors are passed in per call rather than read here because the test rigs assign
 * those statics — some after the service is built — to shrink budgets to tens of milliseconds.
 *
 * Round-trip counts (R = the declared round trip):
 *
 * - **Ping, 2·R** ({@link PING_ROUND_TRIPS}). Stream negotiation plus the echo: Sereus measured a
 *   relayed `newStream` at one full round trip, and the ping's request and reply are the second.
 *   Also the budget of an announce, which is the same shape with no reply of substance.
 * - **Snapshot fetch, 3·R** ({@link SNAPSHOT_ROUND_TRIPS}). The ping's two, plus one for
 *   transferring up to 64 KiB (`MAX_NEIGHBORS_BYTES`) on a warm connection. Matches Optimystic's
 *   `RESPONSE_ROUND_TRIPS` of 3 (`../optimystic/packages/db-p2p/src/rpc-deadline.ts`).
 * - **Phase 1 of a tick, ping + snapshot**, and **the tick, phase 1 + ping** — composed from the
 *   *derived* ping and snapshot, never from R directly. That is what makes the two tick invariants
 *   (`pingMs + snapshotMs <= phaseOneMs`, `phaseOneMs + pingMs <= tickMs`) hold at every
 *   declaration and for any floors by construction: each composed field is a `max` whose second
 *   argument is exactly the sum the invariant needs. Phase 2's reserve (`tickMs − phaseOneMs`) is
 *   therefore always at least one ping, so phase 2 can still complete a probe against a live
 *   `dead` or `unknown` peer however slow the link.
 * - **Route, 2 hops × 2·R** ({@link ROUTE_HOPS}). An outbound maybeAct returns only once the
 *   whole remaining route has answered, so its budget is a route budget: the hop to the target,
 *   plus one more hop's worth for the forward the target may make, or the activity it performs,
 *   before answering. The hop count is a judgement, not a measurement.
 *   NOTE: revisit {@link ROUTE_HOPS} if routed maybeAct requests time out on a declared link.
 */

/** The link-bound deadlines one service runs under, in ms. */
export interface MaintenanceDeadlines {
	/** One maintenance ping or announce over an open connection. */
	pingMs: number;
	/** One neighbour-snapshot fetch over an open connection. */
	snapshotMs: number;
	/** Phase 1 of a stabilization tick (near pings, then snapshot fetches). */
	phaseOneMs: number;
	/** One whole stabilization tick. */
	tickMs: number;
	/** Whole-RPC budget of an outbound maybeAct (a route budget, not a link one). */
	routeMs: number;
}

/** Round trips in one ping: stream negotiation, then the echo. */
export const PING_ROUND_TRIPS = 2;
/** Round trips in one snapshot fetch: the ping's two, plus one to transfer up to 64 KiB. */
export const SNAPSHOT_ROUND_TRIPS = 3;
/** Hops' worth of ping-sized exchanges an outbound maybeAct waits on. A judgement — see above. */
export const ROUTE_HOPS = 2;
/** Round trips in one whole tick at its composed worst case: phase 1 (ping + snapshot), then one ping. */
export const TICK_ROUND_TRIPS = PING_ROUND_TRIPS + SNAPSHOT_ROUND_TRIPS + PING_ROUND_TRIPS;

/**
 * The largest declarable round trip. Above it the tick deadline ({@link TICK_ROUND_TRIPS} × R)
 * exceeds the 32-bit `setTimeout` limit (2^31 − 1 ms), which Node and browsers answer by firing
 * almost at once — a tick deadline that cancels every tick. About 306 million ms, which is above
 * Optimystic's own `MAX_LINK_ROUND_TRIP_MS` (about 47.7 million ms): every value Optimystic
 * accepts, FRET accepts. Keep it that way — the reverse would make a valid Optimystic node fail
 * at FRET construction.
 */
export const MAX_LINK_ROUND_TRIP_MS = Math.floor((2 ** 31 - 1) / TICK_ROUND_TRIPS);

/**
 * The deadlines for a declared link round trip, each floored at the matching field of `floors`.
 * `undefined` (nothing declared) returns a copy of `floors`, field for field. Fractional
 * round trips are accepted; validation of the declaration is the caller's (the service
 * constructor's), so this function trusts `linkRoundTripMs` to be positive, finite and at most
 * {@link MAX_LINK_ROUND_TRIP_MS}.
 */
export function resolveMaintenanceDeadlines(
	linkRoundTripMs: number | undefined,
	floors: MaintenanceDeadlines,
): MaintenanceDeadlines {
	if (linkRoundTripMs === undefined) return { ...floors };
	const pingMs = Math.max(floors.pingMs, PING_ROUND_TRIPS * linkRoundTripMs);
	const snapshotMs = Math.max(floors.snapshotMs, SNAPSHOT_ROUND_TRIPS * linkRoundTripMs);
	const phaseOneMs = Math.max(floors.phaseOneMs, pingMs + snapshotMs);
	return {
		pingMs,
		snapshotMs,
		phaseOneMs,
		tickMs: Math.max(floors.tickMs, phaseOneMs + pingMs),
		routeMs: Math.max(floors.routeMs, ROUTE_HOPS * PING_ROUND_TRIPS * linkRoundTripMs),
	};
}
