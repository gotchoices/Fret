description: Peers reachable only through a relay — phones, browsers, laptops behind a home router — could call FRET but never be called, because FRET never told libp2p it was willing to answer over a relayed connection. One line at one registration site fixed it for all five protocols.
prereq:
files:
  - packages/fret/src/rpc/protocols.ts (the fix — new `handleOptions()` at ~147, used by `registerRpcHandler` at ~190)
  - packages/fret/test/rpc.relay-limited-connection.spec.ts (new — end-to-end over a real circuit relay)
  - packages/fret/test/rpc.handler-registration.spec.ts (new — stored registrar options + single-`handle`-site AST guard)
  - packages/fret/test/helpers/relay.ts (new — three-node relay topology helper)
  - packages/fret/test/rpc.stream-caps-profile.spec.ts (extended — relay opt-in per profile and across start→stop→start)
  - packages/fret/package.json + yarn.lock (new devDependency, pinned exactly — see "The one judgement call")
  - docs/fret.md (two new bullets under *Stream management*)
  - .release-notes.pending.md (new, untracked — consumed by the next `yarn release`)
difficulty: easy
----

# What changed

`registerRpcHandler` builds its `node.handle` options through a new private `handleOptions()`:

```ts
function handleOptions(caps: StreamCaps): StreamHandlerOptions {
	const options: StreamHandlerOptions = { runOnLimitedConnection: true };
	if (caps.maxInboundStreams !== undefined) options.maxInboundStreams = caps.maxInboundStreams;
	if (caps.maxOutboundStreams !== undefined) options.maxOutboundStreams = caps.maxOutboundStreams;
	return options;
}
```

Two defects closed at once, exactly as the implement ticket specified:

1. **`runOnLimitedConnection: true`, as a constant.** libp2p refuses to run a protocol over a
   *limited* (circuit-relay) connection unless both ends opted in for that protocol, and the two
   ends are separate options objects. FRET's dialing side (`openRpcStream`) already opted in; the
   answering side did not. All five protocols register through this one seam, so the single
   property disabled inbound RPC for the whole set. It is not a parameter — there is no case where
   FRET wants relayed traffic on one protocol and not another.
2. **Absent caps are omitted rather than passed as `undefined`.** libp2p's registrar stores
   `{ maxInboundStreams: 32, maxOutboundStreams: 64, ...opts }`, so a key present with an
   `undefined` value replaced the default instead of falling through to it. Dormant for FRET's own
   five registrations; live for outside callers of the exported seam, whose `opts` defaults to `{}`.

`openRpcStream` untouched — it was already correct.

# How to validate

```
cd packages/fret
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/rpc.relay-limited-connection.spec.ts" --timeout 90000
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/rpc.handler-registration.spec.ts" --timeout 60000
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/rpc.stream-caps-profile.spec.ts" --timeout 60000
```

## Use cases the tests cover

- **A relay-only peer answers an inbound RPC** (`rpc.relay-limited-connection`). Three real libp2p
  nodes: a relay running `circuitRelayServer()` at libp2p's *stock default limits* (2 min, 128 KiB
  — not lifted, because a deployment whose relays impose no limits never meets this bug), a
  listener that reserves through it and is reachable only at `/p2p-circuit`, and a dialer that
  reaches the listener over that circuit. A protocol registered through the seam is reached and
  answers.
- **The negative control**, on the same connection with the same sender: a protocol registered with
  a bare `listener.handle(...)` — no opt-in — is refused, and its handler never runs. Without this
  the positive case would also pass on a connection that had quietly stopped being relayed.
- **The connection is really limited**, asserted by reading `connection.limits.bytes` /
  `.seconds` — the exact field libp2p's inbound gate tests. Note those arrive as *non-enumerable
  getters*, so a `deep.equal` against `{}` would have passed vacuously; the spec reads the fields.
- **The stored registrar options** (`rpc.handler-registration`): registering with no caps leaves
  libp2p's 32 / 64 in place and carries `runOnLimitedConnection: true`; registering with one cap
  forwards it and still defaults the other. Read off `components.registrar.getHandler(p).options` —
  a spy on `node.handle` cannot see what the registrar's spread produced.
- **Exactly one `node.handle` call site in `src/`** (`rpc.handler-registration`), found by a
  TypeScript AST walk rather than a text match (`.handle(` also appears in prose and in
  `unhandle`). A second site is a second place that must remember the opt-in.
- **Per-profile and across a lifecycle cycle** (`rpc.stream-caps-profile`, extended): the opt-in is
  asserted for all five protocols on both Core and Edge, and after `start → stop → start`, which
  are the two edge cases the implement ticket named. Its external-caller case now asserts the cap
  keys are **absent** via `Object.hasOwn` — `=== undefined` could not tell absence from an
  undefined value, which is the whole distinction defect (2) turns on.

## Mutation results (run, not assumed)

| mutation | expected | observed |
| --- | --- | --- |
| `runOnLimitedConnection: true` → `false` in `handleOptions` | positive case reddens | reddens (`decode-error`, not `ok`); control stays green |
| add `runOnLimitedConnection: true` to the bare control's `node.handle` | control reddens | reddens; positive case stays green |
| `handleOptions` returns both cap keys unconditionally (the old shape) | cap-defaults cases redden | both redden (`expected undefined to equal 32` / `64`); relay + AST cases stay green |

Each mutation reddens exactly the arm it should and no other. Both mutations were reverted and the
suites re-run green.

# The one judgement call a reviewer should weigh

**`@libp2p/circuit-relay-v2` is pinned to an exact version, `4.1.3`, not a range.** A real relay is
the only way to obtain a limited connection — the gate lives inside libp2p's own `Connection`,
reading options the registrar stored, so a stub would be testing our own mock. But this repo's
lockfile is frozen at `@libp2p/interface@3.1.0` / `@libp2p/interface-internal@3.0.10`, and every
newer relay release requires newer ones. A duplicate `@libp2p/interface` in the tree is not merely a
compile-time nuisance: 3.3.0 adds a required `readableEnded` to `Stream`, so a relay compiled
against it could read a field libp2p 3.1.3's streams do not have. 4.1.3 is the newest release whose
whole transitive `@libp2p/*` set matches what libp2p 3.1.3 already pulls, so it dedupes completely
(no nested `@libp2p/*` at all) and `tsc --noEmit` is clean.

The cost: the pin has to move by hand whenever the libp2p stack is bumped, and there is nothing in
the repo that will tell you — a stale pin will fail as a type error, loudly, but only when someone
next bumps libp2p. **A reviewer may reasonably prefer the alternative** (refresh the whole `@libp2p/*`
graph to current-within-declared-ranges so the relay can float), which was deliberately not done
here because a lockfile-wide libp2p bump is a much larger blast radius than this bug fix warrants.
It is a real tradeoff, not an oversight.

# Known gaps — stated, not papered over

- **The relay rig covers the inbound gate only.** Both arms dial through `openRpcStream`, which
  already opts in, so the sender side is held constant by construction. That is deliberate (the
  sender was never broken) but it does mean no case here would notice if `openRpcStream` lost its
  own opt-in. `docs/fret.md` claims it as required; nothing tests it.
- **The negative control asserts `kind !== 'ok'`, not a specific outcome.** libp2p aborts the muxed
  stream at the listener and the refusal reason does not travel, so the sender books a
  transport-shaped failure. Pinning the exact kind would pin libp2p's teardown shape rather than
  ours — the same residual `test/rpc.stream-caps.spec.ts` records for the inbound-cap case. Someone
  may reasonably want it pinned anyway, with a note, so a change in teardown shape is visible.
- **Only one relay implementation, one transport, one muxer** (circuit-relay-v2 over TCP + noise +
  yamux). The `rpc.stream-caps` specs run their claims over two transports; this one does not.
- **The AST guard checks `.handle` by property name only.** A registration reached through a
  differently-named alias (`const h = node.handle; h(...)`, a destructure, a dynamic
  `node['handle']`) would not be seen. That is a deliberate stop short of dataflow analysis; the
  guard is a tripwire against the ordinary mistake, not a proof.
- **`registerJsonHandler`'s cap fields are still only covered at compile time** — a pre-existing
  `NOTE:` in `rpc.stream-caps-profile.spec.ts` that this change did not close.

# Test-suite state

`yarn check` (typecheck + build + test) from the repo root: typecheck clean, build clean,
**1289 passing, 1 failing** in ~14 min.

The one failure is `test/message-bus.spec.ts` → *Placement distributions* →
`clustered placement: inter-cluster routing takes more hops`, a 300 s timeout. It is **pre-existing
and unreachable from this diff** — that spec imports the deterministic simulation harness only, no
libp2p and no RPC registration — and it **passes in isolation at 238.5 s against its own 300 s
timeout**, i.e. it has ~20% headroom and loses it under whole-suite load. Written up in
`tickets/.pre-existing-error.md` for the triage pass. Nothing was skipped, disabled or loosened.

# Release note

`.release-notes.pending.md` is written at the repo root (untracked; the release flow consumes it).
It states both fixes and, per the implement ticket, that **downstream consumers resolve `p2p-fret`
from npm and therefore need a published release before they see this** — Optimystic's own half of
the fix is not useful without it.
