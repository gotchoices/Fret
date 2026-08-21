description: Reconcile the maybeAct undecodable-body contract — source now drops-and-replies where three tests still pin abort-and-no-reply — and land the counter/doc consequences.
prereq: none (the source half already landed at 71be306; this ticket is the test + doc + accounting half)
files: packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/rpc.handler-fuzz.wire.spec.ts, packages/fret/src/rpc/maybe-act.ts, docs/fret.md
difficulty: medium
---

## Failing tests (reproduced at HEAD 3dbc106, clean tree, `cd packages/fret && yarn test`)

1. `RPC handler fault isolation > registerRpcHandler release accounting > aborts once when the
   maybeAct body is not JSON` — `test/rpc.handler-fuzz.spec.ts:216`
   ```
   AssertionError: expected { closes: 1, aborts: +0 } to deeply equal { closes: +0, aborts: 1 }
   ```
2. `... > aborts once when the maybeAct body decodes to a non-object` —
   `test/rpc.handler-fuzz.spec.ts:227` — same assertion, same shape.
3. `RPC handler fault isolation over the wire > over the memory transport > releases the inbound
   stream for every malformed shape in the matrix` — `test/rpc.handler-fuzz.wire.spec.ts:196`
   (via `runMatrix`, called from `:245`)
   ```
   AssertionError: maybeAct: invalid JSON: no reply — aborted: expected 'reply' to equal 'abort'
   ```

Not flaky, not build drift: this repo has no `portal:` dependencies and no sibling-dist coupling,
so there is no stale-dist explanation. `npx tsc --noEmit` is green; these are runtime assertion
failures.

## Root cause (confirmed, not hypothesised)

Commit `71be306` — `ticket(implement): rejection-diagnostics-conflated`, whose ticket
`tickets/implement/31-rejection-diagnostics-conflated.md` is **still in flight** — changed
`registerMaybeAct`'s handler body in `packages/fret/src/rpc/maybe-act.ts`:

```diff
-		const msg = decodeJson<RouteAndMaybeActV1>(bytes);
+		let msg: RouteAndMaybeActV1;
+		try {
+			msg = decodeJson<RouteAndMaybeActV1>(bytes);
+		} catch (err) {
+			log.error('%s: undecodable body - dropping - %e', protocol, err);
+			onMalformed?.();
+			sendFramed(stream, encodeJson({ v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 0, confidence: 0 } satisfies NearAnchorV1));
+			return;
+		}
```

Before: a decode throw propagated into `registerRpcHandler`'s error arm → `abort()`, no reply, no
diagnostic counted. After: log → `onMalformed?.()` (the service passes
`() => { this.diag.rejected.malformed++ }`) → static empty `NearAnchorV1` reply → normal return →
the seam's budgeted `close()`.

That is a deliberate contract change (ticket 31's own resume-note states it as intended: the old
path counted "no diagnostic at all"). Ticket 31's remaining steps 6-9 enumerate the
`rejected.rateLimited` keyed-field call sites and `docs/fret.md`, and **do not mention** either
handler-fuzz spec's release-accounting or matrix rows. So the source half landed and the
contract half did not. Three tests still assert the pre-`71be306` behaviour.

## Suspect / affected sites

- `packages/fret/src/rpc/maybe-act.ts` — the catch arm above (the source of the new contract).
- `packages/fret/test/rpc.handler-fuzz.spec.ts` — the two `registerRpcHandler release accounting`
  cases at `:210`-`:229`. Both assert `{ closes: 0, aborts: 1 }`; the first also asserts
  `s.sends === 0` ("no reply attempted"), which the new static reply violates independently of the
  release arm.
- `packages/fret/test/rpc.handler-fuzz.wire.spec.ts` — the four maybeAct rows in
  `malformedMatrix()` carrying `expect: 'abort'` and **no** `counts` field:
  `maybeAct: invalid JSON`, `maybeAct: truncated JSON`, `maybeAct: null top level`,
  `maybeAct: array top level`. Note these feed the tally at the end of `runMatrix`
  (`after.malformed - before.malformed` must equal the count of rows whose `counts` is
  `'malformed'`) — under the new contract each of those four now increments `malformed`, so
  fixing only the per-row `expect` leaves the tally four short. The matrix's own doc comment
  ("Framing failures still abort — see the maybeAct rows above, which are not on that seam")
  also states the old rule and must move.
- `docs/fret.md` — the *Stream management* `registerJsonHandler` two-tier paragraph says a
  body-level failure is a polite drop and that "Four of the five FRET handlers sit on this seam";
  maybeAct's own decode tier is nowhere stated. Whichever direction this ticket resolves, the doc
  must state it explicitly, since the whole point of that paragraph is that the tier is decided by
  *where* the failure happens.

## The decision this ticket must make

The three tests are not wrong-by-construction; they pin a contract that was changed underneath
them. Do **not** simply relax them to match whatever the source now does — state the intended
contract first, then make source, tests and doc agree.

Recommended direction (aligning with the stated two-tier rule in *Stream management*): an
undecodable maybeAct body is a **body-level** failure — the peer framed correctly and is alive,
it just sent junk — so it should not tear the stream down. Keep the new drop-not-abort behaviour
and update the tests. That leaves one sub-decision, which the wire matrix already has vocabulary
for:

- `expect: 'reject'` — close **with** the static empty `NearAnchorV1` (what the source does
  today). Consistent with *Cheap-guard rejections*, where a structurally-invalid-but-decodable
  message also gets the static reject.
- `expect: 'drop'` — close with **no** reply (what `registerJsonHandler`'s body-level tier does
  for the other four handlers, and what `rpc.handler-fuzz.spec.ts:216`'s `sends === 0` assertion
  currently demands).

Pick one, apply it to all four matrix rows and both stub-stream cases, and record the reasoning at
the site. If `reject` is chosen, every affected row gains `counts: 'malformed'`.

## Design constraints

- **The new reply is unmetered.** `decodeJson` runs in the handler body; the maybeAct token bucket
  is taken inside `handleMaybeAct`, downstream of it. So under the `reject` option a peer draws a
  reply frame per undecodable message without ever spending a token — a small amplification path
  the abort arm did not have. `docs/fret.md` already acknowledges the ordering ("`decodeJson` runs
  ahead of the maybeAct token bucket and a peer can therefore drive one per message it sends") in
  the context of the NUL-padding debug line; extend that reasoning rather than re-deriving it. If
  this is judged unacceptable, that is an argument for the `drop` option.
- **Frame-level failures must still abort.** Truncation and over-cap come out of `readFramed`,
  above the `try`, and must keep reaching `registerRpcHandler`'s error arm. Confirm the
  `maybeAct: truncated JSON` matrix row is classified by where it actually fails — a body of
  `{"v":1,"key":"` is a complete *frame* carrying incomplete *JSON*, so it is body-level despite
  the row's name.
- **Release-exactly-once still holds on every path.** The seam owns the close; do not add a
  `close()` to the maybeAct body (see the *Stream management* note on why a bare close in a body
  pre-empts the seam's budgeted one).
- **Diagnostics accounting.** `onMalformed` now fires on this path; the wire spec's tally is the
  thing that proves it. Whatever direction is chosen, keep the "a row that rejects but names no
  counter is a row whose accounting was never stated" invariant at the end of `runMatrix` true.

No cross-cutting obligations triggered: no determinism edition bump, no byte-format vector, no
golden fixture, no migration. Wire format is unchanged in both directions — this is which
*release arm* runs and whether a static reply frame is written.

## Coordination

`tickets/implement/31-rejection-diagnostics-conflated.md` is in flight and its steps 6-9 edit
`packages/fret/test/rpc.handler-fuzz.spec.ts` (its `:1184` `rateLimited` sum site) among others.
That is a different region of the same file from the `:210`-`:229` release-accounting block this
ticket touches, but expect to rebase. Do not revert `71be306`; the source change is intended.

## Verification

`cd packages/fret && npx tsc --noEmit && yarn test` — the three named tests must pass, and the
`runMatrix` malformed/identityMismatch tallies must both still balance.
