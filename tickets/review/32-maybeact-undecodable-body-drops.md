description: A node that receives a message it cannot read now quietly closes the connection instead of replying with an empty, useless routing hint — matching how it already handles unreadable messages on its other four protocols. The reasoning behind the change is fully verified; one test still needs writing, the suite still needs running, and two small judgement calls need settling.
prereq: rejection-diagnostics-conflated
files: packages/fret/src/rpc/maybe-act.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/rpc.handler-fuzz.wire.spec.ts, packages/fret/test/helpers/rpc-fuzz.ts, docs/fret.md
difficulty: medium
---

<!-- resume-note -->
Three prior review runs were each cut short by a token-budget warning. **No code has been changed
by any of them** — the working tree is exactly what the implement commit `9285e95` left. Everything
under *Verified* is settled; the test design under *What is still open* is settled too. Resume by
**writing the test first, then running the suite once** — do not re-read the implement diff, do not
re-derive the verified claims, and do not re-explore the test helpers beyond what is named below.

## What the change is

One behavior change plus its tests and doc text. `registerMaybeAct`'s `catch` arm around
`decodeJson` no longer writes a reply: it keeps `log.error`, keeps `onMalformed?.()`, and returns
bare so the seam (`registerRpcHandler`) performs its own budgeted `close()`. The deleted line
answered every undecodable body with a static empty `NearAnchorV1`.

The stated reason is metering: `decodeJson` runs in the handler body, **upstream** of the maybeAct
token bucket taken inside `handleMaybeAct`, so a reply from this arm costs the sender no token —
one free reply frame per undecodable message. The cheap-guard rejections that *do* answer run
**after** the bucket and are therefore metered. Metered → answer; unmetered → drop.

## Verified (read at HEAD, not taken from the handoff)

- **The source arm is the right shape.** `src/rpc/maybe-act.ts` catch arm: `log.error` →
  `onMalformed?.()` → bare `return`. No `close()` in the body (a body close would pre-empt the
  seam's budgeted one). No dead imports left behind — `sendFramed` / `encodeJson` are still used on
  the success path, `NearAnchorV1` in `handle`'s return type.
- **The unmetered-amplification claim holds.** Read both call sites rather than trusting the
  handoff. `registerRpcHandlers` (`src/service/fret-service.ts:1236`) passes a callback that calls
  `this.handleMaybeAct(msg)`; `handleMaybeAct` takes `bucketMaybeAct.tryTake()` as its very first
  statement (`src/service/fret-service.ts:1384`), with `parseRouteAndMaybeAct` and every cheap
  guard below it. The handler body's `decodeJson` therefore runs strictly before the bucket.
- **The seam symmetry claim holds.** `registerJsonHandler`'s body-level decode arm
  (`src/rpc/protocols.ts:215-221`) is `onMalformed('decode')` → `log.error` → bare `return`, no
  reply. maybeAct's arm is now the same shape, so all five handlers genuinely follow the two-tier
  rule — which is exactly what the doc edit claims.
- **The wire-visible contract change classifies correctly**, checked end to end through the code.
  The seam's drop path is a tidy budgeted `close()`, so the sender's `readFramed` hits EOF with no
  frame and raises a truncation error; `classify` (`src/rpc/request.ts:86`) maps
  `isFrameTruncationError` → `decode-error`; and `noteRpcFailure` (`src/service/fret-service.ts:865`)
  answers `decode-error` with `noteAnsweredOnProtocol` + `applyFailure` — membership confirmed,
  contact-failure run cleared, relevance decayed, **no contact strike**. A peer sending an
  undecodable body is not escalated toward `dead`.
  - Worth stating in the findings: the *old* behavior was strictly worse here, not merely
    different. A static `NearAnchor` reply came back as an `ok` outcome, so the sender scored
    `applySuccess` — relevance **credit** — for an exchange in which its own message was
    unreadable. Decay-with-proof-of-life is the more honest classification.
- **The two spec files' diffs are consistent with the source change.** Both release-accounting
  cases (`test/rpc.handler-fuzz.spec.ts:210-233`) assert `{ closes: 1, aborts: 0 }` with
  `sends === 0`. The four maybeAct rows in `malformedMatrix()` moved to `expect: 'drop'` **with**
  `counts: 'malformed'` added — the `counts` half is required, since `runMatrix` tallies the
  `malformed` delta against the rows declaring it.

Nothing has been found wrong. No finding fixed, filed, or parked yet.

## What is still open

### Write the negative-half metering test (minor finding, same site as the diff — fix inline)

`test/rpc.handler-fuzz.spec.ts:1179` pins the *positive* half — a malformed-but-decodable message
spends a token, "the validator is not an unmetered pre-filter". Nothing pins the negative half: no
test asserts an **undecodable** body spends **no** token, which is the entire justification for
this ticket's change.

**Design is settled — implement this, don't redesign it.** Add it to the
`handleMaybeAct validator consequences` describe, immediately after the positive metering test at
`:1179`. Self-contained (that describe's `beforeEach` gives you `node` and a core `svc`; make your
own edge service as the positive test does).

Exercise the **real** registration wiring rather than re-wiring `registerMaybeAct` by hand — the
point is that the service's own `onMalformed` closure and its own bucket are what move (or don't):

- Build an edge `CoreFretService` on the mem `node` (distinct `networkName`, as the positive test
  does). Edge maybeAct bucket: burst 8, refill 4/s.
- Capture the handler instead of registering it for real: replace `node.handle` with a
  `(protocol, h) => { handlers.set(protocol, h) }` stub **before** calling the service's private
  `registerRpcHandlers()` (cast through an interface, the same style as the existing
  `DrivableService` cast). Read the protocol string off the service's own `protocols` object, not
  by rebuilding it from `NETWORK`.
- Invoke the captured maybeAct handler ~12 times with `inboundStub([framed('{ not: json }')])`
  and a `{ remotePeer: { toString: () => 'peer-a' } }` connection stub — the same shape
  `fakeNode().invoke` builds at `:69-73`. Assert `rejected.malformed` moved by 12 and
  `rejected.rateLimited.maybeAct` did **not** move at all.
- Then the discriminator, which is what makes this more than "the callback wasn't invoked":
  drive 8 well-formed messages through `handleMaybeAct` directly (the existing `drive` helper) and
  assert **none** answers `busy`. The bucket is still full because the undecodable flood spent
  nothing. Had the flood been metered, 12 messages would have drained a burst of 8 and the control
  batch would be mostly busy.

Note `helpers/rpc-fuzz.ts` supplies `framed`, `inboundStub`, `baseMsg`, `NETWORK`, `P` — all
already imported at the top of the spec.

Watch for a rebase against `rejection-diagnostics-conflated`, whose steps edit this same file at
the `:1184` `rateLimited` sum site — right where this new test lands. Write it defensively.

### Run the gate

`cd packages/fret && npx tsc --noEmit`, then `yarn workspace p2p-fret test`. No lint step in this
repo — `yarn check` (typecheck + build + test) is the gate, and `yarn format` must not be run (see
AGENTS.md). Tests must pass; the handoff's claim of 1220 passing / 0 failing over ~7m is still
unverified. Run the two fuzz specs directly first if you want a fast signal, but the full suite is
what the stage requires. Foreground, no redirection.

### Decide `RowExpect`'s `'abort'` variant

Now used by zero rows in `rpc.handler-fuzz.wire.spec.ts`. The implementer kept it deliberately and
wrote the reason into its doc comment (a payload *string* cannot drive a framing failure; those come
out of `readFramed`, above anything `sendRaw` can express). Either accept that as written, add a row
that drives a real truncated frame, or delete the variant — but say which and why in the findings.

### Confirm the doc edit reflects reality

`docs/fret.md`, *Stream management* → `registerJsonHandler` two-tier paragraph, now distinguishes
*sitting on `registerJsonHandler`* (four handlers) from *following the two-tier rule* (all five).
The code half of that claim is verified above; what remains is reading the paragraph as shipped.
Prose only — no wire format, determinism edition, byte-format vector, golden fixture, or migration
involved.

## Known unrelated observation (do not file)

`packages/fret/test/rpc.handler-fuzz.wire.spec.ts:6` imports `json` from `./helpers/rpc-fuzz.js`
and never uses it. Pre-existing — the wire spec has no `json(...)` call site before or after this
ticket (the `{ not: json }` occurrences are payload *strings*), and `noUnusedLocals` is not set in
`packages/fret/tsconfig.json`, so `tsc` stays silent. Trivial to delete if the reviewer wants it
gone; outside this ticket's diff either way.

## Coordination

`rejection-diagnostics-conflated` is the prereq and was still in `implement/` when this landed. Its
steps edit `rpc.handler-fuzz.spec.ts` at the `:1184` `rateLimited` sum site; this ticket edited the
`:210`-`:235` release-accounting block. Different regions of the same file — no textual conflict
observed, but expect a rebase.

`71be306`'s source change was **not** reverted; only its unmetered reply was removed, which is what
the fix ticket directed.
