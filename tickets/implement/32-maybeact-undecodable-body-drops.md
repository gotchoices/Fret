description: When a peer sends a message whose body is not readable JSON, the node should quietly close the connection without answering, the same way it already handles unreadable messages on its other four protocols — today it answers with an empty routing hint instead, and three tests still expect the older behaviour of tearing the connection down.
prereq: rejection-diagnostics-conflated
files: packages/fret/src/rpc/maybe-act.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/rpc.handler-fuzz.wire.spec.ts, docs/fret.md
difficulty: medium
---

## Status: reproduced, root-caused, direction decided

The three failures named below were re-run at HEAD `8cc32a7` on a clean tree and reproduce
exactly, byte-for-byte with the assertions the originating ticket recorded:

```
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/rpc.handler-fuzz.spec.ts" "test/rpc.handler-fuzz.wire.spec.ts" --timeout 30000
=> 157 passing, 3 failing
```

1. `test/rpc.handler-fuzz.spec.ts:216` — *aborts once when the maybeAct body is not JSON* —
   `expected { closes: 1, aborts: +0 } to deeply equal { closes: +0, aborts: 1 }`
2. `test/rpc.handler-fuzz.spec.ts:227` — *aborts once when the maybeAct body decodes to a
   non-object* — same assertion, same shape.
3. `test/rpc.handler-fuzz.wire.spec.ts:196` (via `runMatrix`, called from `:245`) —
   `maybeAct: invalid JSON: no reply — aborted: expected 'reply' to equal 'abort'`

`npx tsc --noEmit` is green. These are runtime assertion failures, not build drift.

## Root cause

Commit `71be306` changed `registerMaybeAct`'s handler body in `packages/fret/src/rpc/maybe-act.ts`
so a decode throw no longer propagates into `registerRpcHandler`'s error arm. It is now caught,
logged, counted via `onMalformed?.()`, and answered with a static empty `NearAnchorV1`:

```ts
} catch (err) {
    log.error('%s: undecodable body - dropping - %e', protocol, err);
    onMalformed?.();
    sendFramed(stream, encodeJson({ v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 0, confidence: 0 } satisfies NearAnchorV1));
    return;
}
```

That is a deliberate contract change — the old path counted no diagnostic at all — but only the
source half landed. Three tests still pin the pre-`71be306` behaviour.

## The decision (settled — implement this, do not re-litigate)

**An undecodable maybeAct body drops: close the stream, write no reply.** Delete the `sendFramed`
line from the catch arm; keep the log, keep `onMalformed?.()`, keep the bare `return` so the
seam's own budgeted `close()` runs.

Two reasons, and the second is what separates this case from the cheap-guard rejections that *do*
answer with a static reject:

- **It is a body-level failure, and the house rule for those is a polite drop.** The peer framed
  correctly and is alive; it just sent junk. That is exactly what `registerJsonHandler`'s
  body-level tier does for the other four handlers — close, no reply, no teardown. maybeAct
  parses inside its own handler body only because its token bucket must be taken first, which is
  a reason for *where* the parse lives, not for a different answer when it fails.
- **The reply would be unmetered.** `decodeJson` runs in the handler body; the maybeAct token
  bucket is taken inside `handleMaybeAct`, downstream of it. So a static reply here hands a peer
  one reply frame per undecodable message without ever spending a token — an amplification path
  the abort arm did not have. The *cheap-guard* static rejects are not this: those run after the
  bucket, so they are metered. Metered → answer; unmetered → drop. That is the discriminator, and
  it should be written down at the site.

Frame-level failures are untouched and must keep aborting: truncation and over-cap come out of
`readFramed`, above the `try`, and still reach `registerRpcHandler`'s error arm.

Note the `maybeAct: truncated JSON` matrix row (`{"v":1,"key":"`) is classified by where it
actually fails: that is a *complete frame* carrying *incomplete JSON*, so it fails in `decodeJson`
and is body-level despite the row's name. It becomes a `drop` row along with the other three.

## Consequences to land with it

- **Diagnostics.** `onMalformed` still fires, so all four maybeAct rows now increment
  `diag.rejected.malformed`. The wire spec tallies `after.malformed - before.malformed` against
  the count of rows whose `counts` is `'malformed'`, so changing only each row's `expect` leaves
  the tally four short — every one of the four rows needs `counts: 'malformed'` added too.
- **The matrix's own doc comment** ("Framing failures still abort — see the maybeAct rows above,
  which are not on that seam") states the old rule and must move/replace, since those rows are no
  longer the example of an aborting row.
- **Release-exactly-once still holds.** The seam owns the close — do not add a `close()` to the
  handler body; a bare close there pre-empts the seam's budgeted one.
- **`docs/fret.md`.** The *Stream management* `registerJsonHandler` two-tier paragraph says a
  body-level failure is a polite drop and that "Four of the five FRET handlers sit on this seam";
  maybeAct's own decode tier is nowhere stated. State it explicitly: maybeAct parses in its own
  body (bucket-ordering) but follows the same body-level rule, and say why the unmetered position
  of `decodeJson` is what rules out answering. The existing acknowledgement of that ordering (the
  NUL-padding debug line, "`decodeJson` runs ahead of the maybeAct token bucket and a peer can
  therefore drive one per message it sends") is the reasoning to extend, not re-derive.

No cross-cutting obligations: wire format unchanged, no determinism edition bump, no byte-format
vector, no golden fixture, no migration. What changes is which release arm runs and whether a
reply frame is written.

## Coordination

`tickets/implement/31-rejection-diagnostics-conflated.md` is the prereq and its steps 6-9 edit
`packages/fret/test/rpc.handler-fuzz.spec.ts` at its `:1184` `rateLimited` sum site — a different
region of the same file from the `:210`-`:229` release-accounting block here, but expect to
rebase. Do not revert `71be306`; the source change is intended.

## TODO

- Delete the `sendFramed(...)` call from the catch arm in `registerMaybeAct`
  (`packages/fret/src/rpc/maybe-act.ts`); keep log + `onMalformed?.()` + bare `return`.
- Record the metered-vs-unmetered reasoning as a comment at that catch arm — it is the
  non-obvious half of why this drops where a cheap-guard rejection answers.
- `test/rpc.handler-fuzz.spec.ts:210`-`:229`: retitle both cases (they no longer "abort") and
  flip the assertions to `{ closes: 1, aborts: 0 }`. Keep the first case's `expect(s.sends).to
  .equal(0)` — under this direction it is correct again — and add the same assertion to the
  non-object case so both pin "no reply written".
- `test/rpc.handler-fuzz.wire.spec.ts`, `malformedMatrix()`: change the four maybeAct rows
  (`invalid JSON`, `truncated JSON`, `null top level`, `array top level`) from `expect: 'abort'`
  to `expect: 'drop'` and add `counts: 'malformed'` to each.
- Replace the matrix doc comment that cites the maybeAct rows as the still-aborting example;
  state instead that body-level failures drop on every protocol and that only frame-level
  failures (truncation, over-cap, reset) abort.
- Check whether `RowExpect`'s `'abort'` variant still has any row using it after the change. If
  none does, leave the variant in place — the `abort` arm of `runMatrix` is the assertion that a
  frame-level failure is still distinguishable — but say so in a comment rather than leaving a
  silently-unreachable branch.
- `docs/fret.md`: state maybeAct's decode tier in the *Stream management* two-tier paragraph, and
  correct the "Four of the five FRET handlers sit on this seam" sentence so it distinguishes
  *sitting on `registerJsonHandler`* from *following the two-tier rule* (all five now do the
  latter; four do the former).
- Verify: `cd packages/fret && npx tsc --noEmit && yarn test`. The three named tests must pass and
  both `runMatrix` tallies (malformed, identityMismatch) must still balance.
