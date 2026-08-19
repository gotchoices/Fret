description: The RPC layer now sends every message as one length-prefixed frame instead of relying on stream close to mark the end of a message; this ticket asks a reviewer to check that whole change, plus its tests and docs, before it's considered done.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/index.ts, packages/fret/test/rpc.stream-errors.spec.ts, packages/fret/test/rpc.protocols.spec.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/README.md, docs/fret.md
difficulty: medium
----

## What changed, in one sentence

Every FRET wire message now travels as one length-prefixed frame per direction per stream
(`sendFramed`/`readFramed`, backed by `it-length-prefixed`), replacing the old
"read until the stream closes" convention that made a healthy slow sender indistinguishable
from a truncated one.

## Scope of this review

This covers the **entire** framing change as one unit, spanning several prior implement
tickets (now all landed and deleted): `rpc-framing-src` (commit f5f2eb6, the original
length-prefix implementation), the test/fuzz/docs follow-ups, and the halfclose-fix
(`15.12-rpc-framing-halfclose-fix-handoff`, restoring an end-of-stream poll that a real-transport
regression test caught). Review it as one change, not five.

## What to check

### Source (`packages/fret/src/rpc/protocols.ts`)

- `sendFramed(stream, body)` = `stream.send(lp.encode.single(body))` — one frame out.
- `readFramed(stream, maxBytes, timeoutMs = RPC_TIMEOUT_MS, opts?)` reads exactly one frame in.
  Internals worth checking directly, not just trusting the doc comment:
  - Over-cap refusal happens in the decoder's `onLength` hook, at the varint length prefix,
    before any body byte is pulled — so an oversized message costs the receiver only the
    prefix. Error message: `payload too large: ...`.
  - Stream ends before a whole frame arrives → `FrameTruncationError`. Two distinct message
    text paths: iterator `done` → `'stream ended before a framed message arrived'`;
    the end-of-stream poll winning with `remoteFinishedWriting(stream)` true →
    `'stream ended before a whole framed message arrived'`. `isFrameTruncationError` must
    match both, plus `it-length-prefixed`'s own `UnexpectedEOFError` for a partial frame.
  - Timeout (deadline reached with no frame and no confirmed remote close) throws with message
    `read timed out after ${timeoutMs}ms` — never returns a partial buffer.
  - Zero-length frame decodes to an empty `Uint8Array`, not an error.
  - Trailing bytes after the one frame are never pulled from the stream.
  - **The end-of-stream poll** (`POLL_TICK`, `EOF_POLL_MS = 20`, `ReadEndState`,
    `remoteFinishedWriting`): `readFramed` polls in a loop rather than a single race, because
    libp2p's stream iterator subscribes to `remoteCloseWrite`/`close` only when iteration
    *starts* — a responder that closes while the caller is still opening its stream loses that
    event, and the adaptor's `readStatus` flips to `'closed'` silently with no second event to
    catch. Confirm the poll interval is `Math.min(remaining, EOF_POLL_MS)` (overshoot ≤ 20ms),
    that the single `iter.next()` promise is issued once and held across poll ticks (not
    re-issued — re-issuing would drop whatever arrives between ticks), and that a merely-slow
    stream (no `readBufferLength`, a plain async iterable, as stub-backed tests use) never hits
    the `remoteFinishedWriting` branch and so is never falsely truncated.
- `src/index.ts` exports `sendFramed`, `readFramed`, `openRpcStream`, `releaseRpcStream` — no
  `readAllBounded` (deleted, was the old unframed reader). Check nothing else in `src/` still
  references it (see "Known, deliberate loose ends" below for where stale mentions are expected
  to remain).

### Settled behavioral contracts (should NOT have moved during this change)

- `sendPing` maps a truncated/undecodable reply to `{ok: false, rttMs}` and — this is the
  subtle one — must not have sent a request in that failure path (only in the normal path).
- Ping and neighbors-request handlers never read the request body (both are body-less
  requests); confirm no accidental `readFramed` call was added to either.
- Half-close semantics (caller closes write end after send, keeps read end open for the reply)
  are unchanged.
- Per-protocol wire caps: maybeAct sender 512 KB, neighbors 128 KB, ping 1024 bytes, leave
  handler 4096 bytes. Confirm these didn't drift while the framing internals changed.

### Tests

- `test/rpc.stream-errors.spec.ts` — the "real transport" group (was previously the source of
  the two known failures this ticket run fixed; see below). Confirm it actually exercises a
  real libp2p transport pair, not just stubs, for the half-close-then-close scenarios.
- Framed chunk-boundary property test, RTT-floor assertion, zero-length-frame semantics,
  over-cap-at-prefix pull-counting (`test/rpc.codec-properties.spec.ts` and neighbors),
  discriminated drop-vs-abort `sendRaw` coverage (`test/rpc.handler-fuzz.spec.ts`).
- `test/README.md`'s `readFramed` bullet should describe both the iterator-EOF path and the
  poll path for the close-without-frame case — confirm it still matches the code, not just
  that it exists.

### Docs (`docs/fret.md`)

- The stream-read-deadline bullet (~"Stream read deadline" under *libp2p integration*) explains
  why `readFramed` never waits on EOF to delimit a *message*, and separately why recognising
  end-of-*stream* still needs the 20ms poll — and explicitly distinguishes that poll from the
  deliberately-rejected per-chunk idle timer. Read it against the actual code and confirm the
  two concepts (message delimiting vs. stream-end detection) aren't conflated.
- The `EOF_POLL_MS` tripwire (poll adds up to one interval of floor under measured ping RTT;
  durable fix would be iterator priming — subscribing before writing) should be a code `NOTE:`
  at the constant in `protocols.ts`, not a ticket. Confirm it's there and reads as a tripwire
  (conditional), not a disguised TODO.

## Validation already done — re-run only if you doubt it

- `cd packages/fret && npx tsc --noEmit` — clean at handoff time.
- `cd packages/fret && yarn test` — **824 passing, 0 failing**, full suite, ~4 minutes. This is
  the first run in this change's history to come back fully green; every prior run had at least
  one of two known real-transport failures (half-then-close ping, half-then-close snapshot),
  fixed by the end-of-stream poll restoration above. Re-run it once if anything here looks
  suspicious — this handoff has not been independently re-verified beyond that one green run.

## Known, deliberate loose ends (checked, left as-is on purpose — not findings)

- Historical `readAllBounded` mentions remain in `docs/threat-analysis.md`,
  `docs/threat-rir-mitigated.md`, `tickets/complete/*`, and
  `tickets/plan/15.2-rpc-request-helper.md` — these are records of past state, not live
  documentation of the current API, and rewriting history in `complete/` isn't the point of
  those files.
- A deliberate comment at `test/rpc.protocols.spec.ts:534` mentioning the old behavior — check
  it still reads correctly in context (i.e. it's explaining *why* something is tested a certain
  way, not asserting stale behavior) but don't treat its mere existence as a defect.

## Review findings (fill in during review)

- Tripwire to index: `EOF_POLL_MS` puts a floor (up to 20ms) under measured ping RTT. Parked
  as a code `NOTE:` at the constant in `packages/fret/src/rpc/protocols.ts`, not a ticket —
  durable fix (iterator priming) is a bigger change than this one warranted.
