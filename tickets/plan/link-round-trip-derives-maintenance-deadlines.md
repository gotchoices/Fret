description: FRET's maintenance deadlines over an open connection are fixed constants (a ping or announce gets 2 s, a snapshot fetch 1 s, phase 1 of a tick 3 s, the tick 5 s, an RPC 5 s). On a relayed link with a 3 s round trip a ping takes about 6 s, so every ping misses, the peer collects contact strikes and is marked `dead` though its connection is up, and Optimystic leaves it out of every cohort. Add one optional `FretConfig.linkRoundTripMs` from which these budgets are derived as round-trip counts, never below today's constants.
files: packages/fret/src/index.ts (FretConfig), packages/fret/src/service/fret-service.ts (MAINTENANCE_RPC_TIMEOUT_MS ~501, MAINTENANCE_SNAPSHOT_TIMEOUT_MS, STABILIZE_PHASE_ONE_BUDGET_MS, STABILIZE_TICK_BUDGET_MS ~532, config resolution ~703), packages/fret/src/rpc/protocols.ts (RPC_TIMEOUT_MS ~27), packages/fret/test/stabilize-budget-invariants.spec.ts
----
# The declared link round trip sets FRET's maintenance deadlines

Requested by Sereus (`tickets/blocked/fret-maintenance-deadlines-below-the-declared-link.md` in that repo, GitHub gotchoices/sereus#48). Sereus declares the slowest link it supports as a round trip (`NetworkConfig.linkRoundTripMs`, 3 500 ms by default) and already passes it to Optimystic (`NodeOptions.linkRoundTripMs`), which derives its own deadlines from it (`resolveLinkDeadlines` in db-p2p `rpc-deadline.ts`). Optimystic already sets FRET's redial from it (`FretConfig.dialTimeoutMs`); the deadlines over an open connection are still fixed.

## The constants and what each needs

| constant | value | bounds | needs, as round trips |
| --- | --- | --- | --- |
| `MAINTENANCE_RPC_TIMEOUT_MS` | 2 000 ms | one ping or announce over an open connection | 2: protocol negotiation plus the echo |
| `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` | 1 000 ms | one neighbour-snapshot fetch | 2, plus the transfer of up to 64 KiB |
| `STABILIZE_PHASE_ONE_BUDGET_MS` | 3 000 ms | phase 1 of a tick (pings, then snapshot fetches) | at least one ping plus one snapshot |
| `STABILIZE_TICK_BUDGET_MS` | 5 000 ms | one stabilization tick | phase 1 plus one ping |
| `RPC_TIMEOUT_MS` | 5 000 ms | default whole-RPC budget, and `readFramed`'s default | 2 per hop |

A ping cut off by the tick budget is `cancelled` and records nothing, so the ping cannot be raised alone: `stabilize-budget-invariants.spec.ts` ties the three tick budgets together.

## Proposed shape (from the Sereus ticket)

- `FretConfig.linkRoundTripMs?: number`, validated like `dialTimeoutMs`.
- Given: each budget above is derived from it as the round-trip count in the table, never below today's constant, and the tick invariants hold at every declaration. The spec checks them at several declarations.
- Not given: every value is today's constant.
- One declaration, not one option per constant, because the constants are coupled by the invariants.

Rejected alternatives (see the Sereus ticket for reasons): an option per constant; raising `deadAfterFailures`; counting the embedder's traffic as proof of life (worth having separately, but not a deadline fix).

## Edge cases to settle in planning

- Whether derived per-instance budgets replace the `private static readonly` constants, and how `RPC_TIMEOUT_MS` (module-level in `rpc/protocols.ts`) reaches per-instance callers.
- The stabilization interval and idle backoff (`idle-backoff.ts`): a tick budget longer than the base interval must not overlap ticks.
- The dead-verdict grace (`store/tenure.ts`) is unaffected.

## After this lands

Release FRET, then Optimystic passes `options.linkRoundTripMs` into `fretService({...})` (Optimystic ticket `fret-receives-the-link-round-trip`).
