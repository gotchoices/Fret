description: Fixed a bug where the network code gave up reading a large incoming message if there was a brief pause between pieces, which corrupted genuinely-slow-but-healthy transfers and wrongly marked the sending peer as unreliable.
files: packages/fret/src/rpc/protocols.ts, packages/fret/test/payload-bounds-ttl.spec.ts
----
### What changed

`readAllBounded` (`packages/fret/src/rpc/protocols.ts`) had two competing timeouts while
reading a chunked stream: the caller-supplied overall `deadline` (`timeoutMs`, default
5000ms) and a hardcoded 100ms **idle** gap between chunks. Once any data had arrived, each
loop iteration raced `iter.next()` against `Math.min(remaining, idleMs)` — so any >100ms gap
between chunks was treated as end-of-stream, truncating the buffer. The truncated buffer then
failed `JSON.parse` in `decodeJson`, the RPC call errored, and the caller failure-scored the
sending peer even though the peer was healthy and eventually finished within the real deadline.

Applied recommended fix option 1 from the ticket: dropped the idle-specific timer entirely.
Each iteration now races `iter.next()` against only the remaining overall `deadline`. Per
`docs/fret.md`, libp2p v3's `close()` is a proper half-close, so `iter.next()` resolves
`{ done: true }` on genuine EOF without needing a separate idle watchdog. `timeoutMs` (the
overall deadline) is unchanged and still bounds worst-case hang time.

### Testing done

- Added a regression test in `packages/fret/test/payload-bounds-ttl.spec.ts` under the
  `readAllBounded` describe block: an async generator yields a first chunk, awaits a 150ms
  delay, yields a second chunk, and returns. Asserts the result is the full concatenation.
  This test fails against the pre-fix code (truncates after ~100ms) and passes after the fix.
- Confirmed the existing "rejects data exceeding limit" / "rejects multi-chunk data exceeding
  limit" tests still pass — they rely on the overall size cap (`maxBytes`), not idle timing,
  so removing the idle timer doesn't affect them.
- `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/payload-bounds-ttl.spec.ts" --timeout 30000` — 15/15 passing.
- `cd packages/fret && yarn test` (full suite) — 299/299 passing, 0 failing.
- `cd packages/fret && npx tsc --noEmit` — clean, no errors.

### Use cases for validation / review focus

- Verify no other caller of `readAllBounded` (`ping.ts`, `maybe-act.ts`, `neighbors.ts`,
  `leave.ts`) relied on the idle gap for early-exit behavior — per the ticket's own survey,
  none currently override or depend on `idleMs`, and none needed changes for this fix.
- Worth double-checking there isn't a live libp2p muxer in this codebase's dependency set that
  still fails to propagate half-close EOF (the idle timer's original justification, per the
  comment at the old line 76-77 and the `docs/fret.md` claim that v3's `close()` half-closes
  properly). If such a muxer exists, a stream reading a payload that legitimately never
  reaches EOF (buggy/malicious peer that stops sending mid-payload without closing) would now
  hang for the full `timeoutMs` (default 5000ms) instead of failing fast at ~100ms after last
  data. This is bounded (still resolves at the deadline) but is a behavior change worth a
  reviewer's eyes — I did not audit the muxer stack for this, only relied on the ticket's and
  `docs/fret.md`'s existing claim that half-close propagation is reliable in this codebase's
  libp2p v3 setup.
- No changes made to `idleMs` as an overridable parameter (ticket's fallback option 2) since
  option 1 (drop entirely) was preferred and applied cleanly.

### Known gaps

- Did not add a test for the "peer legitimately never closes and never sends more data" case
  (i.e. confirming the full `timeoutMs` deadline still fires) — the existing size-cap tests
  and the new gap test cover the changed code path; the deadline-still-enforced behavior was
  unchanged by this fix and wasn't specifically re-verified with a new test, only by code
  inspection (the `remaining <= 0` break condition is untouched).
