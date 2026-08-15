description: Fix a bug where the network code gives up reading a large incoming message if there is a brief pause between pieces, which corrupts genuinely-slow-but-healthy transfers and wrongly marks the sending peer as unreliable.
files: packages/fret/src/rpc/protocols.ts, packages/fret/test/payload-bounds-ttl.spec.ts
difficulty: easy
repro: static
----
`readAllBounded` (packages/fret/src/rpc/protocols.ts:67-109) enforces two separate limits while reading a chunked stream: an overall `deadline` (`timeoutMs`, caller-supplied, e.g. 5000ms) and a hardcoded 100ms **idle** gap between chunks (`idleMs = 100`, line 78). Once any data has arrived (`len > 0`), the per-iteration race timeout is `Math.min(remaining, idleMs)` (line 83) — so any 100ms+ gap between chunks is treated as end-of-stream, not just a real EOF. The truncated buffer then fails `JSON.parse` in `decodeJson`, the RPC call errors out, and the caller failure-scores the peer (see `docs/fret.md` health/relevance handling).

Call sites and their overall (non-idle) timeouts, none of which currently override idleMs (there is no override parameter):
- `ping.ts:63` — `readAllBounded(stream!, 1024)` (default 5000ms deadline)
- `maybe-act.ts:20,43` — up to `maxBytes` / 512 KiB (default 5000ms deadline)
- `neighbors.ts:41,78` — up to 128 KiB (default 5000ms deadline)
- `leave.ts:35` — 4096 bytes (default 5000ms deadline)

128-512 KiB snapshots/maybeAct payloads over relayed or congested links routinely arrive in bursts with >100ms gaps, so this idle gap — not the overall deadline — is the thing actually truncating healthy transfers.

The 100ms idle guard was originally a workaround for muxers that fail to propagate remote-close EOF (see comment at protocols.ts:76-77). Per `docs/fret.md`, libp2p v3's `close()` is a proper half-close, so end-of-stream now propagates cleanly through `iter.next()` resolving `{ done: true }` on its own — the idle-specific timer is redundant with, and narrower than, the overall `deadline` that's already enforced every iteration.

Expected behavior: a message whose chunks are spread more than 100ms apart, but which completes well within the overall per-call timeout, is read to completion and parses successfully. The sender is not failure-scored for slow-but-complete transport.

Recommended fix (in order of preference):
1. **Drop the idle-specific timer entirely.** Each iteration should race `iter.next()` against only the remaining overall `deadline` (the existing `remaining` value at line 81), removing `idleMs`/`chunkTimeout`'s idle branch (lines 78, 83). The overall deadline still bounds worst-case hang time; half-close makes `iter.next()` resolve on genuine EOF without a separate idle watchdog.
2. **If an idle guard is kept** (e.g. for defense against a muxer that doesn't propagate half-close), raise it to >=1000ms and make it an optional parameter on `readAllBounded` (e.g. `idleMs = 1000`) rather than a hardcoded local — callers can then override per-protocol if needed, but none currently need to.

Either way, `timeoutMs` (the overall deadline, param already exists) is unaffected and keeps bounding worst-case read time.

TODO:
- Reproduce first: add a test in `packages/fret/test/payload-bounds-ttl.spec.ts` under the existing `describe('readAllBounded', ...)` block — an async generator that yields a first chunk, awaits a delay >100ms (e.g. 150ms via `setTimeout`), then yields a second chunk and returns. Assert the result equals the concatenation of both chunks (confirms current code truncates — the test should fail against unpatched code, pass after the fix).
- Apply the fix per the "Recommended fix" section above (prefer option 1: drop the idle timer, keep the overall `deadline` race).
- Confirm the existing "rejects data exceeding limit" / "rejects multi-chunk data exceeding limit" tests still pass (they rely on the overall size cap, not idle timing).
- Run `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/payload-bounds-ttl.spec.ts" --timeout 30000` and the full `yarn test` to check for regressions elsewhere (RPC round-trip tests using `readAllBounded` transitively via ping/neighbors/maybe-act/leave).
- Type-check: `cd packages/fret && npx tsc --noEmit`.
