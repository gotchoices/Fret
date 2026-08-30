description: Peers reachable only through a relay — phones, browsers, laptops behind a home router — could call FRET but never be called, because FRET never told libp2p it was willing to answer over a relayed connection. One line at one registration site fixed it for all five protocols.
files:
  - packages/fret/src/rpc/protocols.ts (the fix — `handleOptions()` at ~147, used by `registerRpcHandler` at ~190)
  - packages/fret/test/rpc.relay-limited-connection.spec.ts (end-to-end over a real circuit relay)
  - packages/fret/test/rpc.handler-registration.spec.ts (stored registrar options + single-`handle`-site AST guard)
  - packages/fret/test/helpers/relay.ts (three-node relay topology helper)
  - packages/fret/test/rpc.stream-caps-profile.spec.ts (relay opt-in per profile and across start→stop→start)
  - packages/fret/package.json + yarn.lock (`@libp2p/circuit-relay-v2`, devDependency, pinned exactly)
  - docs/fret.md (*Stream management* — two bullets, one amended during review)
  - .release-notes.pending.md (untracked; consumed by the next `yarn release`)
----

# What shipped

`registerRpcHandler` builds its `node.handle` options through a private `handleOptions()`:

```ts
function handleOptions(caps: StreamCaps): StreamHandlerOptions {
	const options: StreamHandlerOptions = { runOnLimitedConnection: true };
	if (caps.maxInboundStreams !== undefined) options.maxInboundStreams = caps.maxInboundStreams;
	if (caps.maxOutboundStreams !== undefined) options.maxOutboundStreams = caps.maxOutboundStreams;
	return options;
}
```

Two defects closed at one site:

1. **`runOnLimitedConnection: true` as a constant.** libp2p will not run a protocol over a
   *limited* (circuit-relay) connection unless both ends opted in for that protocol, and the two
   ends are separate options objects. FRET's dialing side (`openRpcStream`) already opted in; the
   answering side did not. All five protocols register through this one seam, so the single missing
   property disabled inbound RPC for the whole set.
2. **Absent caps omitted rather than passed as `undefined`.** libp2p's registrar stores
   `{ maxInboundStreams: 32, maxOutboundStreams: 64, ...opts }`, so a key present with an
   `undefined` value replaced the default. Dormant for FRET's own five registrations; live for
   outside callers of the exported seam, whose `opts` defaults to `{}`.

`openRpcStream` was already correct and is untouched.

# Review findings

## Checked

- **The implement diff read first**, before the handoff summary: `src/rpc/protocols.ts`, all three
  new/changed test files, the relay helper, `docs/fret.md`, `package.json` / `yarn.lock`, and the
  release note.
- **The fix is correct and its tests bite — verified by re-running the mutations rather than
  trusting the handoff's table.** Flipping `runOnLimitedConnection` to `false` in `handleOptions`
  reddens exactly two arms (the relay positive case with `decode-error`, and the stored-options
  assertion), with the negative control still green; both mutations were reverted and the tree
  confirmed clean (`git diff` empty) before the suite run.
- **The dedupe claim behind the exact dependency pin was verified, not accepted.**
  `@libp2p/circuit-relay-v2@4.1.3` has no nested `node_modules/@libp2p/*` at all, and the tree
  holds exactly one `@libp2p/interface` (3.1.0) — no duplicate copy, so the `Stream.readableEnded`
  hazard the ticket names does not exist in this tree. It is a devDependency, so nothing reaches
  consumers.
- **The single-registration-site claim**, independently: `grep -rn "\.handle(" src/` returns one
  line, `src/rpc/protocols.ts:161`. The AST guard agrees.
- **Docs.** `docs/fret.md` was read at both touched bullets and at the surrounding *Stream
  management* / *Dialability* text; the two new bullets match the shipped code. The *Dialability*
  section's existing account of the sender-side `runOnLimitedConnection` is still accurate.
- **Full gate.** `npx tsc --noEmit` clean; `yarn check` from the repo root — typecheck, build, and
  the whole suite — **1290 passing, 0 failing, ~5 min**. The `message-bus` *clustered placement*
  timeout the implement stage reported as pre-existing is **gone**: the triage pass (`9512f0f`,
  digitree-store key caching) fixed the root cause, so nothing is skipped, disabled or outstanding.
  There is no lint step in this repo by design (`AGENTS.md`: no prettier config; `yarn check` is
  the gate).

## Found and fixed in this pass (minor)

- **The relay spec's stated coverage gap was wrong, and it understated the tests.** Its header
  claimed the rig "deliberately does not exercise FRET's *sender* opt-in" and that no case would
  notice if `openRpcStream` lost its own `runOnLimitedConnection`. Measured: flipping that flag to
  `false` reddens the positive case (`unreachable` — libp2p refuses at the dial). Both ends are
  covered, jointly: the positive case fails if *either* side loses its opt-in, and the outcome kind
  discriminates which (`unreachable` = dialer, `decode-error` = listener); the negative control is
  what attributes a green run to the receive side. Comment corrected, the third mutation added to
  its recorded list, and the `docs/fret.md` bullet amended to state the joint coverage — a comment
  claiming something is untested is what stops the next person from relying on it.
- **`createRelayTopology` leaked live nodes when setup failed partway.** It creates three nodes,
  a reservation and two dials; a throw anywhere after the first `createLibp2p` left the standing
  nodes running, and the spec's `after` hook has no topology object to hand `stopAll` — so the
  mocha exit watchdog would have failed the run on open handles and buried the actual setup error.
  Now the node list is built incrementally and a `catch` stops it before rethrowing. The dial/reserve
  sequence moved into `connectThroughRelay` so the try/catch stays short.
- **The AST guard's file-path regex used `String.replace`, which escapes only the first `.`.**
  Harmless for `rpc/protocols.ts` (one dot), silently loose the moment the seam is renamed or moved
  — an unescaped `.` matches any character. Now `replaceAll`.

## Tripwires (recorded, not filed)

- **The exact pin on `@libp2p/circuit-relay-v2`.** Fine now — 4.1.3 dedupes completely against
  libp2p 3.1.3 — and only a problem *if* the libp2p stack is bumped, at which point nothing in the
  repo moves the pin for you. Parked as a `NOTE:` at the dependency's only consumer,
  `packages/fret/test/helpers/relay.ts`, naming the failure mode (a stale pin surfaces as a
  `tsc --noEmit` type error) and the reason 4.1.3 specifically. Not a ticket: the alternative the
  handoff names — refreshing the whole `@libp2p/*` graph so the relay can float — is a
  lockfile-wide blast radius far past this bug fix, and it is a decision to take when someone is
  already bumping libp2p, with the note in front of them.
- The residual gaps the handoff states honestly — the negative control asserts `kind !== 'ok'`
  rather than a specific outcome (pinning it would pin libp2p's teardown shape, the same residual
  `test/rpc.stream-caps.spec.ts` already records); one relay implementation over one transport; the
  AST guard matching `.handle` by property name only, so an alias or `node['handle']` slips past —
  are each already recorded at their own site in the spec comments. Re-read and left as they stand;
  no new note adds anything.
- `registerJsonHandler`'s cap fields remaining compile-time-only is a pre-existing `NOTE:` in
  `test/rpc.stream-caps-profile.spec.ts`; this change neither closed nor worsened it.

## Not found

- **No major findings — nothing was escalated and no new ticket was filed.** The reason, stated
  rather than implied: the change is one seam, one property, and two conditional key assignments,
  with no new state, no new lifetime, no new failure path, and no allocation on any hot path — it
  is at the top rung of the architecture ladder already (the invariant "every protocol inherits
  relay support" lives at the single registration site, and the AST guard is the boundary check
  that keeps it there), so there is no higher-rung ticket to file and no instance-level one worth
  filing.
- **No accepted-tradeoff `NOTE:` was overturned.** The sites this change touches were read for
  them; none applies.
- **No test-shape objections beyond the ones fixed above.** Happy path, the negative control, the
  registrar-stored shape, both profiles, the start→stop→start cycle, and the structural guard are
  all present; error paths on this seam belong to `registerRpcHandler`'s existing fuzz specs, which
  the change does not alter.

## Noted, out of scope

- `packages/fret/tickets/.logs/` exists as an **empty** untracked directory tree — litter from some
  earlier run that `tee`'d a log from inside `packages/fret` rather than the repo root. It holds no
  files and git cannot see it. Left in place (not this ticket's to remove); mentioned so the next
  person does not read it as a second ticket board.

# Release

`.release-notes.pending.md` (untracked, repo root) states both fixes and that downstream consumers
resolve `p2p-fret` from npm and therefore need a published release before they see this — the
Optimystic-side half of the fix is not useful without it.
