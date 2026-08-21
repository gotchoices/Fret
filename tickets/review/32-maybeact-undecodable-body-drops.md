description: A node that receives a message it cannot read now quietly closes the connection instead of replying with an empty, useless routing hint — matching how it already handles unreadable messages on its other four protocols. The reasoning and the tests are done; the test suite still needs one run, and two small judgement calls need settling.
prereq: rejection-diagnostics-conflated
files: packages/fret/src/rpc/maybe-act.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/rpc.handler-fuzz.wire.spec.ts, packages/fret/test/helpers/rpc-fuzz.ts, docs/fret.md
difficulty: easy
---

<!-- resume-note -->
Four prior review runs were cut short by a token-budget warning. Run four **wrote the missing
test** (below) and type-checked it clean. Everything under *Verified* and *Done in run four* is
settled — do not re-read the implement diff, do not re-derive the claims, do not redesign the
test. Resume at *What is still open*: run the suite once, settle two small judgement calls, write
the `complete/` ticket.

## What the change is

One behavior change plus its tests and doc text. `registerMaybeAct`'s `catch` arm around
`decodeJson` no longer writes a reply: it keeps `log.error`, keeps `onMalformed?.()`, and returns
bare so the seam (`registerRpcHandler`) performs its own budgeted `close()`. The deleted line
answered every undecodable body with a static empty `NearAnchorV1`.

Reason is metering: `decodeJson` runs in the handler body, **upstream** of the maybeAct token
bucket taken inside `handleMaybeAct`, so a reply from this arm costs the sender no token — one
free reply frame per undecodable message. The cheap-guard rejections that *do* answer run **after**
the bucket and are therefore metered. Metered → answer; unmetered → drop.

## Verified (read at HEAD, not taken from the handoff)

- **The source arm is the right shape.** `src/rpc/maybe-act.ts` catch arm: `log.error` →
  `onMalformed?.()` → bare `return`. No `close()` in the body (a body close would pre-empt the
  seam's budgeted one). No dead imports left behind.
- **The unmetered-amplification claim holds.** `registerRpcHandlers`
  (`src/service/fret-service.ts:1236`) passes a callback that calls `this.handleMaybeAct(msg)`;
  `handleMaybeAct` takes `bucketMaybeAct.tryTake()` as its very first statement (`:1384`). The
  handler body's `decodeJson` therefore runs strictly before the bucket.
- **The seam symmetry claim holds.** `registerJsonHandler`'s body-level decode arm
  (`src/rpc/protocols.ts:215-221`) is `onMalformed('decode')` → `log.error` → bare `return`, no
  reply. maybeAct's arm is now the same shape, so all five handlers follow the two-tier rule.
- **The wire-visible contract change classifies correctly**, checked end to end: the seam's drop
  path is a budgeted `close()`, so the sender's `readFramed` hits EOF with no frame and raises a
  truncation error; `classify` (`src/rpc/request.ts:86`) maps `isFrameTruncationError` →
  `decode-error`; `noteRpcFailure` (`src/service/fret-service.ts:865`) answers `decode-error` with
  `noteAnsweredOnProtocol` + `applyFailure` — membership confirmed, contact-failure run cleared,
  relevance decayed, **no contact strike**. Worth stating in the findings: the *old* behavior was
  strictly worse, not merely different — a static `NearAnchor` reply came back as an `ok` outcome,
  so the sender scored `applySuccess` (relevance **credit**) for an exchange in which its own
  message was unreadable.
- **The two spec files' diffs are consistent with the source change.** Both release-accounting
  cases (`test/rpc.handler-fuzz.spec.ts:210-233`) assert `{ closes: 1, aborts: 0 }` with
  `sends === 0`. The four maybeAct rows in `malformedMatrix()` moved to `expect: 'drop'` **with**
  `counts: 'malformed'` added — the `counts` half is required, since `runMatrix` tallies the
  `malformed` delta against the rows declaring it.

Nothing has been found wrong in the implement diff.

## Done in run four

**The negative-half metering test is written** — the one minor finding of this review, fixed
inline at the same site as the diff. `test/rpc.handler-fuzz.spec.ts`, last case in the
`handleMaybeAct validator consequences` describe, immediately after the positive metering test:
`spends no token on an undecodable body, and answers nothing`. It builds an edge
`CoreFretService` on the shared mem node, swaps `node.handle` for a capturing stub, calls the
service's private `registerRpcHandlers()`, pulls the handler off the service's own `protocols`
object, drives 12 `inboundStub([framed('{ not: json }')])` invocations, and asserts
`rejected.malformed` +12, `rejected.rateLimited.maybeAct` +0, and zero reply frames — then the
discriminator: 8 well-formed messages through `handleMaybeAct` and **no** busy reply, proving the
burst of 8 was never drained.

`npx tsc --noEmit` from `packages/fret` passes clean with it. **It has not been run yet.**

## What is still open

### Run the gate

`yarn workspace p2p-fret test`. No lint step in this repo — `yarn check` (typecheck + build +
test) is the gate, and `yarn format` must not be run (see AGENTS.md). Tests must pass. Fast
signal first if wanted: run `test/rpc.handler-fuzz.spec.ts` alone, since the new case is the only
thing unverified. The handoff's claim of 1220 passing / 0 failing over ~7m is still unverified.
Foreground, no redirection.

Watch for a rebase against `rejection-diagnostics-conflated`, whose steps edit this same file at
the `rateLimited` sum site in the *positive* metering test — directly above the new case.

### Decide `RowExpect`'s `'abort'` variant

Now used by zero rows in `rpc.handler-fuzz.wire.spec.ts`. The implementer kept it deliberately and
wrote the reason into its doc comment (a payload *string* cannot drive a framing failure; those
come out of `readFramed`, above anything `sendRaw` can express). Either accept that as written,
add a row that drives a real truncated frame, or delete the variant — but say which and why in the
findings.

### Confirm the doc edit reflects reality

`docs/fret.md`, *Stream management* → `registerJsonHandler` two-tier paragraph, now distinguishes
*sitting on `registerJsonHandler`* (four handlers) from *following the two-tier rule* (all five).
The code half of that claim is verified above; what remains is reading the paragraph as shipped.
Prose only — no wire format, determinism edition, byte-format vector, golden fixture, or migration
involved.

### Then write `complete/`

`## Review findings` must list: one minor finding found and fixed inline (the missing negative-half
metering test, now written); no major findings and no tickets filed — say so explicitly with the
reason (the diff's claims were checked end to end at HEAD and hold); no tripwires parked, with the
reason; the `RowExpect` decision; and the known unrelated observation below, parked not filed.

## Known unrelated observation (do not file)

`packages/fret/test/rpc.handler-fuzz.wire.spec.ts:6` imports `json` from `./helpers/rpc-fuzz.js`
and never uses it. Pre-existing — the wire spec has no `json(...)` call site before or after this
ticket, and `noUnusedLocals` is not set in `packages/fret/tsconfig.json`, so `tsc` stays silent.
Trivial to delete if the reviewer wants it gone; outside this ticket's diff either way.

## Coordination

`rejection-diagnostics-conflated` is the prereq and was still in `implement/` when this landed.
`71be306`'s source change was **not** reverted; only its unmetered reply was removed, which is
what the fix ticket directed.
