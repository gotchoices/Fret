description: A node that receives a message it cannot read now quietly closes the connection instead of replying with an empty, useless routing hint — matching how it already handles unreadable messages on its other four protocols.
files: packages/fret/src/rpc/maybe-act.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/rpc.handler-fuzz.wire.spec.ts, packages/fret/test/helpers/rpc-fuzz.ts, docs/fret.md
---

## What shipped

`registerMaybeAct`'s `catch` arm around `decodeJson` no longer writes a reply. It keeps
`log.error`, keeps `onMalformed?.()`, and returns bare, so the shared inbound seam
(`registerRpcHandler`) performs its own budgeted `close()`. The deleted line answered every
undecodable body with a static empty `NearAnchorV1`.

The reason is metering. `decodeJson` runs in the handler body, **upstream** of the maybeAct token
bucket taken inside `handleMaybeAct`, so a reply from that arm cost the sender no token — one free
reply frame per undecodable message. The cheap-guard rejections that *do* answer run **after** the
bucket and are therefore metered. Metered → answer; unmetered → drop. maybeAct now matches the
other four handlers, all of which drop a body-level failure without replying.

Wire-visible consequence, traced end to end: the seam's drop is a budgeted `close()`, so the
sender's `readFramed` hits EOF with no frame and raises a truncation error; `classify` maps it to
`decode-error`; `noteRpcFailure` answers `decode-error` with `noteAnsweredOnProtocol` plus
`applyFailure` — membership confirmed, contact-failure run cleared, relevance decayed, **no contact
strike**. The old behavior was strictly worse rather than merely different: a static `NearAnchor`
came back as an `ok` outcome, so the sender scored `applySuccess` — relevance *credit* — for an
exchange in which its own message was unreadable.

## Review findings

**Checked.** The implement diff read at HEAD with fresh eyes before the handoff summary: the source
arm's shape (`log.error` → `onMalformed?.()` → bare `return`, no body-level `close()` that would
pre-empt the seam's budgeted one, no dead imports); the unmetered-amplification claim, by following
`registerRpcHandlers` → `handleMaybeAct` and confirming `bucketMaybeAct.tryTake()` is that method's
first statement, strictly after the handler body's `decodeJson`; the seam-symmetry claim, against
`registerJsonHandler`'s own body-level decode arm; the full sender-side classification chain above;
and both spec diffs (the two release-accounting cases asserting `{closes: 1, aborts: 0}` with
`sends === 0`, and the four maybeAct matrix rows moved to `expect: 'drop'` **with** `counts:
'malformed'` — the `counts` half is load-bearing, since `runMatrix` tallies the malformed delta only
against rows declaring it). Docs re-read as shipped rather than assumed current.

**Minor — one found, fixed inline.** The diff pinned the positive half of the metering claim (a
malformed-but-decodable message spends a token) and left the negative half — that an *undecodable*
body spends none — unpinned, which is the half this ticket actually changes. Written at the same
site as the diff: `test/rpc.handler-fuzz.spec.ts`, last case of `handleMaybeAct validator
consequences`, "spends no token on an undecodable body, and answers nothing". It drives 12
undecodable bodies through the real registered handler and asserts `rejected.malformed` +12,
`rejected.rateLimited.maybeAct` +0, and zero reply frames — then the discriminator that makes the
+0 mean something: 8 well-formed messages through `handleMaybeAct` afterwards draw **no** busy
reply, proving the burst of 8 was never drained.

**Major — none, and not for want of looking.** Every claim the diff rests on was re-derived at HEAD
rather than taken from the handoff (the four bullets above), and each held. No tickets filed.

**Tripwires — none parked.** Nothing in this diff is of the "fine now, becomes work if X" shape: the
change removes a reply rather than adding a cost, and the one number involved (the token bucket) is
untouched.

**Accepted tradeoff, recorded at its site.** `RowExpect`'s `'abort'` variant in
`rpc.handler-fuzz.wire.spec.ts` is now used by zero rows, since the four maybeAct rows moved to
`'drop'`. Kept as the implementer wrote it: `runMatrix`'s `abort` arm is what makes "aborted" and
"politely dropped" *distinguishable* outcomes, which is the two-tier split itself, and a payload
string cannot drive a frame-level failure (those come out of `readFramed`, above anything `sendRaw`
can express), so a row needing it must drive the frame. The existing doc comment already stated
that; this pass tagged it `NOTE: accepted tradeoff` so it joins the greppable set, and rewrapped
the paragraph. No behavior change.

**Docs.** `docs/fret.md`'s *Stream management* two-tier paragraph was read as shipped and matches
the code: it distinguishes *sitting on `registerJsonHandler`* (four handlers) from *following the
two-tier rule* (all five), and states maybeAct's drop and its unmetered-position reason. The
sibling *Cheap-guard rejections* paragraph ("maybeAct is still the only handler that parses inside
its own handler body") is consistent with it. No edit needed. Prose only — no wire format,
determinism edition, byte-format vector, golden fixture, or migration involved.

**Gate.** `yarn test` from `packages/fret`: **1223 passing, 0 failing, ~7m**. No lint step exists in
this repo (`yarn check` — typecheck + build + test — is the gate, and `yarn format` must not be run;
see AGENTS.md). The new case was also run alone first: `rpc.handler-fuzz.spec.ts`, 156 passing.

**Parked, not filed.** `test/rpc.handler-fuzz.wire.spec.ts:6` imports `json` from
`./helpers/rpc-fuzz.js` and never uses it. Pre-existing — that spec has no `json(...)` call site
before or after this ticket — and invisible to `tsc`, since `noUnusedLocals` is not set in
`packages/fret/tsconfig.json`. Outside this diff; not worth a ticket.

## Coordination

`rejection-diagnostics-conflated` was the prereq and was still in `implement/` when this landed.
Its source change (`71be306`) was **not** reverted; only the unmetered reply was removed, which is
what the fix ticket directed.
