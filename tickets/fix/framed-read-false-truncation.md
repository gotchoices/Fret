description: A node that answers a network request after a couple of internal pauses has its reply thrown away by the caller, which wrongly decides the sender stopped talking mid-message. The reply was sent and the connection was healthy.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/request.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/churn.leave.spec.ts, docs/fret.md
difficulty: hard
repro: verified
----

## The invariant to restore

**A frame the remote actually wrote is never reported to the caller as truncated.**

Today that invariant does not hold. `readFramed` can conclude "the remote finished writing" while
the remote's reply bytes are still in flight, and raise `FrameTruncationError` on a healthy
connection carrying a complete reply. The trigger is how many microtasks elapse inside the inbound
handler between being invoked and its first write.

This ticket is the invariant, not the one handler that happened to expose it. Do not fix it by
constraining handler bodies.

## Root site

`packages/fret/src/rpc/protocols.ts`:

- `remoteFinishedWriting` (~line 379) — reports finished on
  `readBufferLength === 0 && (remoteWriteStatus === 'closed' || readStatus === 'closed')`.
- the `EOF_POLL_MS` (20 ms) poll loop inside `readFramed` (~lines 343–530), which calls it once
  per tick and turns a `true` into `FrameTruncationError`.

`readFramed`'s own doc block states the invariant that is being violated, and asserts it holds:

> The check is race-free because the poll fires on a macrotask at least one interval after any
> message dispatch, so every microtask behind it (stream iterator → `lp.decode` → the pending
> read) has already drained: if the stream reports its read closed [...] while the pending read is
> still unresolved, the bytes delivered could not complete a frame.

The reproduction below says that claim is false in at least one ordering. Whatever the fix, that
paragraph must end up describing what the code actually guarantees.

## Reproduction (verified, deterministic)

Two `createMemNode`s, three reply-only protocols registered through `registerJsonHandler`,
differing **only** in the shape of the `serve` callback, driven by `rpcRequest`. 6 calls per shape:

| reply-only `serve` shape | `rpcRequest` outcome |
|---|---|
| `() => Promise.resolve(reply)` (today's `registerPing` / `registerNeighbors`) | `ok` |
| `async () => reply` | `ok` |
| `async () => { await Promise.resolve(); await Promise.resolve(); return reply }` | `decode-error` (`FrameTruncationError`) |

So the threshold is **microtask depth before the first write**, not `async` versus a bare arrow,
and not `negotiateFully: false` (the theory in the original implement handoff, disproved here).
Two extra ticks is enough; one is not. The reply *is* written — the caller reads it as a truncated
frame.

**The margin is already partly spent by the seam itself.** `registerJsonHandler`'s reply-only arm
is `sendFramed(stream, await encodeJson(await opts.serve(connection)))` — `encodeJson` is async, so
there are already two awaits between handler invocation and the first write before a handler body
adds any. "Today's shapes pass" is therefore not a claim that the seam writes promptly; it is a
claim that the current total sits under the threshold. Any body-level await lands on an
already-loaded budget. A test that measures depth *excluding* the seam's own awaits will mis-site
the threshold.

## Why this is a latent defect and not a tripwire

Nothing in the seam's contract forbids a handler body from awaiting before it replies, and one
production path is one hop from doing so: `pingReply` awaits a caller-supplied
`getSizeEstimate` provider, and an async provider is a legal implementation of
`SizeEstimateProvider`. When it trips, every reply on that protocol is lost silently, on a healthy
connection.

## Three independent sightings of the same effect

1. **Churn spec.** Changing exactly one thing in `registerPing` (`serve: (connection) =>` →
   `serve: async (connection) =>`) turns *Leave amplification cap → the classification pass probes
   and promotes a replacement recorded by a leave* (`test/churn.leave.spec.ts:540`) from passing to
   failing on `pingsOk > 0`, in ~297 ms. The symptom follows exactly: `decode-error` is scored as
   proof of life (`noteAnsweredOnProtocol` → `membership: 'member'`) but never reaches
   `applySuccess`, so `pingsOk` stays 0 while the membership assertion still passes.
2. **The scratch spec** above.
3. **`sendRaw` in `test/rpc.handler-fuzz.spec.ts`** (~line 651). Its comment already documents the
   effect as a test-shape constraint rather than a bug: *"`readFramed` subscribes to the stream's
   one-shot close events when its iteration starts, so closing first can lose a reply from a
   handler that reads no request body (ping, the neighbors request) and therefore answers a few
   ticks later"*. The helper was narrowed to start the read before the half-close, which means the
   **"sender fully closes before reading"** shape is no longer exercised anywhere.

## What the fix must deliver

- The invariant above, at the seam. `remoteFinishedWriting` must not be able to answer "finished"
  for a stream whose peer has written bytes the caller has not yet seen — or `readFramed` must not
  treat that answer as terminal. The existing `NOTE:` at `EOF_POLL_MS` already names a candidate
  direction (subscribe to the stream *before* writing, so the one-shot close event is never missed
  and the poll stops being load-bearing); it is a candidate, not a mandate.
- **A direct test at the seam** that varies the responder's pre-write microtask depth (0, 1, 2, 4
  awaits) against a real two-node pair and asserts every call returns `ok`. The deleted scratch
  spec is the skeleton. This must fail at the seam rather than three subsystems away in a churn
  spec — that is the whole point of siting it here.
- **Restore the close-then-read shape.** Once the invariant holds, `sendRaw` should be able to
  fully close before reading again, and something must cover that shape.
- Once it holds, the two reply-only `NOTE:` blocks (`src/rpc/ping.ts`, `src/rpc/neighbors.ts`) that
  point at this ticket can be retired, and `readFramed`'s race-free paragraph in
  `src/rpc/protocols.ts` plus the *Stream management* bullet in `docs/fret.md` must be brought in
  line with whatever the fix actually guarantees.

---

## Fix-stage findings (this run) — re-sited the trigger

The ticket's reproduction reproduces, but **the stated trigger is wrong in two ways**. Both
findings came from a scratch spec (two `createMemNode`s, reply-only protocols registered via
`registerJsonHandler`, driven by `rpcRequest`, 6 calls per shape). Verified, deterministic,
repeatable across runs.

### Finding 1 — the effect is not monotone in microtask depth

Measured `rpcRequest` outcomes, 6/6 identical per shape:

| reply-only `serve` shape | outcome |
|---|---|
| `() => Promise.resolve(reply)` | `ok` |
| `async () => reply` | `ok` |
| `async () => { await Promise.resolve(); return reply }` (**1 tick**) | **`decode-error`** |
| `async () => { await Promise.resolve(); await Promise.resolve(); return reply }` (**2 ticks**) | `ok` |
| 4 ticks | `ok` |

So "two extra ticks is enough; one is not" is exactly inverted, and there is no *threshold* at
all — depth 1 is a **hole**, not a floor. Any fix reasoned about as "make the write happen sooner"
or "raise the budget" is reasoning about a monotone quantity that does not exist here. Do not
carry the ticket's threshold framing into the implement stage; it will mis-site the test matrix.

### Finding 2 — the caller-side precondition is *no request body*, not the handler shape

The failing calls pass **no `body`** to `rpcRequest` — the read-only request shape
(`fetchNeighbors`). With a body written before the read, the same shapes all pass. Traced stream
state confirms why the write matters and it is not about timing slack:

```
after open   readStatus=readable remoteWriteStatus=closed readBufferLength=18
after write  readStatus=readable remoteWriteStatus=closed readBufferLength=18
after decode readStatus=readable remoteWriteStatus=closed readBufferLength=18
after next() readStatus=readable remoteWriteStatus=closed readBufferLength=18
RESOLVED     done=false len=17   readStatus=closed  readBufferLength=0
```

A reply-only handler answers on stream *open*, so by the time the caller reaches its read the
reply's 18 bytes are **already sitting in `readBufferLength`** and `remoteWriteStatus` is already
`'closed'`. `remoteFinishedWriting` is therefore correct on this path only because
`readBufferLength > 0` short-circuits it — the buffered-bytes guard, not the close-status guard,
is what is load-bearing. The defect is the window in which `readBufferLength` has already been
drained into `lp.decode`'s own internal buffer while `pending` has not yet resolved: the bytes
exist, but they are in the *decoder*, invisible to `remoteFinishedWriting`, which sees an empty
stream buffer plus a closed remote and reports "finished".

**That is the root cause, and it is a layering bug, not a race:** `remoteFinishedWriting` asks the
*stream* whether more bytes can arrive, and answers a question about whether the *decoder* can
still complete a frame. Those differ by exactly one buffer. The `readFramed` doc block's
"race-free because the poll fires on a macrotask ... every microtask behind it has already
drained" is false for the same reason — draining the microtasks is what *moves* the bytes into the
blind spot.

### What this changes for the fix

- The candidate direction named in the existing `NOTE:` at `EOF_POLL_MS` (subscribe before
  writing / prime the iterator) does **not** address this: the bytes are already delivered on the
  failing path. Priming makes the one-shot close event reliable, which is a separate real
  improvement, but it leaves the decoder-buffer blind spot intact.
- The invariant is restored by making the finished check account for bytes the decoder still
  holds — i.e. `readFramed` must not treat a `remoteFinishedWriting()` of `true` as terminal while
  its own `pending` read could still be satisfied from already-delivered bytes. Concretely: after
  a positive poll, yield once more (or await `pending` against a one-tick grace) and only then
  raise `FrameTruncationError`, or track delivered-vs-consumed byte counts across the `lp.decode`
  boundary instead of consulting `readBufferLength` alone.
- The direct seam test must vary depth **0,1,2,4** *and* the with-body / without-body axis, and
  assert `ok` on every cell. A depth-only matrix passes at depth 2 and misses the hole at 1; a
  with-body-only matrix passes everywhere.
- `packages/fret/src/rpc/request.ts` is now a named file for this ticket: the no-body branch
  (`opts.body === undefined` → straight to `readFramed`) is the caller-side half of the repro.

## Remaining work (not done this run — budget)

- Confirm whether the same hole reproduces with a body-reading handler when the *responder*
  half-closes before the caller reads (the `sendRaw` close-then-read shape at
  `test/rpc.handler-fuzz.spec.ts:651`). Expected yes, same blind spot.
- Decide between the two fix shapes above (grace-tick vs. delivered-byte accounting) and write the
  implement ticket. The grace-tick shape is cheaper but re-introduces a timing argument, which is
  what this ticket exists to eliminate; prefer the accounting shape unless it cannot be expressed
  against `lp.decode`'s surface.
- The scratch specs used here were deleted rather than committed; the implement ticket's seam test
  is their permanent home.
