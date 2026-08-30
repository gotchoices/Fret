description: Peers that can only be reached through a relay — phones, browsers, laptops behind a home router — can call FRET but cannot be called. Every FRET protocol refuses incoming traffic over a relayed connection, so such a peer stays effectively unroutable even though it looks connected. One registration site is responsible for all five protocols.
prereq:
files:
  - packages/fret/src/rpc/protocols.ts (registerRpcHandler:122; node.handle:129; the options object:154 — the defect. openRpcStream:719 — the calling side, which is already correct)
  - packages/fret/src/service/fret-service.ts (registerRpcHandlers:1265 — where all five protocols register; streamCaps:2079)
  - packages/fret/src/index.ts (line 170 — registerRpcHandler is public API)
  - packages/fret/test/ (a guard test belongs here; see "Tests")
difficulty: low
repro: verified by source inspection in both this repo and libp2p's
severity: wrong-result
likelihood: normal-use
tradeoffs: A deployment whose relays impose no limits is unaffected, because libp2p only gates connections it has marked limited. Optimystic's own `reference-peer` lifts those caps, so that particular topology is dormant today — but libp2p's own default is to impose them, so any stock or third-party relay hits this.
----

# FRET answers "no" to relayed calls it is happy to place

## What is wrong

Some peers cannot accept incoming network connections and are reached through a **relay**: a
publicly-reachable machine that passes traffic on their behalf. libp2p marks such a connection
*limited*, and will not carry a protocol conversation over one unless **both** ends have opted in
for that protocol. The two sides are separate options objects and both are checked.

FRET opts in when it calls out, and not when it answers:

| direction | site | opts in? |
| --- | --- | --- |
| calling out | `protocols.ts:719` (`openRpcStream`) | **yes** — `runOnLimitedConnection: true`, with a comment at `:682` stating it is required for the relayed path |
| answering | `protocols.ts:154` (the options passed to `node.handle` at `:129`) | **no** — the object passes only the two stream caps |

`registerRpcHandler` is the single seam every FRET protocol registers through
(`fret-service.ts:1265` registers all five: `neighbors`, `neighbors/announce`, `maybeAct`, `leave`,
`ping`), so one missing property disables inbound RPC for the entire protocol set at once.

## Why it matters beyond FRET

These are the ring-maintenance and routing calls — they are how a peer is *found*. A relay-only
peer that cannot serve them is unroutable regardless of what else works. Optimystic
(`@optimystic/db-p2p`) just fixed exactly this bug on its own thirteen protocol registrations and
discovered FRET has it too: with only Optimystic fixed, a relay-only peer can answer every
Optimystic protocol and still never be located, because the FRET lookup that would find it cannot
complete. So this ticket is the second half of a fix that is not useful without it.

Optimystic tracks the dependency at `tickets/blocked/fret-inbound-rpc-refused-on-relay-connections.md`
in that repo. Note that published Optimystic consumers resolve `p2p-fret ^1.0.0-beta.2` from npm
rather than a local portal, so this needs a FRET release to reach anyone.

## How it was confirmed

Read in libp2p's own source, not inferred:

- `libp2p/dist/src/connection.js:170` — the **inbound** path reads back
  `registrar.getHandler(protocol).options.runOnLimitedConnection` and throws `LimitedConnectionError`
  when it is not `true`. Line 80 is the separate outbound check.
- `libp2p/dist/src/registrar.js` `handle()` — stored options are
  `{ maxInboundStreams: DEFAULT, maxOutboundStreams: DEFAULT, ...opts }`.

## A second defect on the same line

That spread has a consequence the current code walks into. `registerRpcHandler` builds its options
object with both cap keys **always present**:

```ts
{ maxInboundStreams: opts.maxInboundStreams, maxOutboundStreams: opts.maxOutboundStreams }
```

When a caller supplies no caps, those are `undefined` — and `...opts` spreads them *over* libp2p's
defaults, replacing 32/64 with `undefined` rather than leaving the defaults in place.

This is dormant for FRET's own five registrations, because `streamCaps()` (`fret-service.ts:2079`)
always returns real numbers on both profiles. It is **not** dormant for outside callers:
`registerRpcHandler` is exported as public API (`index.ts:170`) and its `opts` parameter defaults to
`{}`. Fix it in the same pass — build the options object by omitting absent keys rather than passing
them as `undefined`.

## The fix

1. Add `runOnLimitedConnection: true` to the options `registerRpcHandler` passes to `node.handle`.
   Bake it in as a **constant, not a parameter**, so a protocol added later gets relay support
   without its author knowing the setting exists. There is no case where FRET wants to refuse
   relayed traffic for one protocol and accept it for another.
2. Construct the options object so absent caps are **omitted rather than passed as `undefined`**,
   per the section above.
3. Leave `openRpcStream` alone — it is already correct.

## Edge cases & interactions

- **`stop()` → `start()` cycles.** `registerRpcHandlers` unhandles and re-registers all five
  protocols; the comment at `:1265` records that caps are applied here rather than at construction
  for exactly this reason. A constant baked into the seam survives the cycle by construction, but
  confirm the re-registration path carries it.
- **Both profiles.** `streamCaps()` returns different numbers for `core` and `edge`. The opt-in must
  not become profile-conditional while passing through the caps plumbing.
- **`maybeAct` is deliberately asymmetric.** It stays on `registerRpcHandler` while the other four
  moved to `registerJsonHandler` (`fret-service.ts:1286` explains why, and says not to unify it).
  Both paths bottom out at `registerRpcHandler`, so fixing the seam covers both — verify that rather
  than assuming it, and do not "tidy" the asymmetry.
- **Duplicate registration.** `registrar.handle` throws `DuplicateProtocolHandlerError` unless
  `force` is set; nothing here should start passing `force`.

## Tests

- **The negative control is what makes this real.** Build a relay that applies default limits, put a
  FRET node behind it, and assert an inbound RPC over the limited connection reaches the handler.
  Then assert that a handler registered *without* the opt-in never does — otherwise a green test
  proves nothing, because it would also pass if the transport were not actually limited.
- **Mutation-test both directions** before calling it done: flipping the constant to `false` must
  redden the positive case, and adding the opt-in to the bare control must redden the control. A
  test that stays green under the first mutation is measuring something else.
- A cap-defaults case: register through the seam with no caps and assert the stored handler options
  still carry libp2p's 32/64 rather than `undefined`.
- Consider a structural guard — Optimystic added an AST walk asserting `.handle(` appears in exactly
  one place — if FRET wants the same protection against a future direct registration.

## TODO

- [ ] Add `runOnLimitedConnection: true` as a constant in `registerRpcHandler`'s handle options
- [ ] Omit absent stream caps instead of passing `undefined`
- [ ] Relay integration test: positive case + bare-registration negative control
- [ ] Mutation-test both arms and record the results in the review handoff
- [ ] Cap-defaults regression test for the public `registerRpcHandler` entry point
- [ ] Note in the release notes that this needs a published version before downstreams see it
