----
description: The correct libp2p stream-open helper exists inside FRET but no import path reaches it, so the one downstream consumer has hand-copied it three times and one copy is wrong.
files: packages/fret/src/index.ts, packages/fret/src/rpc/protocols.ts, packages/fret/package.json
difficulty: easy
repro: static
severity: wrong-result
likelihood: normal-use
tradeoffs: Exporting an internal seam is an API commitment — `openRpcStream` takes a `Libp2p` node and returns a `Stream | undefined`, so its signature is now something FRET has to keep stable across releases. A maintainer could instead tell the consumer to keep its own copy, which is what happens today; the cost of that choice is already visible downstream as three divergent copies, one of them broken.
----
## What is missing

`openRpcStream` (`src/rpc/protocols.ts:277`) is the one place FRET opens an outbound protocol
stream, and it gets three things right that a hand-written dial routinely forgets:

- filters `node.getConnections(pid)` to genuinely open connections with a usable `newStream`
- prefers a direct connection and falls back to a limited (relayed) one only when it is the only
  open path — the steady state for browsers and NATed peers
- sets both `runOnLimitedConnection: true` and `negotiateFully: false`

The root entry (`src/index.ts:145`) re-exports `validateTimestamp` and `readAllBounded` from that
same module but **not** `openRpcStream`, and `package.json` `exports` exposes only the root entry —
so there is no import path to it, deep or otherwise.

## Why it matters now

`../optimystic` consumes `p2p-fret` (root `package.json` uses `portal:../Fret/packages/fret`;
`packages/substrate-simulator` pins `^0.6.0`). Its ticket
`tickets/backlog/debt-shared-limited-connection-dial-options.md` records the consequence: because
the helper is unreachable, that repo carries **three hand-written copies** of the same connection
selection — `libp2p-key-network.ts#connect` (correct), `cohort-topic/stream-util.ts#openStream`
(corrected during review; had been missing the open-status filter *and* the direct-connection
preference on top of the flag), and a broken inline lambda at `libp2p-node-base.ts:1041` that omits
the relay flag entirely and silently drops its `AbortOptions`. The user-visible symptom of the
broken copy is that a relay-only peer holding a block "just never answers" during restoration.

That ticket names exporting this helper as its preferred fix — "smallest diff by far, but gated on
a dependency release." This is that gate.

## Expected outcome

`openRpcStream` is exported from the package root alongside the other `rpc/protocols` re-exports,
with whatever types its signature needs (`Stream` is a libp2p type, already a peer dependency).
The existing internal call sites are untouched — this is purely additive, no behavior change, and
nothing in FRET's own code should start importing it through the root entry.

Confirm the export is reachable from a consumer's perspective, not merely present in the source:
the `exports` map must resolve it, and a type-level check that the symbol is importable from
`'p2p-fret'` belongs with the other public-surface assertions.

## Non-goals

Fixing the downstream copies. That is optimystic's ticket, and it unblocks the moment this ships.
