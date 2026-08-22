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
