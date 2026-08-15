description: Fixed a bug where the network code gave up reading a large incoming message if there was a brief pause between pieces; the review then found the fix had removed the only thing that told the code a message had finished arriving, so every network reply sat waiting for five seconds before completing.
files: packages/fret/src/rpc/protocols.ts, packages/fret/test/payload-bounds-ttl.spec.ts, packages/fret/test/libp2p-memory.integration.spec.ts, docs/fret.md, tickets/plan/8-rpc-shared-helper.md
----
### Outcome

`readAllBounded` (`packages/fret/src/rpc/protocols.ts`) reads a whole RPC message off a
stream. It used to stop reading after a 100ms gap between chunks, which truncated healthy
but slow transfers into malformed JSON and failure-scored the (healthy) sender — the
original bug.

The implement stage removed that 100ms idle timer on the documented premise that libp2p v3's
`close()` half-closes, so the reader would see a genuine end-of-stream instead. The review
found that premise does not hold here, and repaired the result: reads now end on the stream's
own end-of-read state rather than on either a time guess or an event that never arrives.

Final behaviour:

- A gap between chunks is a slow link, never end-of-stream. No idle timer.
- A read ends on iterator EOF, or on the stream reporting the remote finished writing and its
  read buffer drained.
- Exceeding the overall deadline (`timeoutMs`, 5s default) **throws** instead of returning the
  partial buffer, so a timeout is reported as a timeout rather than as malformed JSON.

### Review findings

**Major — fixed in this pass**

- *The implement change removed the only working end-of-stream signal.* libp2p's
  async-iterator adaptor ends iteration off the one-shot `remoteCloseWrite` / `close` events,
  which it subscribes to when iteration **starts**. Every FRET sender opens a stream, writes,
  closes, and only then begins reading — so a responder that replies quickly closes before
  that subscription exists and the event is lost forever. Verified directly with a two-node
  probe on both of this repo's transports (memory+plaintext and TCP+noise+yamux): the reply
  chunk arrives at +0ms, then `iter.next()` never resolves, while the stream itself already
  reports `readStatus=closed` / `remoteWriteStatus=closed`. So the deleted 100ms timer was
  load-bearing, and after the implement change **every** RPC read (ping, neighbors, maybeAct,
  leave) ran to the full 5000ms deadline before returning its already-buffered bytes.
  The test suite did not catch this because the old code treated deadline expiry as
  end-of-stream and silently returned the buffer — correct data, 50× the latency. Measured
  ping round-trip: ~5000ms after the implement change; ~30–50ms now.
  Fixed by polling the stream's own state (`readBufferLength` / `remoteWriteStatus` /
  `readStatus`) alongside the pending read, and ending only when the remote has closed **and**
  the buffer is drained. A merely-slow stream reports neither, so it is never truncated —
  the original bug stays fixed. Plain async iterables (tests, non-libp2p sources) expose no
  such state and fall back to ordinary iterator EOF, unchanged.

**Minor — fixed in this pass**

- *Deadline expiry silently returned a truncated buffer.* With the idle timer gone this was
  the only remaining path through the race, and it conflated "timed out" with "clean EOF":
  callers saw `Unexpected end of JSON input` and blamed the peer for corruption, which is the
  same misattribution this ticket exists to eliminate. Now throws
  `read timed out after Nms (N bytes read)`. All five `sendPing` call sites and every RPC
  handler already catch and handle a throw here, so failure accounting is unchanged.
- *A poll-driven loop must not re-issue `iter.next()`.* Caught while writing the fix: a second
  concurrent `next()` queues behind the first and silently drops whichever chunk the abandoned
  one consumes. The pending read is now held across poll ticks.
- *Stale comment.* `test/libp2p-memory.integration.spec.ts:12` still described the deleted
  idle-timeout workaround. Rewritten to describe the actual mechanism.
- *Docs did not match the code.* `docs/fret.md` claimed "Stream timeout: 30s default, 10s for
  ping"; no such value exists anywhere in `src/`. Replaced with the real contract (one overall
  read deadline, 5s default, no idle timer, throws rather than truncating) and why it is
  shaped that way.
- *Type laziness.* `IteratorResult<any>` in the race replaced with the real chunk type; the
  timeout sentinel is now a `Symbol` so a poll tick can never be mistaken for a real
  `IteratorResult`.
- *Unused import.* `PROTOCOL_LEAVE` in `payload-bounds-ttl.spec.ts`.

**Major — routed to an existing ticket, not re-filed**

- The root cause is architectural: FRET has no message framing, so the reader has to infer
  where a message ends from stream lifecycle events. `docs/fret.md` already specifies
  "length-prefixed UTF-8 JSON" for all four protocols; the implementation ships bare JSON.
  The site-claim check (`grep` over the board) showed `tickets/plan/8-rpc-shared-helper`
  already owns `packages/fret/src/rpc/*` including `protocols.ts`'s read race and the
  handler-side stream leaks. Per the architecture-first rule this is the same site, so an arm
  was appended there rather than a new point ticket: the shared request helper should either
  begin reading before writing (so the subscription always predates the response) or add the
  length prefix — either retires the whole class and lets the state poll be deleted.

**Tripwires — recorded at the code site, not filed**

- Inbound handlers now hold a stalled stream for the full `timeoutMs` (5s) instead of failing
  fast at ~100ms, bounded by the per-profile inbound stream caps (32 Edge / 128 Core).
  `NOTE:` on `readAllBounded` says to shorten the handler-side read deadline if slow-loris
  pressure ever appears — not to reintroduce an idle timer.
- The 20ms EOF poll puts a ~20ms floor under every measured RPC round-trip, and that number
  feeds `avgLatencyMs` peer health scoring. `NOTE:` on `EOF_POLL_MS` records the tradeoff and
  points at the durable fix.

**Checked, nothing found**

- All four `readAllBounded` call families (`ping.ts`, `neighbors.ts`, `maybe-act.ts`,
  `leave.ts`), both request and handler sides, read for the changed throw/return contract. No
  caller depended on the idle gap for early exit, and all five `sendPing` sites already wrap
  the call in `try`/`catch` with timeout-vs-unsupported-protocol handling intact — a thrown
  timeout still lands as `applyFailure` / `recordBackoff`, never as a foreign-network label.
- Handler error paths do not close or abort the stream (`maybe-act.ts:25`, `leave.ts:53`,
  `neighbors.ts:58`). Real, but pre-existing, outside this diff, and already itemised on
  `plan/8-rpc-shared-helper` as "handler error paths leak streams" — not re-filed.
- No pre-existing test failures surfaced, so no `tickets/.pre-existing-error.md` was written.

### Testing

- `readAllBounded` unit tests extended from one to five: the implement stage's >100ms-gap
  regression test, plus deadline-expiry-throws-on-a-stalled-peer, deadline-expiry-throws-
  rather-than-truncating-mid-stream, and clean-EOF-with-no-data-returns-empty (the deadline
  case was the implement stage's stated known gap).
- Added a real two-node libp2p round-trip guard asserting a ping completes in under 1s. This
  is the test that actually catches the major finding: it fails (≈5000ms) against the
  implement-stage code and passes (~50ms) now.
- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && yarn test` — 303 passing, 0 failing (was 299 before this pass; +4 new
  tests). An interim run with the timeout-throws change but before the EOF fix showed
  1 failing (`stops answering namespaced RPCs after stop()`, `read timed out after 5000ms
  (65 bytes read)`) — that failure is what exposed the major finding.
