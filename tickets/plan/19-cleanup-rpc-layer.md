----
description: A set of small, low-risk tidy-ups in the network-message code: dropping needless async, deriving duplicated constants, removing unsafe non-null assertions and unread acknowledgements, and turning a silent data-cleanup step into one that surfaces framing bugs.
files: packages/fret/src/rpc/*
difficulty: easy
----
Mechanical cleanups in the rpc directory that carry no behavior risk on their own:

- The JSON encode and decode helpers are marked async but do no async work; make them synchronous.
- The back-compat protocol-id constants hand-duplicate what the default-network protocol builder already produces; derive them from it instead of restating the strings.
- The stream non-null assertions can be removed by overloading the stream-open helper on its require-existing flag so the type reflects when a stream is guaranteed.
- The ok-true acknowledgements written by the leave and announce paths are never read by the sender; either read them or stop sending the wasted bytes.
- The decoder silently strips NUL bytes, which hides a framing bug; log when a non-whitespace byte is stripped so real framing errors are visible.

Expected behavior: the same wire behavior with less duplication, safer types, no wasted acknowledgement bytes, and a visible signal when the decoder has to strip unexpected bytes.

References: review RPC-section "Mechanical cleanups" (rpc/* various).

Note added while tending (2026-08-18): sequenced after `rpc-shared-helper` — see the 2026-08-21
resume-note below, which confirms that prereq landed and re-verifies each item against current code.

<!-- resume-note (2026-08-21): prereq confirmed landed; 4/5 items re-verified against current
code; item 3 not yet located; item 4's fix depends on one unverified assumption. No code edited
this run — stopped by BUDGET_WARNING before implement handoff. -->

**Prereq status: `rpc-shared-helper` fully landed.** It was split into `15.1-rpc-length-prefix-framing`,
`15.2-rpc-request-helper`, `15.3-rpc-message-validators` (see `git show d0e90df`), which further
split into `15.2a3-rpc-request-seam`, `15.31/15.32/15.33-*` etc. — all now sitting in
`tickets/complete/`. The consolidation (`rpcRequest` in `request.ts`, `registerRpcHandler` /
`registerJsonHandler` in `protocols.ts`, the wire-shape parsers in `validate.ts`) is in place and
stable. The directory was **not** halved as the old note feared/hoped — it's `protocols.ts` (721
lines), `request.ts` (296), `validate.ts` (403), plus `leave.ts`/`maybe-act.ts`/`neighbors.ts`/
`outcome.ts`/`ping.ts` (1838 lines total across all 8 files). All five original cleanup items still
apply; they just live at slightly different call sites than when this ticket was first filed.

Re-verified against current code (2026-08-21):

1. **Needless async — confirmed, unchanged.** `encodeJson` / `decodeJson` (`protocols.ts:249,254`)
   are both `async function` but their bodies are 100% synchronous (`JSON.stringify`/`parse`,
   `TextEncoder`/`TextDecoder`). Fix: drop `async` from both signatures (return type becomes
   non-`Promise`). Call sites (`request.ts`, `protocols.ts`, `neighbors.ts:115`, `maybe-act.ts:55`,
   `ping.ts:93`, all pattern `await decodeJson(...)` / inside `encodeJson(...)`) don't strictly
   need to change (`await` on a non-promise is legal and resolves immediately), but should have the
   now-pointless `await` stripped for the same reason this ticket exists.

2. **Duplicated protocol-id constants — confirmed, unchanged.** `protocols.ts:44-48`
   (`PROTOCOL_NEIGHBORS` etc., the "Backward compatibility: default export uses 'default' network"
   block) hand-restates the exact strings `makeProtocols('default')` (`protocols.ts:29-38`) already
   produces. Fix: `const defaultProtocols = makeProtocols('default');` then export each constant
   from it instead of a literal template string.

3. **Stream non-null assertions — NOT YET LOCATED.** Investigation stopped before finding the
   "stream-open helper" call sites this item refers to. `openRpcStream` (`protocols.ts:654`) is the
   likely target — it's the one seam every outbound RPC funnels through (per docs/fret.md
   *Dialability*) — but no sender body's non-null assertion (`!`) was actually found and read this
   run. Next step: `grep -n "!\." packages/fret/src/rpc/*.ts` and `grep -n "openRpcStream(" -r
   packages/fret/src` to find where a caller asserts a stream is non-null after opening it with a
   "require existing connection" flag (candidate: `fetchNeighbors`'s `dial: 'never'` in
   `request.ts`/`neighbors.ts:113`, or something similar in `request.ts`'s `rpcRequest` internals).
   Design direction per original wording: overload the stream-open helper on its require-existing
   boolean so the *type* reflects guaranteed-non-undefined vs possibly-undefined, e.g.
   `open(requireExisting: true): Promise<Stream>` vs `open(requireExisting: false): Promise<Stream |
   undefined>` — but confirm this against whatever the actual call sites turn out to be; this item
   is not fully resolved and needs a look before it can go to implement/.

4. **Unread ok-true acknowledgements — confirmed, but the fix has one unverified precondition.**
   Both `registerLeave`'s success reply (`leave.ts:51`, `return { ok: true };`) and
   `registerNeighbors`'s announce-handler success reply (`neighbors.ts:78`, `return { ok: true
   };`) are written but never read: their senders (`sendLeave`, `leave.ts:56-65`; `announceNeighbors`,
   `neighbors.ts:128-143`) both call `rpcRequest` with no `decode` option, i.e. write-only, matching
   docs/fret.md *Stream management*: "`sendLeave`'s and `announceNeighbors`'s `ok` means 'written',
   not 'received': a stated gap at the seam, parked with the leave-authentication work." That doc
   note treats the write-only-ness as an accepted, deliberate tradeoff (reading a reply would add a
   round trip inside the 3s `SHUTDOWN_BUDGET_MS` leave fan-out, and `registerLeave` already commits
   to replying before its rate-limit bucket is taken) — so **"stop sending the wasted bytes" is the
   right arm, not "read them."** Fix: change both `return { ok: true };` lines to `return undefined;`.
   **Unverified precondition:** both handlers already return `undefined` on their identity-mismatch
   branch, and the surrounding comment says that's read by the seam as "a normal outcome, not a
   failure, so the seam closes and never aborts" — but that comment was written about the
   identity-mismatch (reject) path specifically. Before making this change, read
   `registerJsonHandler`'s handling of an `undefined` `serve` result in `protocols.ts` to confirm it
   behaves identically on what is otherwise a *success* path (message accepted, notice/snapshot
   applied) — i.e. that skipping the reply doesn't skip anything else (like the seam's budgeted
   `close()` that's supposed to run regardless, per docs/fret.md's *Inbound handlers release their
   stream on every path*).

5. **Decoder silently strips NUL bytes — confirmed, unchanged, fix designed but unimplemented.**
   `decodeJson` (`protocols.ts:254-269`) trims bytes valued 0 (NUL), 9 (tab), 10 (LF), 13 (CR), 32
   (space) from both ends before `JSON.parse`, with no distinction between ordinary
   whitespace-padding (interop-defensive, expected — see docs/fret.md wire-formats section) and NUL
   bytes specifically, which this ticket treats as a framing-bug smell worth surfacing. Fix: while
   trimming, track whether any byte stripped from either end was specifically `0` (as opposed to
   9/10/13/32); if so, call `log.warn` once per `decodeJson` invocation (module already has `const
   log = createLogger('rpc:handler')` at `protocols.ts:15`) noting how many NUL bytes were stripped.
   Keep the trim itself unchanged — parsing still succeeds — this is visibility-only, matching "log
   when a non-whitespace byte is stripped" rather than "reject the message."

**Remaining TODO before this can go to implement/:**
- [ ] Locate item 3's actual call sites (grep starting points above) and confirm/adjust the overload design.
- [ ] Read `registerJsonHandler`'s `undefined`-serve-result handling in `protocols.ts` to confirm item 4's fix is safe on the success path, not just the reject path.
- [ ] Once both are confirmed, this ticket has no remaining open design question and should move to `tickets/implement/` as one ticket (all five items are small, same-directory, same-risk-class — no need to split).

