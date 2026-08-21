description: Four small, low-risk tidy-ups landed in the RPC network-message code — dropped needless async, deduped protocol-id constants, stopped two handlers sending unread acknowledgement bytes, and made NUL-byte stripping in message decoding visible in logs instead of silent.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/request.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/ping.ts
difficulty: easy
----

## What changed

All four items from the implement ticket landed, confirmed against `git diff --stat`
(6 files, +32/-21 — exactly the `files:` list, nothing else touched):

1. **Needless async** — `encodeJson`/`decodeJson` (`protocols.ts`) dropped `async`; both were
   100%-synchronous bodies. Every `await encodeJson(`/`await decodeJson(` call site in
   production code lost its `await` to match: `protocols.ts` (inside `registerJsonHandler`,
   both overloads, ×4 call sites), `request.ts:148,177`, `neighbors.ts:115`, `maybe-act.ts`
   (×3), `ping.ts:93`. Test-only `await`s on these functions were deliberately left alone per
   the prior run's discovery — `await nonPromiseValue` is legal JS, no behavior change, not
   worth touching files outside `files:`.
2. **Duplicated protocol-id constants** — `PROTOCOL_NEIGHBORS` etc. (`protocols.ts:44-49`) now
   derive from `makeProtocols('default')` instead of restating the literal strings.
3. **Unread ok-true acknowledgements** — `registerLeave`'s success reply (`leave.ts:51`) and
   `registerNeighbors`'s announce-handler success reply (`neighbors.ts:78`) changed from
   `return { ok: true };` to `return undefined;`. `registerJsonHandler` already treats
   `undefined` as "drop without replying; seam still closes" (the existing identity-mismatch
   branch in both files already did this) — so both handlers' success and mismatch paths now
   return the same shape, and no reply bytes are sent for something neither `sendLeave` nor
   `announceNeighbors` ever reads.
4. **Silent NUL-byte stripping** — `decodeJson` (`protocols.ts`) now counts bytes stripped
   from either end during the interop-defensive trim that were specifically `0` (NUL), as
   opposed to ordinary whitespace (9/10/13/32). If any were stripped, one `log.error` fires
   after the loop, before `JSON.parse`, naming the count. Kept cheap: no byte dump, one log
   call per `decodeJson` invocation, trim behavior itself unchanged.

**Deviation from the ticket's literal wording**: the ticket said "call `log.warn`", but
`@libp2p/logger`'s `Logger` type (used throughout this codebase via `createLogger`) has no
`warn` method — only the base callable (debug-level) and `.error`. Every existing log call in
`fret-service.ts` uses `log.error` for exactly this kind of "notable but non-fatal" condition,
so this uses `log.error` too, for consistency with the rest of the codebase. Confirmed by
reading `node_modules/@libp2p/logger/dist/src/index.d.ts` — `Logger` re-exports `@libp2p/interface`'s
type, which is base-callable + `.error` only.

## Verification done

- `cd packages/fret && npx tsc --noEmit` — **clean, no errors.** This also exercises item 1's
  return-type change (`Promise<Uint8Array>` → `Uint8Array`, `Promise<T>` → `T`): every `decode`
  callback shape in `request.ts`/`validate.ts` (`(bytes) => T | Promise<T>`) already accepted a
  non-Promise return, confirmed rather than assumed.

## Gaps — not verified this run

**The full test suite (`yarn test`) was not run.** This run hit its token budget immediately
after the edits landed and typecheck passed; there was no budget left for a full test pass.
This is the single biggest gap for review to close before this ticket can be considered done:

- **Item 1 concern from the ticket's edge-case list, unverified**: confirm no caller relies on
  `encodeJson`/`decodeJson` returning a `Promise` via `Promise.all([...])` or `.then()`
  chaining. A grep across `src/` and `test/` for both names was done in a prior run's discovery
  (see the ticket's resume-note history) and found none, but that grep result was not
  re-verified against the final diff.
- **Item 3 concern, unverified**: `test/rpc.codec-properties.spec.ts` and
  `test/rpc.handler-fuzz.spec.ts` were flagged as likely asserting on `sendLeave`/
  `announceNeighbors` reply shapes or literal `{ok: true}` bodies. These were **not run** this
  session. If either asserts the old reply body, that is an expected/needed test update to
  match the new write-only contract — not a regression — but it has not been confirmed either
  way.
- **Item 4 concern, unverified**: the requirement that `log.error` fires only when a NUL byte
  specifically was stripped (never on ordinary whitespace-only padding) was implemented per the
  code (count only increments on byte `=== 0`, checked separately from the trim condition) but
  has **no test written or run** confirming both cases (whitespace-only: no log; NUL padding:
  one log call, `count` correct for a NUL at each end independently and both ends together).
- **Item 2 concern, unverified**: byte-identical string equality between the old literals and
  `makeProtocols('default')`'s output was not diffed programmatically — it's true by
  construction (same template literal, same `networkName` argument), but nothing exercised it
  at runtime this session.

## Suggested test to run first

```
cd packages/fret && yarn test
```

If anything fails, cross-check against the two spec files named above before treating it as a
regression — those are the files most likely to need an assertion updated to match item 3's new
write-only reply contract, which is expected, not a bug.

## Use cases / what to spot-check in review

- A leave notice and a neighbors-announce, sent and received between two real nodes (or via
  the existing two-node framed test), still complete normally with no reply bytes on the wire
  for the success path — only a stream close.
- A crafted/corrupted inbound message with NUL padding around the JSON body triggers exactly
  one `log.error` call and still parses successfully (trim behavior unchanged).
- A message with only ordinary whitespace padding (no NUL) produces no NUL-stripped log line.
