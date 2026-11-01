description: FRET can now be told the round trip of its slowest link, and derives its deadlines for talking to a peer over an open connection (ping, snapshot fetch, stabilization tick, routed request) from it, never below today's values — so a slow relayed link no longer makes every ping miss and a connected peer look dead. Review the derivation, its wiring and the docs.
architecture: docs/fret.md#stabilization-and-churn-handling
files: packages/fret/src/service/maintenance-deadlines.ts (new), packages/fret/src/index.ts (FretConfig.linkRoundTripMs, dialTimeoutMs doc), packages/fret/src/service/fret-service.ts (requireLinkRoundTripMs, linkRoundTripMs field, deadlineFloors, deadlines, use sites), packages/fret/src/rpc/protocols.ts (RPC_TIMEOUT_MS doc, closeBudgetMs NOTE), packages/fret/src/rpc/maybe-act.ts (sendMaybeAct doc), packages/fret/test/stabilize-budget-invariants.spec.ts, packages/fret/test/link-round-trip-deadlines.spec.ts (new), packages/fret/test/maintenance-redial.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, docs/fret.md, AGENTS.md
----
# The declared link round trip sets FRET's maintenance deadlines — review handoff

Requested by Sereus (gotchoices/sereus#48). On a relayed link with a 3.5 s round trip a ping takes ~7 s; FRET's fixed 2 s ping budget timed out every time, booked contact strikes, and marked a connected peer `dead`, so Optimystic left it out of every cohort.

## What shipped

- **`FretConfig.linkRoundTripMs?: number`** — the round trip R of the slowest link between two nodes that talk, relayed hops included. Absent = today's behaviour exactly.
- **`src/service/maintenance-deadlines.ts`** (pure, store-free, clock-free): `MaintenanceDeadlines`, `PING_ROUND_TRIPS` 2, `SNAPSHOT_ROUND_TRIPS` 3, `ROUTE_HOPS` 2, `TICK_ROUND_TRIPS` 7, `MAX_LINK_ROUND_TRIP_MS = floor((2^31−1)/7)` ≈ 306 783 378, and `resolveMaintenanceDeadlines(R, floors)`:
  - ping `max(floor, 2R)`, snapshot `max(floor, 3R)`, phase 1 `max(floor, ping+snapshot)`, tick `max(floor, phase1+ping)`, route `max(floor, 2·2R)`.
  - `undefined` returns a copy of the floors. The two tick invariants hold by construction because phase 1 and the tick are composed from the *derived* ping and snapshot.
- **Service wiring** (`fret-service.ts`):
  - The four statics plus `RPC_TIMEOUT_MS` stay as they were. They are now the **floors**, read only by `FretService.deadlineFloors()`.
  - `private deadlines()` resolves the deadlines at every use (not once at construction), because the test rigs assign the statics after building the service.
  - Switched use sites:
    - `pingMs`: announce fan-out, warm-up ping, near ping (`probeNeighborLatency`), `probeMembership`.
    - `snapshotMs`: `fetchAndMergeSnapshot`.
    - `tickMs` / `phaseOneMs`: read once at the top of `stabilizeOnce`.
    - `routeMs`: passed explicitly as `timeoutMs` to the three `sendMaybeAct` calls (forward in `routeAct`, probe and activity resend in `iterativeLookup`).
  - Grep confirms no `FretService.MAINTENANCE_*` / `STABILIZE_*_BUDGET_MS` read remains outside `deadlineFloors()`.
- **Validation**: in the constructor via `requireLinkRoundTripMs`. Absent stays `undefined`, with no sentinel number. `0`, negatives, `NaN`, `Infinity` and anything above the ceiling throw naming `linkRoundTripMs`. The declaration is stored as its own `private readonly linkRoundTripMs: number | undefined`; the cfg type became `Required<Omit<FretConfig, 'privateKey' | 'linkRoundTripMs'>>`.
- **Deliberately not derived, with NOTE tripwires**:
  - `dialTimeoutMs`: explained in the doc comment.
  - `SHUTDOWN_BUDGET_MS` / `LEAVE_NOTICE_TIMEOUT_MS`: NOTE at `SHUTDOWN_BUDGET_MS`.
  - The inbound reply close budget: NOTE in `registerRpcHandler`.
  - Idle backoff and strike spacing.
- **Facade**: `libp2p-fret-service.ts:100` spreads the whole config into the core, so `fretService({ linkRoundTripMs })` works with no change (checked by reading the code).
- **Docs**: `docs/fret.md` was updated in these places:
  - The *Budget* and *Phase 1 sub-budget* bullets.
  - The invariant bullet under *Two phases*, rewritten to cover the derivation, the by-construction argument, the per-use resolution and the reproduction spec.
  - The detection-latency consequences in *Hard failure* and in the address-less-departure bullet.
  - The *Stream management* deadline paragraph: what follows the declaration and what does not (exported `RPC_TIMEOUT_MS` / `rpcRequest` / `readFramed` / `sendMaybeAct` defaults, leave budgets, close budget).
  - A new `linkRoundTripMs` bullet in *Configuration*.

  AGENTS.md layout lists the new module. A gitignored `.release-notes.pending.md` at the repo root carries the release note, including the Optimystic-facing point about `readFramed` defaults.

## Tests (all green: `npx tsc --noEmit`, `yarn test` → 1352 passing)

- `test/stabilize-budget-invariants.spec.ts`: extended; the existing cases are kept. Floors are captured at load time, before any rig can shrink them.
  - Undeclared deep-equals the floors.
  - At R ∈ {0.5, 250, 600, 1 000, 3 500, 30 000, `MAX_LINK_ROUND_TRIP_MS`}: every field is ≥ its floor, both tick invariants hold, and `tickMs ≤ 2^31−1`.
  - At R = 3 500 the exact numbers are 7 000 / 10 500 / 17 500 / 24 500 / 14 000, so a changed round-trip count shows up as a visible decision.
- `test/maintenance-redial.spec.ts`: a new validation row beside the `dialTimeoutMs` row. It checks the five bad values throw `/linkRoundTripMs/`, and that the ceiling itself and `0.5` are accepted and stored.
- `test/link-round-trip-deadlines.spec.ts` (new): the reproduction through the near pass, using a new `PeerRig.answerDelayMs` map in `maintenance-rig.ts` (a delayed stream open that rejects early on abort and clears its timer). The ping floor is shrunk to 100 ms and the peer answers after 250 ms.
  - Undeclared: one contact strike, `pingsFail` 1.
  - Declared at 150 ms (ping budget 300 ms): no strike, `pingsOk` 1.
  - Mutation check run during this implement: making `deadlines()` ignore the declaration reddens the declared arm.
- No wiring test for `routeMs` or the other ping/snapshot sites, per the ticket. Those were checked by grep and by reading the code.

## Things for the reviewer to look at

- **Delayed answer covers every stream open to the peer**, the snapshot fetch included. In the declared arm the snapshot budget stays at its 1 s floor (3 × 150 = 450 ms is below it), so the 250 ms delay fits. If someone lowers the snapshot floor in that spec, the fetch could time out without affecting the ping assertions.
- **Nested route budgets.** Each forwarding hop hands its downstream a full `routeMs`. This was already true with the flat 5 s; there is a NOTE at the forward site. Not fixed here.
- **`MAX_LINK_ROUND_TRIP_MS` is not re-exported from the package root** (`src/index.ts`). Optimystic validates against its own lower ceiling, so it does not need it. If a consumer ever wants it, add it to the root exports and to `test/package-exports.spec.ts`.
- **Route hop count 2 is a judgement, not a measurement.** The revisit condition is stated at `ROUTE_HOPS`.
- **`deadlines()` is called once per peer task**, not once per tick, at the ping and snapshot sites. That costs a few `Math.max` per call. It also means a rig assigning a static mid-tick would take effect mid-tick, which is intended. Only `stabilizeOnce` reads its two budgets once, to keep the phase-2 reserve consistent within a tick.
- The prior implement runs were interrupted twice (once by a network error, once by the idle timeout). Their source edits had already landed in commit `e06d089`. This run reviewed that diff, added the invariants and validation tests, wrote the docs and ran the full suite.

## After this lands

Release FRET. Optimystic's `fret-receives-the-link-round-trip` then passes `options.linkRoundTripMs` into `fretService({...})` in `libp2p-node-base.ts`, beside `dialTimeoutMs`.
