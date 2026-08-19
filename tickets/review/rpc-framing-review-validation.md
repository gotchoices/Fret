description: The message-framing change to the peer-to-peer layer has now been reviewed line by line and the security docs corrected; all that is left is to run the type-check and the test suite and write the archive summary.
files: packages/fret/src/rpc/protocols.ts, packages/fret/test/rpc.protocols.spec.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, docs/threat-analysis.md, docs/threat-rir-mitigated.md
difficulty: easy
----

## Why this ticket exists

Fourth and final leg of one review. The change under review is the whole length-prefix framing
change as a single unit, `rpc-framing-src` (f5f2eb6) through `rpc-framing-suite-green-handoff`
(5cd9196); cumulative diff `git diff f5f2eb6^ HEAD -- packages/fret docs`.

Runs 1–3 finished **all** reading: source, all five changed test files, and the docs. Run 3 also
landed the two inline fixes below. **Nothing is left to read.** What remains is the validation run
and writing the `complete/` ticket.

## Remaining scope — validation only

Both commands from `packages/fret/`, foreground, no redirection:

- `npx tsc --noEmit`
- `yarn test` (~4 min; 824 tests were green at the implement handoff)

Neither has been independently reproduced by any review run yet. Run 3 edited one test file
(`rpc.protocols.spec.ts`) and two docs files, so the type-check covers a real edit.

If either fails, judge whether the failure comes from the framing change / the run-3 edits (fix it
here) or is pre-existing (follow the pre-existing-failure rules — never skip a test).

Then write the `complete/` ticket with the `## Review findings` section, carrying the banked
findings below verbatim plus whatever validation surfaced. Delete this ticket.

## Fixes already applied by run 3 — do not redo

- **`docs/threat-analysis.md` + `docs/threat-rir-mitigated.md`: stale reader description, fixed.**
  Seven places described the old `readAllBounded` in the present tense as a current mitigation.
  The `**Current mitigations**` bullets at 3.4 / 3.5 / 3.7 / 4.4 now name `readFramed` and state
  the cap as a refusal of an over-declared frame *at the length prefix, before any body byte is
  pulled*, rather than a generic byte limit. The two `**Status —**` notes (3.7, 8.4) and the RiR
  mirror of 8.4 now say end-of-*message* comes from the length prefix and a short stream raises
  `FrameTruncationError` instead of completing the read. Two stale source line references
  (`protocols.ts:42-84`, `protocols.ts:53`) were dropped. The numbered findings' own historical
  bodies and titles still say `readAllBounded` on purpose — that is the record of what was found
  at the time, and each is now explicitly framed as pre-framing.
- **`packages/fret/test/rpc.protocols.spec.ts`: floating promise in the new `ping RTT floor`
  `before` hook, fixed.** `registerPing` is `async` and was called bare; now awaited. It happened
  to work (the following `await a.dial(...)` gave it a turn), but an unhandled rejection there
  would be process-fatal under Node's default, and the house rule is await or `void`.

## Review findings (carry into the `complete/` ticket)

- **Source half: no findings.** Every claim in the implement handoff was confirmed against the
  code: `sendFramed` is one `stream.send(lp.encode.single(body))`; the over-cap refusal lives in
  the decoder's `onLength` hook so it fires on the varint prefix before a body byte is pulled
  (message `payload too large: <declared> exceeds <max> byte limit`), with the
  `InvalidDataLengthError` arm reported as the same over-cap failure; both truncation message
  paths exist and `isFrameTruncationError` matches both plus `it-length-prefixed`'s
  `UnexpectedEOFError`; the end-of-stream poll holds a single `iter.next()` across ticks and
  requires a *numeric* `readBufferLength`, so a plain async iterable can never reach the
  truncation branch; per-protocol wire caps did not drift (maybeAct 512 KB, neighbors 128 KB,
  ping 1024, leave 4096); `readAllBounded` / `toBytes` are gone from `src/` entirely.
- **All five changed test files: no findings beyond the one floating promise fixed above.**
  - `rpc.stream-errors.spec.ts` — the "over a real transport" group is a genuine TCP/noise/yamux
    pair (`createMemoryNode` is the TCP factory despite the name), both live half-close shapes are
    driven over it, and stream release is asserted by polling `connection.streams`. The new
    trailing-bytes case pins `delivered === 1`, i.e. the reset queued behind the frame is provably
    never pulled — measured, not inferred.
  - `payload-bounds-ttl.spec.ts` — now distinguishes the two cases the old primitive conflated:
    immediate EOF throws `FrameTruncationError`, a zero-length frame returns an empty buffer.
  - `rpc.codec-properties.spec.ts` — the over-cap pull count is an exact measured `1` (not a
    bound), in both the fixed case and the arbitrary-chunk-size property.
  - `rpc.handler-fuzz.spec.ts` — the rewritten `sendRaw` returns a three-way discriminated
    `reply | eof | abort` instead of the old `Uint8Array | undefined`, which is what lets the
    matrix tell a silent identity-mismatch drop (clean close, no frame → truncation → `eof`) from
    the wrapper's error-arm reset (`abort`). That distinction was previously carried by a
    zero-byte buffer and is now a type, so a future row cannot conflate them by accident.
  - `rpc.protocols.spec.ts` — the new `ping RTT floor` test is the headline regression guard: the
    old reader paid at least one 20 ms EOF poll per ping, so it asserts the min of five in-memory
    pings lands under 10 ms.
- **Grep for assertions still matching the old timeout text: clean.** `grep -rn "bytes read"` over
  `packages/fret` hits only `@types/node`, so nothing still asserts the dropped `(<n> bytes read)`
  suffix.
- **Docs checked, not assumed.** `docs/fret.md`'s stream-read-deadline bullet is accurate as
  written: it keeps message-delimiting (length prefix), stream-end detection (`EOF_POLL_MS`), and
  the rejected per-chunk idle timer as three distinct concepts, and says so explicitly.
  `test/README.md:71`'s `readFramed` bullet covers both truncation paths — iterator EOF *and* the
  20 ms poll. The two threat docs were stale and were fixed (above).
- **Tripwire, already parked, index only:** `EOF_POLL_MS` puts a floor of up to 20 ms under
  measured ping RTT. Parked as a code `NOTE:` at the constant in
  `packages/fret/src/rpc/protocols.ts`, not a ticket — the durable fix (iterator priming) is a
  bigger change than this one warranted. The new RTT test asserts the floor is gone for the
  *frame-complete* case, which is what the change was for.
- **Considered and not filed — timing-threshold flake risk in the new RTT test.** A wall-clock
  assertion (`< 10 ms`) is inherently machine-sensitive. Left as-is deliberately: it is
  min-of-five over the in-process memory transport with 2x margin against the 20 ms floor it
  guards, and weakening it to a non-timing assertion would retire the only test that proves the
  headline symptom is gone. If it ever flakes, raise the sample count, not the threshold.
- **Considered and not filed — `createMemoryNode` is the TCP factory while `createMemNode` is the
  memory one.** Genuinely confusing, but pre-existing and untouched by this change; filing it as
  part of this review would be scope creep.
- **No major findings, so no new `fix/`, `plan/`, or `backlog/` tickets were spawned.** That is a
  statement about this change, not an omission: the two things this framing change had to get
  right and could plausibly have got wrong — refusing an over-cap message before pulling its body,
  and holding one `iter.next()` across poll ticks rather than re-issuing it — were both checked in
  the source and are both pinned by measurement in the tests.
