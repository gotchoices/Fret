description: A node that receives a message it cannot read now quietly closes the connection instead of replying with an empty, useless routing hint — matching how it already handles unreadable messages on its other four protocols. The code change is reviewed and looks right; the test run and two open judgement calls still need finishing.
prereq: rejection-diagnostics-conflated
files: packages/fret/src/rpc/maybe-act.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/rpc.handler-fuzz.wire.spec.ts, docs/fret.md
difficulty: medium
---

<!-- resume-note -->
A prior review run was cut short by a token-budget warning after reading the implement diff
(`9285e95`) and the current `src/rpc/maybe-act.ts`, but **before** running lint/tests or resolving
the two open judgement calls. No code was changed by that run — the working tree is exactly what
`9285e95` left. Resume from *What is still open* below; do not re-read the whole diff, the summary
of it here is accurate.

## What the change is

One behavior change plus its tests and doc text. `registerMaybeAct`'s `catch` arm around
`decodeJson` no longer writes a reply: it keeps `log.error`, keeps `onMalformed?.()`, and returns
bare so the seam (`registerRpcHandler`) performs its own budgeted `close()`. The deleted line
answered every undecodable body with a static empty `NearAnchorV1`.

The stated reason is metering: `decodeJson` runs in the handler body, **upstream** of the maybeAct
token bucket taken inside `handleMaybeAct`, so a reply from this arm costs the sender no token —
one free reply frame per undecodable message. The cheap-guard rejections that *do* answer run
**after** the bucket and are therefore metered. Metered → answer; unmetered → drop.

## What the interrupted run already checked

- Read the implement-stage diff (`git show 9285e95`) with fresh eyes before the handoff summary.
- Read `packages/fret/src/rpc/maybe-act.ts` in full at HEAD. The catch arm is as described; no
  `close()` in the body (correct — a body close would pre-empt the seam's budgeted one); the bare
  `return` is the right shape. The now-unused-looking imports are in fact still used:
  `sendFramed` / `encodeJson` on the success path at the end of the handler body, `NearAnchorV1`
  in `handle`'s return type. No dead import was left behind.
- Confirmed the two spec files' diffs are consistent with the source change: both
  release-accounting cases flipped to `{ closes: 1, aborts: 0 }` with `sends === 0` asserted on
  both (previously only on the not-JSON case), and the four maybeAct rows in `malformedMatrix()`
  moved to `expect: 'drop'` **with** `counts: 'malformed'` added — the `counts` half is required,
  since `runMatrix` tallies the `malformed` delta against the rows declaring it.

Nothing was found wrong in the parts read. No finding was fixed, filed, or parked.

## What is still open

- **Run the gate.** `cd packages/fret && npx tsc --noEmit`, then
  `yarn workspace p2p-fret test` (or the two fuzz specs directly first). There is no lint step in
  this repo — `yarn check` (typecheck + build + test) is the gate, and `yarn format` must not be
  run (see AGENTS.md). Tests must pass; the handoff claims 1220 passing / 0 failing over ~7m and
  that no pre-existing failure surfaced, which is unverified here.
- **Verify the unmetered-amplification claim by reading the two call sites**, not by trusting the
  handoff. The whole direction rests on `decodeJson` sitting ahead of the token bucket taken inside
  `handleMaybeAct` (`src/service/fret-service.ts`, `handleMaybeAct` ~1100). Read both and confirm
  the ordering.
- **Decide the coverage gap the implementer named and left open.** There is a test pinning the
  *positive* half (a malformed-but-decodable message spends a token — "the validator is not an
  unmetered pre-filter", in `rpc.handler-fuzz.spec.ts`), but **nothing pins the negative half**:
  no test asserts an *undecodable* body spends no token. It is testable — drive an undecodable
  body and read `diag.rejected.rateLimited.maybeAct`. This is a minor finding at the same site as
  the diff, so the review pass should fix it inline rather than file it.
- **Decide `RowExpect`'s `'abort'` variant**, now used by zero rows in
  `rpc.handler-fuzz.wire.spec.ts`. The implementer kept it deliberately and wrote the reason into
  its doc comment (a payload *string* cannot drive a framing failure; those come out of
  `readFramed`, above anything `sendRaw` can express). Either accept that as written, add a row
  that drives a real truncated frame, or delete the variant — but say which and why.
- **Check the wire-visible contract change independently.** A peer sending an undecodable maybeAct
  body now gets EOF instead of a frame. The claim is that `sendMaybeAct` maps that EOF to
  `decode-error` via `isFrameTruncationError`, which is proof of life and **not** a contact strike,
  so the peer stays membership-confirmed and is not escalated toward `dead`. That was reasoned
  from `noteRpcFailure`'s classification rather than driven end-to-end — worth an independent read
  of `noteRpcFailure`.
- **Confirm the doc edit reflects reality.** `docs/fret.md`, *Stream management* →
  `registerJsonHandler` two-tier paragraph, now distinguishes *sitting on `registerJsonHandler`*
  (four handlers) from *following the two-tier rule* (all five). Prose only — no wire format,
  determinism edition, byte-format vector, golden fixture, or migration is involved.

## Known unrelated observation (do not file)

`packages/fret/test/rpc.handler-fuzz.wire.spec.ts:6` imports `json` from `./helpers/rpc-fuzz.js`
and never uses it. Pre-existing — the wire spec has no `json(...)` call site before or after this
ticket (the `{ not: json }` occurrences are payload *strings*), and `noUnusedLocals` is not set in
`packages/fret/tsconfig.json`, so `tsc` stays silent. Trivial to delete if the reviewer wants it
gone; outside this ticket's diff either way.

## Coordination

`rejection-diagnostics-conflated` is the prereq and was still in `implement/` when this landed. Its
steps edit `rpc.handler-fuzz.spec.ts` at the `:1184` `rateLimited` sum site; this ticket edited the
`:210`–`:235` release-accounting block. Different regions of the same file — no textual conflict
was observed, but expect a rebase.

`71be306`'s source change was **not** reverted; only its unmetered reply was removed, which is what
the fix ticket directed.
