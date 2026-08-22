---
description: Our own node refusing to open a network stream because it hit its own ceiling used to be blamed on the peer we were talking to, eventually marking that healthy peer as dead. That case now has its own name and scores nothing against the peer.
files: packages/fret/src/rpc/outcome.ts, packages/fret/src/rpc/request.ts, packages/fret/src/rpc/protocols.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.request.spec.ts, packages/fret/test/dead-state.spec.ts, docs/fret.md
difficulty: medium
---

## What landed

A new `RpcOutcome` variant, `local-limit`, for the case where libp2p refuses to open an outbound
stream because **this node** hit its own per-connection stream cap. It used to fall through to
`unreachable`, which books a contact strike; three of them marked a perfectly healthy peer `dead`
and dropped it out of every ring view.

- `isStreamLimitError` (`src/rpc/protocols.ts`, immediately after `isFrameTruncationError`) —
  matches `TooManyOutboundProtocolStreamsError` and `TooManyInboundProtocolStreamsError` by
  `err.name`, same shape and same `err == null || typeof err !== 'object'` guard as the two
  predicates beside it. Not exported from `src/index.ts`, matching that pair.
- `{ kind: 'local-limit'; error: Error }` on `RpcOutcome` (`src/rpc/outcome.ts`), with the
  "what it proves about the peer" doc comment the sibling variants carry.
- A `classify` arm in `src/rpc/request.ts`, placed after the payload-too-large check and before
  the deadline/`unreachable` fallback, with the `NOTE:` recording the non-distinguishable remote
  inbound-cap reset and why it is accepted rather than guessed at.
- `diag.streamLimit`, a flat counter beside `pingsFail` (not under `rejected`, which counts
  inbound refusals). Incremented in exactly one place: a new `case 'local-limit'` in
  `noteRpcFailure` that counts and returns.
- Six call sites gained a `local-limit` arm: `pingWarmupTargets`, `probeNeighborLatency`,
  `probeMembership`, `fetchAndMergeSnapshot`, the `routeAct` forward path, and `iterativeLookup`.
  All route through `noteRpcFailure` (so the counter is single-sourced) and none records a strike,
  a relevance decay, a backoff, or a ping diagnostic.
- One sentence — in practice one long bullet — in `docs/fret.md` under *Stream management*, beside
  the stream-cap bullet the sibling `stream-caps-plumbing` ticket rewrites.

## Deviation from the ticket, deliberate

The ticket said to leave `local-limit` inert in `noteRpcFailure`'s `default` arm and merely name it
in that arm's comment. It has an **explicit `case`** instead, because the diagnostic counter has to
be incremented somewhere and `noteRpcFailure` is the only seam every outbound-RPC failure path
already reaches. The case counts and returns — no scoring — so the "scores nothing" property the
ticket asked for is unchanged, and it is greppable rather than implicit. The `default` comment and
the method's doc comment were both updated to say so.

## Validation

- `npx tsc --noEmit` from `packages/fret` — clean.
- `yarn test` — 1235 passing, no failures, no pre-existing failures surfaced.

New cases:
- `test/rpc.request.spec.ts` — `classify` returns `local-limit` for a thrown
  `TooManyOutboundProtocolStreamsError` at the open, and for the inbound identity too (unreachable
  from a FRET sender; the predicate matches it for a consumer opening against its own inbound cap).
- `test/dead-state.spec.ts`, liveness-seam block — five `local-limit` outcomes through
  `noteRpcFailure` leave `contactFailures`, `relevance`, `failureCount`, `negotiateFailures`,
  `membership` and `state` all untouched, write no backoff entry, and increment
  `diag.streamLimit` to 5.

## Known gaps, for the reviewer

- **No test drives `local-limit` through a real call site.** The two specs cover the classifier and
  the scoring seam; the six switch arms that route into `noteRpcFailure` are covered only by the
  compiler. Making a stub throw the cap error out of `newStream` at, say, `probeNeighborLatency`
  would pin one of them; nothing pins that they *all* route the same way. The riskiest of the six
  is `iterativeLookup`, whose arm is an `if` (the compiler cannot flag a missing one) and which
  deliberately `hop++`s and continues rather than breaking the walk — worth a read.
- **`probeNeighborLatency` returns `false` for `local-limit`.** That means the caller
  (`probeAndFetch`) skips the snapshot fetch. Intended — the fetch would meet the same ceiling —
  but it is a behavior choice, not a forced one, and it is untested.
- **The write-only senders are unhandled by name.** `announceNeighbors` and `sendLeave` log
  `out.kind` on anything that is not `ok`/`cancelled` (`fret-service.ts` ~1597, ~1839, ~1857), so a
  `local-limit` there logs as a failure and scores nothing. Correct by accident of those sites
  scoring nothing at all, not by an explicit arm.
- **The remote-inbound-cap residual is recorded, not solved.** A remote refusing our stream at its
  own inbound cap still reads as `unreachable` and still books a contact strike. That is the
  stated, accepted residual (`NOTE:` at `classify`, sentence in `docs/fret.md`); the reviewer
  should check the reasoning holds rather than treating it as an oversight.
- The sibling `stream-caps-plumbing` ticket rewrites the same `docs/fret.md` bullet this ticket
  appends to — expect a merge touch there.
