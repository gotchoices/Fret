description: A node that answers a network request can have its reply thrown away by the caller, which wrongly decides the sender stopped talking mid-message. The reply was sent and the connection was healthy. Fix the reader so a reply that was actually written is never reported as cut off.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/request.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, docs/fret.md
difficulty: hard
repro: verified
----

## The invariant to restore

**A frame the remote actually wrote is never reported to the caller as truncated.**

`readFramed` (`packages/fret/src/rpc/protocols.ts`) can raise `FrameTruncationError` on a healthy
connection carrying a complete reply. Fix it at the seam. Do not fix it by constraining handler
bodies.

## Root cause — a layering blind spot, confirmed against the libp2p source

`remoteFinishedWriting` (~line 379) asks the **stream** whether more bytes can arrive:

```ts
readBufferLength === 0 && (remoteWriteStatus === 'closed' || readStatus === 'closed')
```

`readFramed` then treats a `true` as proof that the **decoder** can no longer complete a frame.
Those are different questions, and there are *two* buffers between them. From
`node_modules/@libp2p/utils/dist/src/abstract-message-stream.js:81` — `[Symbol.asyncIterator]`
subscribes to `message` / `close` / `remoteCloseWrite` at iteration start and pushes each message
into an `it-pushable`:

```
stream.readBuffer --message event--> it-pushable --> lp.decode buffer --> our `pending`
        ^                                 ^                 ^
        |                                 |                 |
 only hop remoteFinishedWriting sees      +--- invisible ---+
```

Every byte that has left `readBuffer` but not yet resolved `pending` sits in a buffer
`remoteFinishedWriting` cannot see. Draining the microtasks — which the poll's macrotask delay was
supposed to guarantee — is exactly what *moves* bytes into that blind spot. So `readFramed`'s
"race-free because the poll fires on a macrotask" paragraph is false, and its own doc block states
the invariant the code violates.

A reply-only handler answers on stream *open*, so its bytes are typically already delivered before
the caller starts reading — which is why the buffered-bytes short-circuit (`readBufferLength > 0`),
not the close-status check, is what makes this path work at all when it works.

## Reproduction (verified this run, deterministic within a run)

Two `createMemNode`s, five reply-only protocols registered via `registerJsonHandler`, differing
only in how many `await`s the `serve` callback performs before returning; driven by `rpcRequest`,
6 calls per cell, crossed with a with-body / without-body axis. Measured outcomes:

| `serve` shape | no body | with body |
|---|---|---|
| `() => Promise.resolve(reply)` | ok | ok |
| `async () => reply` | ok | ok |
| 1 extra `await` | ok | ok |
| 2 extra `await`s | **decode-error** | ok |
| 4 extra `await`s | ok | **decode-error** |

6/6 identical per cell, repeatable within the run.

### The failing cell MOVES between runs — do not build a depth-indexed test

The ticket originally recorded "2 ticks fails, 1 passes"; the previous fix run measured
"1 fails, 2 and 4 pass"; this run measures "2 fails without a body, 4 fails with one". Same code,
same repro shape. **There is no threshold and no stable hole.** Microtask depth only shifts *where*
the poll tick lands relative to the buffer handoff; it is a phase alignment, not a monotone
quantity. Consequences for the implement work:

- Do not reason about "make the write happen sooner" or "raise the budget".
- **Do not ship a depth-sweep matrix as the regression test** — whichever depths you pick may all
  pass on the CI machine while the defect is untouched. A depth sweep is fine as a smoke test, but
  the load-bearing test must *force* the race deterministically (see below).

## Fix shapes, in preference order

### (a) Preferred — read frames at the same layer as the EOF check

libp2p ships `lpStream` / `byteStream` (`node_modules/@libp2p/utils/dist/src/stream-utils.js`),
which reads length-prefixed frames straight out of the stream's **own** `readBuffer` and applies
its EOF test at that same layer:

```js
function isEOF (obj) { return obj.remoteWriteStatus !== 'writable' && obj.readBufferLength === 0 }
```

No pushable, no second decoder buffer, no poll — the blind spot does not exist because there is
only one buffer. This *deletes* the layering violation rather than patching around it, and it also
retires `EOF_POLL_MS` and the RTT floor its `NOTE:` documents.

Costs to weigh and report honestly in the review handoff:

- `readFramed` also accepts plain async iterables (tests, non-libp2p sources) — see `ReadEndState`,
  every field optional. That path has no `readBuffer`, so it must keep an iterator-based
  implementation; the fix becomes two implementations behind one signature, chosen on whether the
  argument is a real `Stream`.
- The declared-length cap must still be raised at the prefix, before any body byte is pulled
  (`PayloadTooLargeError`, currently the `onLength` hook). `lpStream`'s own `maxDataLength` throws
  *before* consuming the prefix and cannot report the declared length — check whether its error can
  be mapped, or read the prefix through `byteStream` directly. `test/rpc.codec-properties.spec.ts`
  measures "an over-cap message costs only the prefix" by counting pulls; that measurement must
  still pass.
- `readFramed` and `sendFramed` are pinned public exports (`test/package-exports.spec.ts`). The
  signature must not change.

### (b) Account for bytes the decoder still holds

Keep the iterator pipeline, but stop `remoteFinishedWriting` being the terminal authority: track
bytes delivered into the decode pipeline against bytes accounted for by frames yielded, and refuse
to raise truncation while undelivered bytes could still complete a frame. Exact accounting needs
the declared length (available in `onLength`) plus the varint prefix width; before `onLength` has
fired the count is not exact, so this shape needs care not to trade a false truncation for a hang
on a genuinely truncated stream.

### (c) Last resort — grace tick after a positive poll

On a positive poll, race `pending` against one more short tick before raising. Cheapest, but it
re-introduces a timing argument, which is the class of bug this ticket exists to remove. Take it
only if (a) and (b) are both shown impractical, and say so explicitly in the handoff.

## Tests the fix must land

- **A forced-race seam test.** Deterministically drive the case rather than hoping a depth lands in
  the window: e.g. a stub stream whose `readBufferLength` reads 0 and `remoteWriteStatus` reads
  `'closed'` while a complete frame is still in flight through the pipeline, asserting `readFramed`
  returns the frame instead of throwing. This is the regression guard; site it at the seam.
- **A two-node smoke matrix** over pre-write microtask depth (0,1,2,4) crossed with
  with-body / without-body, asserting every cell returns `ok`. Skeleton is the repro above. Keep
  it, but treat it as a smoke test — its failing cell is not stable.
- **Restore the close-then-read shape.** `sendRaw` in `test/rpc.handler-fuzz.spec.ts` (~line 651)
  was narrowed to start its read before the half-close, and its comment documents this defect as a
  test-shape constraint. Once the invariant holds, restore the "sender fully closes before reading"
  shape and cover it. Delete the now-false comment.

## Documentation to bring in line

- `readFramed`'s "The check is race-free because the poll fires on a macrotask..." paragraph in
  `src/rpc/protocols.ts` — it asserts the invariant the code violates. Replace with what the fix
  actually guarantees.
- The `NOTE:` at `EOF_POLL_MS`, which names iterator priming as the durable fix. Priming makes the
  one-shot close event reliable but leaves the blind spot intact (on the failing path the bytes are
  already delivered) — it is a separate improvement, not this fix. Retire or re-scope the note.
- The two reply-only `NOTE:` blocks in `src/rpc/ping.ts` and `src/rpc/neighbors.ts` that point at
  this ticket — retire once the invariant holds.
- The *Stream management* bullet in `docs/fret.md`, which currently documents the 20 ms poll and
  its rationale.

## TODO

- Prototype fix shape (a); confirm the plain-async-iterable path and the `PayloadTooLargeError`
  at-the-prefix guarantee both survive. Fall back to (b), then (c), documenting why.
- Add the forced-race seam test; confirm it fails before the fix and passes after.
- Add the two-node depth-crossed-with-body smoke matrix.
- Restore the close-then-read shape in `sendRaw` and cover it; delete its stale comment.
- Update the four documentation sites above.
- `npx tsc --noEmit`, then `yarn test` from `packages/fret`.
