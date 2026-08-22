---
description: When our own node refuses to open a network stream because it hit its own ceiling, we currently blame the peer we were talking to and eventually mark that healthy peer as dead. Give that case its own name so it scores nothing against the peer.
files: packages/fret/src/rpc/outcome.ts, packages/fret/src/rpc/request.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.request.spec.ts, docs/fret.md
difficulty: medium
---

Split out of the original `inbound-stream-caps-unimplemented` ticket (see the sibling
`stream-caps-plumbing`, which depends on this one). This half is the **latent defect**; the sibling
is the change that makes it live. Ordered this way deliberately: the caps must never land without
this fix, so this lands first.

## What is wrong today

`rpcRequest`'s `classify` (`packages/fret/src/rpc/request.ts`) has no arm for libp2p's stream-cap
errors, so both fall through to `{ kind: 'unreachable' }`. `noteRpcFailure`
(`packages/fret/src/service/fret-service.ts`, ~line 873) books `unreachable` as a **contact strike**
via `applyContactFailure`, and `deadAfterFailures` (3) then marks the peer `dead` — removing it from
every ring view.

**Our own outbound cap firing is not evidence about the peer at all.** libp2p throws
`TooManyOutboundProtocolStreamsError` out of `newStream` — i.e. out of FRET's own `openRpcStream` —
on a dial to a peer that is perfectly healthy. It is the same class as a tick-budget expiry (see
*Stabilization and churn handling* in `docs/fret.md`): our local ceiling, not the remote's state. It
must score **nothing** — no contact strike, no relevance decay, no backoff.

Reachable today at libp2p's own defaults (32 inbound / 64 outbound per protocol per connection);
the sibling ticket does not create the defect, it only widens the profile split around it.

## Design

Both error identities are stable and matchable by `name`, in the same style as
`isFrameTruncationError` / `isPayloadTooLargeError`
(`node_modules/@libp2p/interface/dist/src/errors.js:300-316`):

```
TooManyInboundProtocolStreamsError.name  === 'TooManyInboundProtocolStreamsError'
TooManyOutboundProtocolStreamsError.name === 'TooManyOutboundProtocolStreamsError'
```

Add a predicate beside the existing two (`isStreamLimitError`, or a matching pair) and a new
`RpcOutcome` variant in `packages/fret/src/rpc/outcome.ts`:

```ts
/**
 * Our own per-connection stream cap refused to open the stream — `TooMany{In,Out}bound
 * ProtocolStreamsError`, raised locally before anything reached the wire. **Not evidence about
 * the peer**: no contact strike, no relevance decay, no backoff — the same class as a tick-budget
 * expiry. Distinct from `skipped`, which means the dial *mode* forbade dialing; this one means we
 * were willing and our own ceiling refused, and that distinction is the diagnostic.
 */
| { kind: 'local-limit'; error: Error }
```

Adding a variant is public-surface growth and was weighed against reusing `skipped`. `skipped` is
documented as "nothing was attempted: the dial mode forbade dialing and no connection existed", and
callers already read it for the `snapshotsFetched` distinction; folding a ceiling hit into it erases
the fact that the ceiling fired — and at the profile numbers the sibling ticket ships, the caps sit
so far above FRET's own concurrency that *firing at all* is itself a signal worth seeing.

`noteRpcFailure`'s `switch` has a `default` arm that returns without scoring, so the new variant is
correctly inert there by construction; name it in the `default` comment explicitly rather than
leaving it implicit.

Place the check in `classify` **before** the `unreachable` fallback and after the foreign-protocol /
truncation checks (the identities are disjoint, so order among them is free).

Add a diagnostic counter (`diag.streamLimit`, or the nearest existing shape) so a cap that does fire
is visible rather than silent.

### The remote's inbound cap is not distinguishable — record it, do not paper over it

When a remote refuses our stream at its own inbound cap, `onIncomingStream` throws
`TooManyInboundProtocolStreamsError` and the catch calls `muxedStream.abort(err)` — so the *sender*
sees a **reset**, not a reply. That error object is constructed on the remote's side; a muxer reset
carries at most a numeric code on the wire, so the reason does not travel. **We therefore cannot
classify a remote inbound-cap refusal by error identity** — on our side it is indistinguishable from
any other reset and reads as `unreachable`, booking a contact strike against a peer that is alive
and merely overloaded.

This is a stated residual, not something to fix with a heuristic. It is acceptable because of the
concurrency arithmetic the sibling ticket documents: FRET's own traffic cannot approach any peer's
inbound cap, so the only way to trip it is a peer flooding us, or a consumer opening its own streams
over the same connection. Record it as a `NOTE:` at the `classify` site and as a sentence in
`docs/fret.md` — someone will otherwise re-derive it as a bug.

## Tests

- Extend `packages/fret/test/rpc.request.spec.ts` with a `classify` case driving a thrown
  `TooManyOutboundProtocolStreamsError` and asserting `{ kind: 'local-limit' }`. Cover the inbound
  identity too if the predicate matches both.
- A service-level assertion that `noteRpcFailure` books **no** contact strike, no relevance decay
  and no backoff for `local-limit`.

## TODO

- Add `isStreamLimitError` (or the predicate pair) beside `isFrameTruncationError` /
  `isPayloadTooLargeError`.
- Add the `local-limit` variant to `RpcOutcome` with its "what it proves about the peer" doc comment.
- Add the `classify` arm before the `unreachable` fallback.
- Add the diagnostic counter.
- Update `noteRpcFailure`'s `default`-arm comment to name `local-limit` explicitly.
- `NOTE:` at the `classify` site recording that a *remote's* inbound-cap refusal is not
  distinguishable from any other reset, and why that is acceptable.
- Write the `rpc.request.spec.ts` case and the service-level scoring case.
- `docs/fret.md`: one sentence stating the non-distinguishable-reset residual, in
  *Stream management* beside the stream-cap bullet the sibling ticket rewrites.
- Run `cd packages/fret && npx tsc --noEmit` and `yarn test` before handing off.

<!-- resume-note -->
## Resume note — discovery done, no code written yet

A prior run read the relevant sites and hit its token budget before editing. Nothing in the
working tree was changed. Exact sites, so the next run does not re-discover them:

**Predicate goes here.** `packages/fret/src/rpc/protocols.ts:338-353` — `isPayloadTooLargeError`
and `isFrameTruncationError` sit adjacent, both matching on `err.name` with an
`err == null || typeof err !== 'object'` guard first. Match that shape exactly; the libp2p error
classes are not importable, same as the note on `isFrameTruncationError`.

**`classify` arm goes here.** `packages/fret/src/rpc/request.ts` — `classify(err, callerSignal,
deadlineSignal)`, roughly lines 86-96. Current order: caller-signal → `foreign-protocol` →
truncation → payload-too-large → deadline/`DeadlineExpiredError` → `unreachable` fallback. Put the
stream-limit check with the other identity checks (before the deadline check is fine — identities
are disjoint), and definitely before the `unreachable` fallback. Note `classify` returns
`RpcOutcome<never>`, so the new variant must be constructible there.

**`noteRpcFailure`.** `packages/fret/src/service/fret-service.ts:873-896`. Its `default` arm is at
line ~890 with the comment `// ok / busy / cancelled / skipped are the callers' to handle` — that
is the comment the TODO says to extend with `local-limit`, and the variant is inert there by
construction.

**Diagnostics.** The `diag` object literal is at `fret-service.ts:398` (flat counters
`pingsSent` / `pingsOk` / `pingsFail`, then a nested `rejected` sub-object). `streamLimit` belongs
beside `pingsFail` as a flat counter, not under `rejected` — `rejected` counts *inbound* messages
we refused, and this is an outbound refusal by our own stack. `getDiagnostics()` at line ~526
returns `Readonly<typeof this.diag>`, so adding a field needs no other change.

**Switch sites that must gain an arm.** Adding a variant will break every exhaustive `switch` over
`RpcOutcome['kind']`. Candidates found by grep (line numbers approximate, grep the surrounding
symbol):
- `fret-service.ts:1661-1668` — pooled warm-up ping fan-out (`pingWarmupTargets`)
- `fret-service.ts:2374-2409` — `probeNeighborLatency`
- `fret-service.ts:2587-2625` — `probeMembership`
- `fret-service.ts:2669-2685` — `fetchAndMergeSnapshot`
- `fret-service.ts:2972-2996` — the maybeAct forward path
- `fret-service.ts:3278`, `3287`, `3358`, `3360` — `iterativeLookup`, `if`-based rather than
  `switch`, so these will *not* fail to compile; check each reads `local-limit` sanely (it should
  fall through to "no progress from this peer", not to a strike).

Run `cd packages/fret && npx tsc --noEmit` immediately after adding the variant — the compile
errors are the authoritative list of sites, more reliable than the grep above. Several of those
switches have a `default`, so the compiler will not flag them; read each one that grep names.

The design, tests and remaining TODO list above are unchanged and still correct.
