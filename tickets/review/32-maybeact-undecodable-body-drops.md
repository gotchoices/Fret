description: A node that receives a message it cannot read now quietly closes the connection instead of replying with an empty, useless routing hint — matching how it already handles unreadable messages on its other four protocols. Tests and the design document were updated to match.
prereq: rejection-diagnostics-conflated
files: packages/fret/src/rpc/maybe-act.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/rpc.handler-fuzz.wire.spec.ts, docs/fret.md
difficulty: medium
---

## What changed

Four edits, one behavior change.

**`packages/fret/src/rpc/maybe-act.ts`** — the `catch` arm in `registerMaybeAct`'s handler body no
longer writes a reply. It keeps the `log.error`, keeps `onMalformed?.()`, and keeps the bare
`return` so the seam (`registerRpcHandler`) performs its own budgeted `close()`. Deleted: the
`sendFramed(stream, encodeJson({ v: 1, anchors: [], ... }))` line that answered with a static empty
`NearAnchorV1`.

A comment at the arm records the non-obvious half of *why*: `decodeJson` runs in the handler body,
**upstream** of the maybeAct token bucket taken inside `handleMaybeAct`, so a static reply here is
unmetered — one free reply frame per undecodable message, with no token ever spent. The
*cheap-guard* rejections that **do** answer with a static reject run **after** the bucket and are
therefore metered. Metered → answer; unmetered → drop. That is the discriminator, and it is what
separates this case from the guard rejections a reviewer will find one screen down in
`handleMaybeAct`.

**`packages/fret/test/rpc.handler-fuzz.spec.ts`** (`:210`–`:235`) — both release-accounting cases
retitled (`aborts once…` → `closes once, with no reply…`) and flipped to
`{ closes: 1, aborts: 0 }`. The non-object case gained `expect(s.sends, 'no reply attempted').to
.equal(0)`, which the not-JSON case already had — both now pin "no reply written", not just the
release arm.

**`packages/fret/test/rpc.handler-fuzz.wire.spec.ts`** — the four maybeAct rows in
`malformedMatrix()` (`invalid JSON`, `truncated JSON`, `null top level`, `array top level`) moved
from `expect: 'abort'` to `expect: 'drop'` **and** gained `counts: 'malformed'`. The `counts` half
is load-bearing and easy to miss: `runMatrix` tallies `after.malformed - before.malformed` against
the count of rows whose `counts` is `'malformed'`, so flipping only `expect` leaves the tally four
short. The matrix's doc comment (previously "Framing failures still abort — see the maybeAct rows
above, which are not on that seam") was replaced: body-level failures drop on **every** protocol,
and only frame-level failures abort.

**`docs/fret.md`**, *Stream management* → the `registerJsonHandler` two-tier paragraph — the "Four
of the five FRET handlers sit on this seam" sentence now distinguishes *sitting on
`registerJsonHandler`* (four handlers) from *following the two-tier rule* (all five). maybeAct's own
decode tier is stated explicitly, along with the metered-vs-unmetered reasoning, extending the
existing NUL-padding acknowledgement that `decodeJson` runs ahead of the maybeAct token bucket
rather than re-deriving it.

## Verification performed

```
cd packages/fret && npx tsc --noEmit          # green
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/rpc.handler-fuzz.spec.ts" "test/rpc.handler-fuzz.wire.spec.ts" --timeout 30000
=> 160 passing, 0 failing   (was 157 passing / 3 failing at HEAD 8cc32a7)

cd packages/fret && yarn test
=> 1220 passing, 0 failing  (7m)
```

The three originally-failing assertions are the three that flipped. Both `runMatrix` tallies
(`malformed`, `identityMismatch`) balance — the matrix's own trailing loop still asserts that every
`reject`/`drop` row names a counter, so a row added later cannot inherit one silently.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## What to check hardest

- **The unmetered-amplification claim is reasoned, not measured.** The argument is a code-ordering
  one: `decodeJson` sits in the handler body and `handleMaybeAct` takes the bucket, so the decode
  arm is reached without a token. Worth confirming by reading the two call sites rather than
  trusting this summary — the whole direction rests on it. There is an adjacent test that pins the
  *positive* half (`spends a token per malformed message — the validator is not an unmetered
  pre-filter`, in `rpc.handler-fuzz.spec.ts`), but **nothing pins the negative half**: no test
  asserts that an *undecodable* body spends no token. That is a real coverage gap in this handoff,
  not an oversight I resolved. It is testable — drive an undecodable body and read
  `diag.rejected.rateLimited.maybeAct` — and I did not add it.
- **`RowExpect`'s `'abort'` variant is now used by zero rows.** Per the ticket's direction it was
  kept rather than deleted, with the reason written into its doc comment: `runMatrix`'s `abort` arm
  is the assertion that a frame-level failure stays distinguishable from a body-level drop, and a
  payload *string* cannot produce a framing failure (those come out of `readFramed`, above anything
  `sendRaw` can express). A reviewer may reasonably disagree and want either a row that drives a
  real truncated frame, or the variant gone. Both are defensible; the comment states the choice so
  it is not silently-unreachable code.
- **Wire-visible contract change.** A peer sending an undecodable maybeAct body previously got a
  frame back (an empty `NearAnchorV1`) and now gets EOF. No FRET sender depends on that reply —
  `sendMaybeAct` maps the EOF to `decode-error` via `isFrameTruncationError`, which is proof of
  life and *not* a contact strike, so the peer is still membership-confirmed and not escalated
  toward `dead`. I reasoned this from `noteRpcFailure`'s classification rather than driving a
  sender against a receiver that answers this way — worth an independent read.
- **`docs/fret.md` prose only.** No wire format, determinism edition, byte-format vector, golden
  fixture, or migration is involved. What changed is which release arm runs and whether a reply
  frame is written.

## Known gaps and unrelated observations

- The negative-half rate-limit test described above is absent. Named here rather than filed —
  a reviewer may want it inline.
- `packages/fret/test/rpc.handler-fuzz.wire.spec.ts:6` imports `json` from
  `./helpers/rpc-fuzz.js` and never uses it. **Pre-existing** — the wire spec has no `json(...)`
  call site before or after this ticket (the `{ not: json }` occurrences are payload *strings*).
  `noUnusedLocals` is not set in `packages/fret/tsconfig.json`, so `tsc` stays silent. Left alone
  as outside this ticket's diff; trivial to delete if a reviewer wants it gone.

## Coordination

`tickets/implement/31-rejection-diagnostics-conflated.md` is the prereq and was still in
`implement/` when this landed. Its steps 6–9 edit `rpc.handler-fuzz.spec.ts` at the `:1184`
`rateLimited` sum site; this ticket edited the `:210`–`:235` release-accounting block. Different
regions of the same file — no textual conflict observed, but expect a rebase.

`71be306`'s source change was **not** reverted; only its unmetered reply was removed, which is what
the ticket directed.
