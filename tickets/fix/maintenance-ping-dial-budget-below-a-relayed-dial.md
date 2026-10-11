description: A maintenance ping that has to open a connection is bounded by the 2 s maintenance budget, which a relayed dial on a slow link cannot meet, so FRET never reconnects such a peer. Two phones that restart on a slow relayed link may never find each other again.
files: packages/fret/src/service/fret-service.ts (MAINTENANCE_RPC_TIMEOUT_MS ~339; sendPing call sites ~1686, ~1764, ~2592, ~2812), docs/fret.md
repro: verified (in the sereus workspace)
difficulty: medium
----
Reported from sereus (`p2p-fret` 1.0.2). Sereus ticket: `tickets/blocked/fret-maintenance-ping-dial-budget-below-a-relayed-dial`. Sereus paths are relative to the sereus workspace.

## The finding

`FretService` pings a peer with `dial: true` and `timeoutMs: MAINTENANCE_RPC_TIMEOUT_MS` (2000 ms) — a budget for the whole call, opening the connection included. The constant's comment reasons about a ping on an open connection ("a ~50-byte round trip"); it does not cover the dial. On a strand whose members reach each other only through a relay, after a restart these pings are the only thing that redials a peer (Sereus's side of that is `implement/strand-peers-redial-on-the-declared-link-budget`), and a relayed dial on a slow link takes longer than 2 s, so the connection is never re-established.

Evidence (Sereus scratch arm of `joiner-first-commit-over-slow-relay.integration.ts`, 20 ms per-frame cap, event loop 70% busy, `DEBUG=libp2p:connection-manager:dial-queue*`): after the joiner restarted, both strand nodes dialed each other 32 times over 180 s; every attempt was aborted 2.05 s after it started, almost all as `EncryptionFailedError: This operation was aborted` (the Noise handshake over the circuit). The one successful relayed connection in that run took about 9 s to open. Sereus declares a 3.5 s link round trip by default and budgets a relayed dial at 21.5 s (`relayedDialBudgetMs`); libp2p's own per-address limit, which Sereus sets through Optimystic, is 39 s.

## Proposed change

"A maintenance ping that has to OPEN a connection is bounded by the 2 s maintenance budget, which a relayed dial on a slow link cannot meet, so FRET never reconnects such a peer. Split the budget: keep 2 s for the exchange on an open connection, and bound the dial by a host-supplied dial budget (a `dialTimeoutMs` option, defaulting to today's behaviour), or skip the dial in maintenance (`dial: 'never'`) and leave reconnection to a path with a link-sized budget."

Alternatives considered: raising the constant outright (rejected: a long ping holds a stabilization tick open, which the constant's comment rightly guards against); doing nothing upstream (Sereus's redial supervisor then remains the only reconnection path, which works but duplicates what FRET is for).

## Reproduce

In sereus: the slow-restart arm of `packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts` (20 ms per-frame cap, 70% busy event loop) with `DEBUG=libp2p:connection-manager:dial-queue*`; every reconnect dial aborts at ~2.05 s. A FRET-local test: two nodes reachable only through a circuit relay with injected per-frame latency so a dial takes >2 s; after one restarts, expect the other to reconnect it within the dial budget.
