description: FRET can now be told the round trip of its slowest link, and derives its deadlines for talking to a peer over an open connection (ping, snapshot fetch, stabilization tick, routed request) from it, never below today's values — so a slow relayed link no longer makes every ping miss and a connected peer look dead.
architecture: docs/fret.md#stabilization-and-churn-handling
files: packages/fret/src/service/maintenance-deadlines.ts, packages/fret/src/index.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/test/stabilize-budget-invariants.spec.ts, packages/fret/test/link-round-trip-deadlines.spec.ts, packages/fret/test/maintenance-redial.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, docs/fret.md, AGENTS.md
----
# The declared link round trip sets FRET's maintenance deadlines — complete

Requested by Sereus (gotchoices/sereus#48): on a relayed link with a 3.5 s round trip a ping takes ~7 s, FRET's fixed 2 s ping budget timed out every time, and a connected peer was marked `dead`.

## What shipped

- `FretConfig.linkRoundTripMs?: number` — round trip R of the slowest link, relayed hops included. Absent = previous behaviour exactly. Validated in the constructor (positive, finite, ≤ `MAX_LINK_ROUND_TRIP_MS` = floor((2^31−1)/7) ≈ 306 783 378); stored beside `cfg`, not as a sentinel.
- `src/service/maintenance-deadlines.ts` (pure): `resolveMaintenanceDeadlines(R, floors)` — ping `max(floor, 2R)`, snapshot `max(floor, 3R)`, phase 1 `max(floor, ping+snapshot)`, tick `max(floor, phase1+ping)`, route `max(floor, 4R)`. Both tick invariants hold by construction.
- `FretService.deadlineFloors()` is the only reader of the four maintenance statics plus `RPC_TIMEOUT_MS`; `deadlines()` resolves at each use. Every service RPC site (announce, warm-up ping, near ping, membership probe, snapshot fetch, three `sendMaybeAct` calls) and the tick/phase-1 deadlines read it.
- Deliberately not derived (NOTE tripwires at their sites): `dialTimeoutMs`, leave fan-out budgets, inbound reply close budget, idle backoff, strike spacing.
- Docs: `docs/fret.md` (budget bullets, invariant bullet, detection latency, stream-management deadlines, Configuration), AGENTS.md layout, gitignored `.release-notes.pending.md`.

Commits: `ticket(implement): link-round-trip-derives-maintenance-deadlines` (tests, docs) on top of source edits that landed in the interrupted run's commit (`tess: agent error on link-round-trip-derives-maintenance-deadlines — added resume note`).

## After this lands

Release FRET; Optimystic's `fret-receives-the-link-round-trip` then passes `options.linkRoundTripMs` into `fretService({...})` beside `dialTimeoutMs`.

## Review findings

Read both commits' diffs before the handoff. `npx tsc --noEmit` clean; `yarn test` 1352 passing after the review edits.

- **Correctness of the derivation** — checked the arithmetic against the documented numbers (R = 3 500 → 7 000 / 10 500 / 17 500 / 24 500 / 14 000; R = 600 → 2 000 / 1 800 / 3 800 / 5 800 / 5 000) and the ceiling (7R ≤ 2^31−1 at `MAX_LINK_ROUND_TRIP_MS`; floors cannot push past it at that magnitude). No defect.
- **Wiring completeness** — grepped `fret-service.ts` for every `sendPing` / `fetchNeighbors` / `announceNeighbors` / `sendMaybeAct` / `deadline(` call: all open-connection sites take `this.deadlines()`; the remaining raw budgets are the leave fan-out (`SHUTDOWN_BUDGET_MS`, `LEAVE_NOTICE_TIMEOUT_MS`) and the redial (`dialTimeoutMs`), both intentionally undeclared-independent with NOTEs. No other `src/service` module issues RPCs. Facade (`libp2p-fret-service.ts` `ensure()`) spreads the whole config, so `fretService({ linkRoundTripMs })` reaches the core.
- **Tick consistency** — `stabilizeOnce` reads `tickMs` and `phaseOneMs` from one resolution, so the phase-2 reserve can't be split across two rig states. Per-task resolution at ping/snapshot sites is intended (rigs assign statics after construction). OK.
- **Error handling / validation** — constructor rejects 0, negatives, NaN, ±Infinity, above-ceiling; error names the field. OK.
- **Resource cleanup** — the rig's new `delayUnlessAborted` clears its timer and listener on both arms; no watchdog leaks in the full run.
- **Tests** — kept the invariants block (cheap, pins the by-construction claim and the stated numbers), the validation row (mirrors the `dialTimeoutMs` row), and the reproduction spec (one wiring test; implementer's mutation check reddened it). Fixed inline: the reproduction's declared arm ran a 250 ms answer against a 300 ms budget — a 50 ms margin on a Windows timer granularity of ~15 ms plus scheduling; raised the declaration to 200 ms (400 ms budget; snapshot 600 ms still under its 1 s floor, so the ping remains the only differing budget). Also reworded the spec header, which pointed at "the grep rule in the ticket" (an archived file), to state the actual mechanism. `docs/fret.md` updated to the new value.
- **Docs** — read every `docs/fret.md` passage the ticket lists plus the Configuration bullet; they match the code. README has no config reference to update.
- **Tripwires noted (already parked by implement, not re-filed)**: nested route budgets don't shrink per hop (NOTE at the forward site in `routeAct`); `ROUTE_HOPS` = 2 is a judgement (NOTE in `maintenance-deadlines.ts`); leave notices dialing inside 1.5 s on slow links (NOTE at `SHUTDOWN_BUDGET_MS`); reply close budget (NOTE in `registerRpcHandler`); announce dial inside `pingMs` (NOTE in `sendAnnouncementsRateLimited`).
- **`MAX_LINK_ROUND_TRIP_MS` not exported from the package root** — no current consumer needs it; conditional, left as stated in the release note. No ticket.
- **Major findings / new tickets** — none: no defect found that serves a current anchor or names a class-level invariant beyond what the by-construction derivation already retires.
- **Source hygiene** — `fret-service.ts` keeps growing (~4 700 lines) but this change added only small members; the derivation was correctly extracted to its own module. No narrated-statement comments introduced.
