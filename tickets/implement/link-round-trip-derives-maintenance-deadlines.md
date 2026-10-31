description: FRET's deadlines for talking to a peer over an open connection are fixed (a ping gets 2 s, a snapshot fetch 1 s, a stabilization tick 5 s, a routed request 5 s). On a slow relayed link a ping alone takes about 6 s, so every ping misses and FRET wrongly marks a connected peer dead. Add one optional setting, the link's round-trip time, from which all of these deadlines are derived, never dropping below today's values.
architecture: docs/fret.md#stabilization-and-churn-handling
files: packages/fret/src/service/maintenance-deadlines.ts (new), packages/fret/src/index.ts (FretConfig), packages/fret/src/service/fret-service.ts (MAINTENANCE_RPC_TIMEOUT_MS ~501, MAINTENANCE_SNAPSHOT_TIMEOUT_MS ~514, STABILIZE_TICK_BUDGET_MS ~532, STABILIZE_PHASE_ONE_BUDGET_MS ~559, SHUTDOWN_BUDGET_MS ~568, cfg type ~287, constructor config resolution ~703, use sites ~2129 / ~2223 / ~3053 / ~3059 / ~3391 / ~3656 / ~3742, sendMaybeAct sites ~4231 / ~4514 / ~4607), packages/fret/src/rpc/protocols.ts (RPC_TIMEOUT_MS ~27, registerRpcHandler closeBudgetMs ~160), packages/fret/test/stabilize-budget-invariants.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, docs/fret.md
----
<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-10-31T21:06:16.215Z (agent: claude)
  Log file: C:\projects\Fret\tickets\.logs\link-round-trip-derives-maintenance-deadlines.implement.2026-10-31T21-06-16-215Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
# The declared link round trip sets FRET's maintenance deadlines

Requested by Sereus (`../sereus/tickets/blocked/fret-maintenance-deadlines-below-the-declared-link.md`, GitHub gotchoices/sereus#48). Sereus declares the round trip of the slowest link it supports (`NetworkConfig.linkRoundTripMs`, 3 500 ms by default) and passes it to Optimystic (`NodeOptions.linkRoundTripMs`), which derives its own deadlines from it (`resolveLinkDeadlines` in `../optimystic/packages/db-p2p/src/rpc-deadline.ts`) and already sets FRET's redial budget (`FretConfig.dialTimeoutMs`) from it. FRET's deadlines over an *open* connection are still constants, so on a declared 3.5 s link every maintenance ping times out (2 s budget against ~7 s needed), the peer collects contact strikes, is marked `dead` though its connection is up, and Optimystic leaves it out of every cohort.

## Shape

One optional declaration, `FretConfig.linkRoundTripMs?: number` — the round trip, in ms, of the slowest link between any two nodes that talk, relayed hops included (the same sense as Optimystic's `NodeOptions.linkRoundTripMs`). One field rather than one option per constant because the constants are coupled by the tick invariants below; a host setting them one by one could break them, and Optimystic would have to restate FRET's arithmetic.

### The derivation (a pure module)

New `src/service/maintenance-deadlines.ts`, store-free and clock-free like `idle-backoff.ts`:

```ts
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

export function resolveMaintenanceDeadlines(
	linkRoundTripMs: number | undefined,
	floors: MaintenanceDeadlines,
): MaintenanceDeadlines
```

Round-trip counts, as named constants in that module with the reasoning in a doc comment (the style of Optimystic's `rpc-deadline.ts` block):

| deadline | floor (today's constant) | derived | at R = 3 500 ms |
| --- | --- | --- | --- |
| `pingMs` | `MAINTENANCE_RPC_TIMEOUT_MS` 2 000 | `max(floor, 2·R)` — stream negotiation plus the echo; Sereus measured a relayed `newStream` at one full round trip, so the ping is two | 7 000 |
| `snapshotMs` | `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` 1 000 | `max(floor, 3·R)` — the ping's two, plus one for transferring up to 64 KiB (`MAX_NEIGHBORS_BYTES`) on a warm connection; matches Optimystic's `RESPONSE_ROUND_TRIPS` of 3 | 10 500 |
| `phaseOneMs` | `STABILIZE_PHASE_ONE_BUDGET_MS` 3 000 | `max(floor, pingMs + snapshotMs)` — composed from the *derived* values | 17 500 |
| `tickMs` | `STABILIZE_TICK_BUDGET_MS` 5 000 | `max(floor, phaseOneMs + pingMs)` — composed | 24 500 |
| `routeMs` | `RPC_TIMEOUT_MS` 5 000 | `max(floor, 2 hops · 2·R)` — the hop to the target, plus one more hop's worth for the forward the target may make or the activity it performs before answering | 14 000 |

- **Undeclared (`undefined`) returns `floors` exactly** — every field equal, so a host that declares nothing behaves byte-for-byte as today.
- **The two tick invariants hold at every declaration by construction**, because phase 1 and the tick are composed from the derived ping and snapshot rather than from R directly: `pingMs + snapshotMs <= phaseOneMs` and `phaseOneMs + pingMs <= tickMs` follow from the `max`. They hold for any floors too, which is why test rigs that shrink the floors keep working.
- Fractional R is accepted (Optimystic accepts it; `setTimeout` takes it).
- The route hop count (2) is a judgement, not a measurement — say so in the comment, with the revisit condition: routed maybeAct requests timing out on a declared link.

### Why the statics stay, and are read per use

The five constants remain where they are (`private static readonly` on `FretService`, `RPC_TIMEOUT_MS` exported from `rpc/protocols.ts`) and become the **floors**. The service resolves its deadlines **at each use**, from the current statics and its own declaration, through one private method:

```ts
private deadlines(): MaintenanceDeadlines {
	return resolveMaintenanceDeadlines(this.linkRoundTripMs, FretService.deadlineFloors());
}
```

Resolving once in the constructor was rejected: `test/helpers/maintenance-rig.ts` (`setTickBudget`), `near-exchange.spec.ts`, `per-tick-hotpath.spec.ts` and `fetch-snapshot-failure-arms.spec.ts` assign these statics — some after the service is built — to shrink budgets to tens of milliseconds, and a snapshot taken at construction would silently ignore those assignments. The cost of resolving per use is a few `Math.max` per peer per tick. Moving the floors into the new module was rejected for the same reason: every one of those specs would have to change for no behavioural gain.

`RPC_TIMEOUT_MS` reaches per-instance callers by the service passing an explicit `timeoutMs: this.deadlines().routeMs` to its three `sendMaybeAct` calls (forward in `routeAct` ~4231, probe in `iterativeLookup` ~4514, activity resend ~4607). The exported constant and the defaults of the exported `rpcRequest` / `readFramed` / `sendMaybeAct` stay as they are: they are library functions with no instance to read a declaration from, and a consumer that knows its link passes `timeoutMs` (Optimystic's cohort-topic frame reads, which Sereus noted use FRET's default, are Optimystic's to derive — say so in the release notes for the Optimystic ticket).

### Config and validation

- `FretConfig.linkRoundTripMs?: number` in `src/index.ts`, doc comment in the style of `dialTimeoutMs` / `maxPassiveIntervalMs`: what it is, what it derives, that absence is today's behaviour, that `dialTimeoutMs` is *not* derived from it (below), and the validation rule.
- Validated in the constructor beside `dialTimeoutMs`: absent stays `undefined`; present must be a positive finite number no larger than `MAX_LINK_ROUND_TRIP_MS` (exported from the new module), or the constructor throws naming `linkRoundTripMs`. The ceiling is `Math.floor((2 ** 31 - 1) / TICK_ROUND_TRIPS)` where `TICK_ROUND_TRIPS` is the tick's total round-trip count (7): above it the tick deadline exceeds the 32-bit `setTimeout` limit and fires almost at once. That ceiling (~306 million ms) is above Optimystic's own `MAX_LINK_ROUND_TRIP_MS` (~47.7 million ms), so any value Optimystic accepts FRET accepts — state that in the comment, since the reverse would make a valid Optimystic node fail at FRET construction.
- `this.cfg` is typed `Required<Omit<FretConfig, 'privateKey'>>`; an optional field cannot live there. Store the declaration as its own `private readonly linkRoundTripMs: number | undefined` (or widen the cfg type) — implementer's choice, but do not invent a sentinel number for "undeclared".
- The facade (`libp2p-fret-service.ts` ~100) already spreads the whole config into the core, so `fretService({ linkRoundTripMs })` works with no facade change; confirm by reading.

### Use sites to switch

Every read of the four maintenance statics in `src/` goes through `this.deadlines()`:

- `MAINTENANCE_RPC_TIMEOUT_MS` → `pingMs`: announce fan-out (~2129), warm-up ping (~2223), near ping in `probeNeighborLatency` (~3391), `probeMembership` (~3656).
- `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` → `snapshotMs`: `fetchAndMergeSnapshot` (~3742).
- `STABILIZE_TICK_BUDGET_MS` → `tickMs` (~3053); `STABILIZE_PHASE_ONE_BUDGET_MS` → `phaseOneMs` (~3059). Read once at the top of `stabilizeOnce`.
- Grep afterwards: no `FretService.MAINTENANCE_*` / `FretService.STABILIZE_*_BUDGET_MS` read may remain outside `deadlineFloors()`.

Update the doc comments on the five constants to say they are the undeclared values and the floors, and the arithmetic comments that quote "5000 - 3000 = 2000" (static comments ~546, `stabilizeOnce` doc ~3026–3032, inline ~3074 / ~3092) to state the rule in terms of the resolved deadlines with today's numbers as the undeclared example. Update the forward-site NOTE (~4223, "inside this 5 s route budget") and the announce NOTE (~2122) to name the derived budgets.

### Deliberately not derived

- **`dialTimeoutMs`.** The redial already follows the link through its own option, which Optimystic sets from its 10-round-trip connection count (`libp2pDialTimeoutMs`). Defaulting it from `linkRoundTripMs` would restate a connection-stack count FRET does not own and would drift from Optimystic's; an explicit `dialTimeoutMs` stays the only way to set it. Say so in the `linkRoundTripMs` doc comment.
- **`SHUTDOWN_BUDGET_MS` / `LEAVE_NOTICE_TIMEOUT_MS`.** A leave notice is write-only: on an open connection it returns after a local write with no round trip awaited, and the whole-fan-out budget is how long `stop()` may take — a host-facing latency contract, not a link one. Add a `NOTE:` at `SHUTDOWN_BUDGET_MS`: leave notices to dialable-but-unconnected neighbours dial inside 1.5 s and will not land on a slow relayed link; if graceful departures are missed on declared links, consider deriving the per-notice budget from the declaration.
- **The inbound reply close budget** (`registerRpcHandler`'s `closeBudgetMs`, default `RPC_TIMEOUT_MS`). The close waits for the reply to drain into the local transport, not for a round trip. Add a `NOTE:` at that default: if "reply close exceeded … remote stopped reading" lines appear on declared slow links, thread the derived route budget into the registrars.
- **Idle backoff, strike spacing, the dead-verdict grace.** Pass-counted or time-of-run quantities, not link deadlines. The stabilization loop awaits a tick before arming the next (`runStabilizationPass` awaits `stabilizeOnce`), so a tick budget far longer than the 1.5 s base cannot overlap ticks; it only stretches the pass interval while a tick runs long.

## Edge cases & interactions

- **Undeclared is today, exactly.** `resolveMaintenanceDeadlines(undefined, floors)` deep-equals `floors`. Verified by the invariants spec (below); every existing spec running green at unmutated constants is the end-to-end check.
- **Shrunk floors in test rigs.** Rigs assign the statics after construction; per-use resolution must honour that. Verified by the existing rig specs staying green (`maintenance-redial`, `near-exchange`, `per-tick-hotpath`, `fetch-snapshot-failure-arms`, `stabilize-concurrency`).
- **Small declarations raise some deadlines, not others.** At R = 600: ping stays 2 000, snapshot 1 800, phase 1 3 800, tick 5 800. Each field floors independently and the composition keeps the invariants. Verified by the invariants spec at several declarations.
- **Phase-2 reserve.** `tickMs − phaseOneMs >= pingMs` at every declaration, so phase 2 can still complete one probe against a live `dead`/`unknown` peer — the starvation fix in *Two phases* must survive. By construction; pinned by the spec.
- **Cancellation is still not evidence.** A ping cut off by the (now longer) tick budget is `cancelled` and records nothing; the derivation only changes the numbers, not `wasCancelled`. By inspection.
- **Detection latency grows on a declared link — by design.** A peer behind a half-open connection now takes up to `pingMs` per strike to time out, and three spaced strikes to go `dead`; the address-less departure bound (3–4.5 s, uncontactable strikes booked once per tick) stretches to roughly three tick durations when a slow near peer holds each tick open. State both in `docs/fret.md`; by inspection.
- **Active mode.** Ticks every 300 ms; under mass failure a tick lasting up to `tickMs` makes active stabilization continuous (the existing `NOTE:` at `STABILIZE_TICK_BUDGET_MS` already says so for 5 s) — update that NOTE to name the derived tick.
- **Nested route budgets.** A forwarding node gives its downstream the same `routeMs` its own caller gave it, so the originator's budget expires as the innermost one does. Pre-existing with the flat 5 s; unchanged in kind. Add a one-line `NOTE:` at the forward site if not already covered; not in scope to fix.
- **Validation boundaries.** `0`, negative, `NaN`, `Infinity`, and `MAX_LINK_ROUND_TRIP_MS + 1` throw naming `linkRoundTripMs`; `MAX_LINK_ROUND_TRIP_MS` itself and a fractional value are accepted. Verified by one table-driven case.
- **Facade pass-through.** `fretService({ linkRoundTripMs })` reaches the core through the existing config spread. By inspection.

## Tests

- **`test/stabilize-budget-invariants.spec.ts` — extend, do not replace.** Keep the existing declared-defaults cases. Add, still reading the statics off the class before any rig runs (the spec's existing rule), and calling `resolveMaintenanceDeadlines` directly with those statics as floors:
  - undeclared returns the floors exactly;
  - at each of R ∈ {0.5, 250, 600, 1 000, 3 500, 30 000, `MAX_LINK_ROUND_TRIP_MS`}: every derived field ≥ its floor, `pingMs + snapshotMs <= phaseOneMs`, `phaseOneMs + pingMs <= tickMs`, and `tickMs <= 2 ** 31 - 1`;
  - at R = 3 500 the table's numbers (7 000 / 10 500 / 17 500 / 24 500 / 14 000), so a changed round-trip count is a visible decision rather than a silent drift.
  - The validation table (the boundary row above) — against the constructor, in this spec or beside the `dialTimeoutMs` row in `maintenance-redial.spec.ts`.
- **One reproduction, through the near pass.** Extend `test/helpers/maintenance-rig.ts` with a behaviour that answers after a fixed delay (e.g. `{ answersAfterMs: n }`, settling early if the caller's signal aborts, like `hangsUntilAbort`). With `MAINTENANCE_RPC_TIMEOUT_MS` shrunk to ~100 ms (as `near-exchange.spec.ts` does) and a near peer whose ping answers after ~250 ms: undeclared → the probe times out and books a contact strike (the bug); `linkRoundTripMs: 150` (ping budget 300 ms) → the ping answers, no strike, `pingsOk` increments. Both arms in one spec, a few hundred ms each. This is the test that proves the derived value reaches the ping site; no separate wiring test for the other sites — they are checked by the grep in *Use sites* and by inspection.
- No test for `routeMs` wiring at the three `sendMaybeAct` sites (inspection).

## Docs (`docs/fret.md`)

- *Configuration (suggested defaults)*: a `linkRoundTripMs` bullet — undeclared by default, what it derives, the ceiling, that `dialTimeoutMs` is separate.
- *Stabilization and churn handling* → *Two phases* → "The invariant these numbers must keep": restate over the resolved deadlines, with the derivation table (or a pointer to `maintenance-deadlines.ts`) and the by-construction argument; note the spec now checks it at several declarations.
- *Stream management* → stream read deadline paragraph: the maintenance budgets and the maybeAct route budget follow the declaration; the exported `RPC_TIMEOUT_MS` / `readFramed` / `rpcRequest` defaults do not, and why.
- *Hard failure* / address-less departure: the detection-latency consequence on a declared link (one sentence each).
- `FretConfig.dialTimeoutMs` doc comment in `src/index.ts` says "bounded by a 2 s exchange budget" — make it "the maintenance ping budget (2 s, or derived from `linkRoundTripMs`)".

## After this lands

Release FRET; Optimystic's `fret-receives-the-link-round-trip` then passes `options.linkRoundTripMs` into `fretService({...})` in `libp2p-node-base.ts` beside `dialTimeoutMs`.

## TODO

- Add `src/service/maintenance-deadlines.ts`: `MaintenanceDeadlines`, the round-trip constants with their reasoning, `MAX_LINK_ROUND_TRIP_MS`, `resolveMaintenanceDeadlines`.
- Add `FretConfig.linkRoundTripMs` with its doc comment; validate in the constructor (positive, finite, ≤ ceiling); store as `number | undefined`.
- Add `FretService.deadlineFloors()` (reads the four statics plus `RPC_TIMEOUT_MS`) and the private `deadlines()`; switch every use site listed above, then grep that none remain.
- Pass `timeoutMs: this.deadlines().routeMs` at the three `sendMaybeAct` calls.
- Rewrite the affected doc comments and NOTEs (constants, `stabilizeOnce`, forward site, announce site); add the `SHUTDOWN_BUDGET_MS` and `closeBudgetMs` NOTE tripwires.
- Extend `stabilize-budget-invariants.spec.ts` (undeclared = floors, invariants at several declarations, R = 3 500 numbers, validation rows).
- Add the delayed-answer behaviour to `maintenance-rig.ts` and the two-arm reproduction spec.
- Update `docs/fret.md` (sections above) and the `dialTimeoutMs` doc comment.
- Run `npx tsc --noEmit` and `yarn test` from `packages/fret/`.
