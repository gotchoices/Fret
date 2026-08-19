description: The RPC layer now marks the end of each message with a length prefix instead of relying on the connection closing; two earlier review runs checked the source code and most of the tests before running out of budget, so this ticket finishes the last two test files, corrects the security docs that still describe the old reader, and runs the type-check and test suite.
files: packages/fret/src/rpc/protocols.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/rpc.protocols.spec.ts, packages/fret/test/README.md, docs/fret.md, docs/threat-analysis.md, docs/threat-rir-mitigated.md
difficulty: medium
----

## Why this ticket exists

Third leg of one review. The change under review is the whole length-prefix framing change as a
single unit, `rpc-framing-src` (f5f2eb6) through `rpc-framing-suite-green-handoff` (5cd9196);
cumulative diff `git diff f5f2eb6^ HEAD -- packages/fret docs`.

- Run 1 (`rpc-framing-full-change-review`) finished the **source** half and banked it.
- Run 2 (this ticket's parent) finished **three of five** changed test files and banked them.
- What is left is two test files, the docs, and the validation run.

Nothing has been fixed or filed by either run. The one open finding (stale docs) is still open.

## Already checked — do not redo

### Source (banked by run 1, confirmed in the code)

- `sendFramed` = one `stream.send(lp.encode.single(body))`; the ignored boolean is documented as
  owned by the follow-up write-backpressure ticket.
- Over-cap refusal lives in the decoder's `onLength` hook, so it fires on the varint prefix before
  a body byte is pulled; message text `payload too large: <declared> exceeds <max> byte limit`.
  The `InvalidDataLengthError` arm (varint past 2^53, which trips the library's own check before
  `onLength`) is reported as the same over-cap failure.
- Both truncation message paths exist and `isFrameTruncationError` matches both plus
  `it-length-prefixed`'s `UnexpectedEOFError`.
- End-of-stream poll: interval `Math.min(remaining, EOF_POLL_MS)`; the single `iter.next()` is
  issued once before the loop and held across ticks; `remoteFinishedWriting` requires a *numeric*
  `readBufferLength`, so a plain async iterable can never reach the truncation branch.
- `EOF_POLL_MS` carries a conditional `NOTE:` (RTT floor; durable fix is iterator priming) — a
  tripwire, correctly parked, not a disguised TODO.
- Per-protocol wire caps did not drift: maybeAct sender 512 KB, neighbors 128 KB, ping 1024,
  leave 4096.
- `sendPing`'s truncation arm returns `{ok: false, rttMs}` and sends no request. Half-close
  semantics unchanged. `readAllBounded` / `toBytes` gone from `src/` entirely.

### Tests (banked by run 2, read in full against the diff)

- **`test/rpc.stream-errors.spec.ts` — no finding.** The "over a real transport" group is genuine:
  it stands up two `createMemoryNode()` nodes, which despite the name is **TCP + noise + yamux**
  (`test/helpers/libp2p.ts:11-19`) — `createMemNode` is the memory-transport one. Both live shapes
  (half-write-then-close, half-write-then-`abort`) are driven over it, and stream release is
  asserted by polling `connection.streams` rather than assumed.
  - `expectStallRejection` correctly dropped its `<n> bytes read` assertion — the message no
    longer carries a byte count.
  - The new "trailing bytes after the first frame" case pins `delivered === 1`, i.e. the reset
    queued behind the frame is provably never pulled. Measured, not inferred.
  - Minor naming observation, **pre-existing and out of scope**: `createMemoryNode` is the TCP
    factory and `createMemNode` the memory one. Confusing, but not introduced by this change and
    not a defect. Do not file it as part of this review.
- **`test/payload-bounds-ttl.spec.ts` — no finding.** Whole `readAllBounded` describe converted to
  `readFramed`. It now distinguishes the two cases the old primitive conflated: immediate EOF
  throws `FrameTruncationError`, a zero-length frame (`0x00`) returns an empty buffer. Over-declared
  frames are refused at the prefix regardless of chunking. The deadline cases still assert the
  read *rejects* rather than returning a partial frame.
- **`test/rpc.codec-properties.spec.ts` — no finding.** The pull-counting claim is real: the
  counter increments inside the source's own `next()`, pull 1 yields the bare prefix, and the
  over-cap assertions are `pulls() === 1` (exact, not a bound) in both the fixed case and the
  arbitrary-chunk-size property. Chunk-boundary property now frames before chunking; a second
  property round-trips all five wire types plus `SerializedTable` through frame → arbitrary
  chunking → decode.

## Remaining review scope

- **Read `git diff f5f2eb6^ HEAD -- packages/fret/test/rpc.handler-fuzz.spec.ts`** (107 lines) —
  the discriminated drop-vs-abort `sendRaw` coverage.
- **Read `git diff f5f2eb6^ HEAD -- packages/fret/test/rpc.protocols.spec.ts`** (44 lines). The
  comment at `test/rpc.protocols.spec.ts:534` mentions the old behavior on purpose — check it
  still reads correctly in context; its existence is not a defect.
- **Grep the suite for assertions still matching the old timeout text** — the message lost its
  `(<n> bytes read)` suffix: `grep -rn "bytes read" packages/fret/test`.
- **Coverage the implementer's tests may not reach**, now that the rest is banked: the RTT-floor
  assertion, and the `InvalidDataLengthError` arm (an 8-byte varint declaring past 2^53, which
  reports as the same over-cap failure). Trailing-bytes and no-partial-buffer-on-timeout are
  already covered — see the banked notes above.
- **Docs.** `docs/fret.md`'s stream-read-deadline bullet against the actual code: confirm
  message-delimiting and stream-end-detection stay distinct concepts, and both stay distinct from
  the rejected per-chunk idle timer. Confirm `test/README.md`'s `readFramed` bullet describes
  *both* the iterator-EOF path and the poll path.
- **Validation (must pass):** `cd packages/fret && npx tsc --noEmit`, then
  `cd packages/fret && yarn test` in the foreground with no redirection (~4 min; 824 tests were
  green at handoff). Neither has been independently reproduced by any review run yet.

## Open finding carried forward — minor, fix inline

**`docs/threat-analysis.md` describes `readAllBounded` in the present tense as a current
mitigation.** The historical record in the numbered findings' original text is deliberate and
stays. These bullets are not that — they are labelled `**Current mitigations**:` or `**Status —**`
and tell the reader how the code works *today*:

- `threat-analysis.md:192`, `:206`, `:233`, `:291` — "Current mitigations: `readAllBounded` limits
  payload to 128KB / limits total bytes / payload limit".
- `threat-analysis.md:224` — cites `protocols.ts:42-84` and a "100ms idle timeout" that has not
  existed for two changes.
- `threat-analysis.md:234`, `:671` and `threat-rir-mitigated.md:309` — status notes asserting the
  read "ends on iterator EOF or on the stream reporting the remote finished writing". Now only half
  the story: end-of-*message* comes from the length prefix, and end-of-*stream* raises
  `FrameTruncationError` rather than completing the read.

Cheap in-pass fixes: rename to `readFramed`, restate the byte cap as a declared-length refusal at
the prefix, drop the stale line reference. Fix inline unless reading them in full shows the
rewrite is larger than it looks.

## Deliberate loose ends (not findings)

- Purely historical `readAllBounded` mentions in `tickets/complete/*` and
  `tickets/plan/15.2-rpc-request-helper.md` stay as-is.

## Review findings (carry into the `complete/` ticket)

Banked so far — expand as the remaining scope is worked:

- **Tripwire, already parked, index only:** `EOF_POLL_MS` puts a floor of up to 20 ms under
  measured ping RTT. Parked as a code `NOTE:` at the constant in
  `packages/fret/src/rpc/protocols.ts`, not a ticket — the durable fix (iterator priming) is a
  bigger change than this one warranted.
- **Source half: no findings.** Every claim in the implement handoff was confirmed in the code
  (list above), including the two that are easy to state and hard to actually do — refusal at the
  prefix before any body byte, and the single held `iter.next()` across poll ticks.
- **Three of five changed test files: no findings.** Details above; the two claims worth naming as
  verified rather than accepted are the real-transport group being a genuine TCP/noise/yamux pair
  and the over-cap pull count being an exact measured `1`.
