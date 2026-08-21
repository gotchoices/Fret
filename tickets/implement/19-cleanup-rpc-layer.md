description: A set of small, low-risk tidy-ups in the network-message code: dropping needless async, deriving duplicated constants, and turning a silent data-cleanup step into one that surfaces framing bugs, plus stopping two handlers from sending acknowledgement bytes nobody reads.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/request.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/ping.ts
difficulty: easy
----
<!-- resume-note -->
Second run (2026-08-21) again hit its token budget right after finishing discovery — **still zero
edits made** — but this run completed the one item the first run left outstanding, so the next
agent can go straight to editing with no further grepping needed.

For item 1 (needless async), every `await encodeJson(`/`await decodeJson(` call site in
`packages/fret` (grepped with `(await\s+)?(encodeJson|decodeJson)\(` over the whole package, plus
a separate check that `src/index.ts` has no matches at all):

Production (must lose their `await`, alongside dropping `async` from the two functions'
signatures at `protocols.ts:249,254`):
- `protocols.ts:208` — `sendFramed(stream, await encodeJson(await opts.serve(connection)));` (reply-only branch of `registerJsonHandler`)
- `protocols.ts:215` — `decoded = await decodeJson(bytes);` (request branch of `registerJsonHandler`)
- `protocols.ts:230` — `sendFramed(stream, await encodeJson(res));` (request branch of `registerJsonHandler`)
- `request.ts:148` — `writeBody`: `const hasRoom = sendFramed(stream, await encodeJson(body));`
- `request.ts:177` — `decodeReply`: `parsed = await decodeJson(bytes);`
- `neighbors.ts:115` — `fetchNeighbors`'s `decode`: `parseOrThrow(parse, await decodeJson(b))`
- `maybe-act.ts:28` — `registerMaybeAct`: `const msg = await decodeJson<RouteAndMaybeActV1>(bytes);`
- `maybe-act.ts:30` — `registerMaybeAct`: `sendFramed(stream, await encodeJson(res));`
- `maybe-act.ts:55` — `sendMaybeAct`'s `decode`: `parseOrThrow(parseMaybeActReply, await decodeJson(b))`
- `ping.ts:93` — `sendPing`'s `decode`: `parseOrThrow(parsePingResponse, await decodeJson(b))`
- `leave.ts` — **no direct calls**; `registerLeave`/`sendLeave` only go through `registerJsonHandler`/`rpcRequest`.

Test-only (found by the wider grep, all under `test/`): `test/helpers/maintenance-rig.ts:118,121`,
`test/ring-membership.spec.ts:688`, `test/rpc.handler-fuzz.spec.ts:322,1203,1209`, and ~20 sites in
`test/rpc.codec-properties.spec.ts`. **None of these need editing for correctness** —
`await nonPromiseValue` is legal JS and just resolves immediately, so once `encodeJson`/`decodeJson`
return plain values instead of Promises these call sites keep working unchanged. Leave the test
`await`s in place; stripping them would be a cosmetic-only touch of files outside `files:` and is
not worth the diff. `src/index.ts` re-exports neither function, so nothing there to check.

After the async change, the return types change from `Promise<Uint8Array>`/`Promise<T>` to
`Uint8Array`/`T` — check the `Parser`/`decode` callback types in `validate.ts` and `request.ts`
(`RpcRequestOptions.decode: (bytes: Uint8Array) => T | Promise<T>`) still accept a non-Promise
return with no signature change needed (they already union in the non-Promise case, so this should
be a no-op, but confirm with `tsc`).

Discovery for items 2-4 (from the first run, still valid, still nothing drifted) is unchanged —
see the item descriptions below, which are ready to implement exactly as written.

Mechanical cleanups in the rpc directory, fully re-verified against current code
(post `rpc-shared-helper` consolidation) on 2026-08-21. Four items — the original ticket's item 3
(stream non-null assertions) was investigated and dropped: `openRpcStream` already returns
`Stream | undefined` and its one caller (`rpcRequest`, `request.ts:259-263`) already does a plain
`if (stream == null) return { kind: 'skipped' }`, no assertion exists to remove.

1. **Needless async.** `encodeJson` / `decodeJson` (`protocols.ts:249,254`) are both `async
   function` but their bodies are 100% synchronous (`JSON.stringify`/`parse`,
   `TextEncoder`/`TextDecoder`). Drop `async` from both signatures (return type becomes
   non-`Promise`). Strip the now-pointless `await` from every call site: `request.ts`,
   `protocols.ts` (including inside `registerJsonHandler`), `neighbors.ts:115`, `maybe-act.ts:55`,
   `ping.ts:93`, and anywhere else matching `await decodeJson(` / `await encodeJson(`.

2. **Duplicated protocol-id constants.** `protocols.ts:44-48` (the "Backward compatibility:
   default export uses 'default' network" block, `PROTOCOL_NEIGHBORS` etc.) hand-restates the
   exact strings `makeProtocols('default')` (`protocols.ts:29-38`) already produces. Fix:
   `const defaultProtocols = makeProtocols('default');` then export each constant from it instead
   of a literal template string.

3. **Unread ok-true acknowledgements.** Both `registerLeave`'s success reply (`leave.ts:51`,
   `return { ok: true };`) and `registerNeighbors`'s announce-handler success reply
   (`neighbors.ts:78`, `return { ok: true };`) are written but never read: their senders
   (`sendLeave`, `announceNeighbors`) both call `rpcRequest` with no `decode` option — write-only,
   per docs/fret.md *Stream management* ("`sendLeave`'s and `announceNeighbors`'s `ok` means
   'written', not 'received'" — a stated, accepted gap, parked with the leave-authentication work).
   So the right arm is "stop sending the wasted bytes", not "read them". Change both
   `return { ok: true };` lines to `return undefined;`.
   - **Verified safe** (2026-08-21): `registerRpcHandler` (`protocols.ts:116-149`) runs its
     budgeted `stream.close()` unconditionally after `serve` returns, regardless of whether
     `registerJsonHandler`'s inner callback (`protocols.ts:200-232`) sent a reply or returned
     early at the `res === undefined` check (line 229, "Drop without replying; the seam still
     closes."). Skipping the reply body never skips the seam's own stream release — confirmed by
     reading the code, not inferred from the comment. No wire-behavior change beyond the removed
     bytes: the seam already drops on `undefined` for the pre-existing identity-mismatch branch;
     this just makes the success branch return the same shape.

4. **Decoder silently strips NUL bytes.** `decodeJson` (`protocols.ts:254-269`) trims bytes valued
   0 (NUL), 9 (tab), 10 (LF), 13 (CR), 32 (space) from both ends before `JSON.parse`, with no
   distinction between ordinary whitespace-padding (interop-defensive, expected — see docs/fret.md
   wire-formats section) and NUL bytes specifically, which are a framing-bug smell worth
   surfacing. Fix: while trimming, track whether any byte stripped from either end was
   specifically `0` (as opposed to 9/10/13/32); if so, call `log.warn` once per `decodeJson`
   invocation (module already has `const log = createLogger('rpc:handler')` at `protocols.ts:15`)
   noting how many NUL bytes were stripped. Keep the trim itself unchanged — parsing still
   succeeds — this is visibility-only, matching "log when a non-whitespace byte is stripped"
   rather than "reject the message".

Expected behavior: identical wire behavior, less duplication, no wasted acknowledgement bytes, and
a visible signal (log line) when the decoder has to strip unexpected NUL bytes.

## Edge cases & interactions

- Item 1: confirm no caller relies on `encodeJson`/`decodeJson` returning a `Promise` (e.g.
  `Promise.all([...])` over a list of encode/decode calls, or `.then()` chaining) — grep for both
  names across `packages/fret/src` and `test/`, not just the five call sites named above.
- Item 2: `makeProtocols('default')` must produce byte-identical strings to the current literals —
  diff the old constant values against the new derived ones before deleting the literals (a wire
  protocol-id typo silently breaks negotiation with every peer, it does not throw).
- Item 3: `test/rpc.codec-properties.spec.ts` and `test/rpc.handler-fuzz.spec.ts` likely assert on
  `sendLeave`/`announceNeighbors` reply shapes or on `registerLeave`/`registerNeighbors` behavior —
  check both still pass; a test asserting the literal `{ok: true}` reply body needs updating to
  match the new write-only contract, not treated as a regression.
- Item 3: the identity-mismatch branch in both handlers already returns `undefined` today — after
  this change both branches (success and mismatch) return the same shape, so confirm no caller
  distinguishes them by reply content (it shouldn't; both are write-only and neither is read).
- Item 4: the new `log.warn` must fire only when a NUL byte specifically was stripped, not on
  ordinary whitespace padding — test both cases (whitespace-only padding: no warning; NUL padding:
  one warning) so an interop-legitimate padded message doesn't spam the log.
- Item 4: `decodeJson` is called on every inbound message across all five protocols — a warning
  path that throws or is unbounded (e.g. logging full byte content) would be its own new bug on
  the hot path. Keep it cheap: count stripped NUL bytes, one `log.warn` call, no byte dump.

TODO:
- Item 1: needless async
- Item 2: derive protocol-id constants from `makeProtocols('default')`
- Item 3: stop sending unread ok-true acknowledgements (leave.ts, neighbors.ts)
- Item 4: log when decodeJson strips NUL bytes specifically
- Run `cd packages/fret && npx tsc --noEmit` and `yarn test`
