description: The RPC layer now sends every message as one length-prefixed frame instead of relying on stream close to mark the end of a message; a first reviewer checked the source half and ran out of budget, so this ticket finishes the review of the tests, docs and the test run.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/ping.ts, packages/fret/test/rpc.stream-errors.spec.ts, packages/fret/test/rpc.protocols.spec.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/payload-bounds-ttl.spec.ts, packages/fret/test/README.md, docs/fret.md, docs/threat-analysis.md, docs/threat-rir-mitigated.md
difficulty: medium
----

## Why this ticket exists

A prior review run of `rpc-framing-full-change-review` crossed its token budget after finishing
the **source** half of the review. Nothing was fixed and nothing was filed; this ticket carries
the same review forward with the source pass already banked, so the remaining budget goes to the
tests, the docs, and the validation run.

Scope is unchanged: the whole length-prefix framing change as **one** unit, spanning
`rpc-framing-src` (f5f2eb6) through `rpc-framing-suite-green-handoff` (5cd9196). The cumulative
diff is `git diff f5f2eb6^ HEAD -- packages/fret docs`.

## Already checked — do not redo

Source diff (`src/index.ts`, `src/rpc/{protocols,ping,leave,neighbors,maybe-act}.ts`) read in
full against the handoff claims. All of the following were confirmed **in the code**:

- `sendFramed` = one `stream.send(lp.encode.single(body))`; the ignored boolean is documented as
  owned by the follow-up write-backpressure ticket.
- Over-cap refusal lives in the decoder's `onLength` hook, so it fires on the varint prefix
  before a body byte is pulled; message text `payload too large: <declared> exceeds <max> byte
  limit`. The `InvalidDataLengthError` arm (varint past 2^53, which trips the library's own check
  before `onLength`) is reported as the same over-cap failure.
- Both truncation message paths exist and `isFrameTruncationError` matches both plus
  `it-length-prefixed`'s `UnexpectedEOFError`.
- The end-of-stream poll: interval is `Math.min(remaining, EOF_POLL_MS)`; the single `iter.next()`
  is issued **once** before the loop and held across ticks; `remoteFinishedWriting` requires a
  *numeric* `readBufferLength`, so a plain async iterable (stub-backed tests) can never reach the
  truncation branch.
- `EOF_POLL_MS` carries a `NOTE:` at the constant, phrased conditionally (RTT floor; durable fix
  is iterator priming) — a tripwire, not a disguised TODO. Correctly parked.
- Per-protocol wire caps did not drift: maybeAct sender 512 KB, neighbors 128 KB, ping 1024,
  leave 4096.
- `sendPing`'s truncation arm returns `{ok: false, rttMs}` and sends no request — ping is
  body-less, so the "must not have sent a request in the failure path" contract holds trivially.
  Neither ping nor the neighbors-request handler reads a body.
- Half-close semantics unchanged (`sendMaybeAct` still sends, `await stream.close()`, then reads).
- `readAllBounded` and `toBytes` are gone from `src/` entirely; no live source reference remains.

## Open finding carried forward (decide during this review)

**`docs/threat-analysis.md` states `readAllBounded` behavior in the present tense, as a current
mitigation.** The source ticket listed the `readAllBounded` mentions in
`docs/threat-analysis.md` / `docs/threat-rir-mitigated.md` as deliberate historical records. That
holds for the numbered findings' original text, but several bullets are explicitly labelled
`**Current mitigations**:` or `**Status —**` and describe how the reader works *today*:

- `threat-analysis.md:192`, `:206`, `:233`, `:291` — "Current mitigations: `readAllBounded`
  limits payload to 128KB / limits total bytes / payload limit".
- `threat-analysis.md:224` — cites `protocols.ts:42-84` and a "100ms idle timeout" that has not
  existed for two changes.
- `threat-analysis.md:234`, `:671` and `threat-rir-mitigated.md:309` — status notes asserting the
  read "ends on iterator EOF or on the stream reporting the remote finished writing", which is
  now only half the story: end-of-*message* comes from the length prefix, and end-of-*stream*
  raises `FrameTruncationError` rather than completing the read.

These are cheap in-pass fixes (rename to `readFramed`, restate the byte cap as a declared-length
refusal at the prefix, drop the stale line reference). Treat as **minor — fix inline**, unless
reading them in full shows the rewrite is larger than it looks.

## Remaining review scope

- **Read the test diff** (`git diff f5f2eb6^ HEAD -- packages/fret/test`) with fresh eyes before
  the handoff summary. In particular:
  - `test/rpc.stream-errors.spec.ts` — confirm the "real transport" group actually stands up a
    libp2p transport pair rather than stubs for the half-close-then-close scenarios (this is the
    group that caught the regression the poll restoration fixed).
  - `test/rpc.codec-properties.spec.ts` — framed chunk-boundary property, zero-length-frame
    semantics, and the over-cap-at-prefix **pull-counting** assertion (the claim is measured, not
    inferred; check the counter really counts source pulls).
  - `test/rpc.handler-fuzz.spec.ts` — discriminated drop-vs-abort `sendRaw` coverage.
  - `test/payload-bounds-ttl.spec.ts` — 88 lines changed and not mentioned in the source ticket's
    "what to check" list; read it.
  - Coverage the implementer's tests may not reach: the RTT-floor assertion, a timeout that
    returns no partial buffer, trailing bytes after the frame never pulled, and the
    `InvalidDataLengthError` arm.
  - The timeout message lost its `(${len} bytes read)` suffix; grep the suite for any assertion
    still matching the old text.
- **Docs**: read `docs/fret.md`'s stream-read-deadline bullet against the actual code and confirm
  message-delimiting and stream-end-detection are kept distinct (and distinct from the rejected
  per-chunk idle timer). Confirm `test/README.md`'s `readFramed` bullet describes *both* the
  iterator-EOF path and the poll path.
- **Validation** (must pass): `cd packages/fret && npx tsc --noEmit`, then
  `cd packages/fret && yarn test` in the foreground with no redirection (~4 min, 824 tests were
  green at handoff). The handoff's green run has not been independently reproduced.

## Deliberate loose ends (not findings)

- The purely historical `readAllBounded` mentions in `tickets/complete/*` and
  `tickets/plan/15.2-rpc-request-helper.md` stay as-is.
- The comment at `test/rpc.protocols.spec.ts:534` mentions the old behavior on purpose — check it
  still reads correctly in context, but its existence is not a defect.

## Review findings (fill in during review)

- Tripwire to index (already parked, carry into the `complete/` ticket): `EOF_POLL_MS` puts a
  floor of up to 20 ms under measured ping RTT. Parked as a code `NOTE:` at the constant in
  `packages/fret/src/rpc/protocols.ts`, not a ticket — the durable fix (iterator priming) is a
  bigger change than this one warranted.
