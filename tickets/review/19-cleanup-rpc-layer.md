description: A recent tidy-up of the network-message code stopped two message handlers from sending a short acknowledgement back to the sender, which broke 76 tests; the review pass needs to finish deciding whether to keep the new no-reply behaviour and update the tests, or put the acknowledgement back.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/test/rpc.codec-properties.spec.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, docs/fret.md
difficulty: medium
----

## Why this ticket exists

This is a **continuation of the review pass** on `cleanup-rpc-layer` (implement commit
`547d506`). The prior run hit its token budget after reading the diff and running the suite once.
Everything already established is recorded below so the next run does not re-derive it. Resume at
*Remaining work*.

## What the implement stage changed (already reviewed, diff read)

Four items, 6 files, +32/-21 — the diff matches the `files:` list, nothing else touched.

1. `encodeJson` / `decodeJson` (`src/rpc/protocols.ts`) dropped `async`; every production call site
   dropped its `await`.
2. `PROTOCOL_*` constants derive from `makeProtocols('default')` instead of restating literals.
3. `registerLeave`'s success reply and `registerNeighbors`' announce-handler success reply changed
   from `return { ok: true }` to `return undefined` — so the seam closes the stream without
   writing any reply bytes.
4. `decodeJson` counts NUL bytes stripped by its interop-defensive trim and emits one `log.error`
   when the count is non-zero.

## Established findings

### Confirmed regression — item 3 breaks a pinned wire contract (76 failing tests)

`cd packages/fret && yarn test` → **1040 passing, 76 failing** (log at
`tickets/.logs/19-cleanup-rpc-layer.test.log`). All failures live in `test/rpc.handler-fuzz.spec.ts`
and `test/rpc.codec-properties.spec.ts` — both on the leave / announce reply path item 3 changed.
Two failure shapes:

- `leave: ...: expected a reply frame, got eof` — the test asked for the reply the handler no
  longer sends.
- `Error: Could not append value, must be an Uint8Array or a Uint8ArrayList` (~60 cases, the
  "announce snapshot field matrix") — the fuzz harness feeds the absent reply into
  `it-length-prefixed`'s decoder. Root cause not yet traced to a line; assumed to be the same
  missing reply, **not yet confirmed**.

These are **not pre-existing** — they are on exactly the code path the diff changed, and the
assertions read as deliberate contracts, e.g.
`test/rpc.codec-properties.spec.ts:1553`:

```
expect((await decodeJson<{ ok: boolean }>(reply!)).ok, 'answered ok despite being dropped').to.equal(true)
```

which is the body of the test *named* `makes a rate-limited leave indistinguishable from an
accepted one on the wire`, and `test/rpc.codec-properties.spec.ts:~993`
(`accepts an under-cap leave and refuses one past the fixed 4096-byte cap`).

**The open question is which side is right, and that is the substance of the remaining review.**
Arguments both ways:

- *Keep the change, update the tests.* Neither `sendLeave` nor `announceNeighbors` ever reads a
  reply — both are write-only through `rpcRequest`, which returns `ok` straight after the write.
  So the acknowledgement bytes are provably unread by any FRET sender, and the design doc's stated
  asymmetry (a rate-limited leave being indistinguishable from an accepted one) survives: both
  outcomes now produce *no* reply rather than both producing `{ok: true}`.
- *Revert item 3.* The acknowledgement is observable by a **non-FRET consumer** — the protocols and
  the `registerRpcHandler` / `registerJsonHandler` seam are exported from the package root, so a
  third party may be reading it. Removing it is a wire-format change, not a tidy-up, and the ticket
  was scoped as low-risk cleanup. It also collapses the seam's `undefined` return, which until now
  meant *only* "identity mismatch, drop", into meaning both "drop" and "success" — a real loss of
  distinguishability inside the handler.

A middle option: keep the change but treat it as a **wire-format decision**, which under the ticket
rules is a `blocked/` question for a human rather than something a review pass decides alone.

### Confirmed — documentation is now stale (`docs/fret.md`)

Whatever is decided about item 3, these passages describe the old behaviour and must be corrected
if it is kept:

- In *Leave*: "the handler around it (`registerLeave`) has already committed to replying
  `{ok: true}`" and "`registerLeave` commits to `{ok: true}` before `handleLeave` takes the bucket,
  so today there is no busy answer to read."
- In *Wire formats*, the `decodeJson` paragraph: the trim is described as silent; item 4 now logs.

### Noted, not yet dispositioned — item 4 logs on attacker-controlled input

`decodeJson` runs **before** the maybeAct token bucket (`registerMaybeAct` reads and decodes in its
own handler body, then `handle()` takes the bucket). So a peer can drive one `log.error` per
NUL-padded message with no rate limit in front of it. Whether that matters depends on whether
`@libp2p/logger`'s `.error` writes unconditionally or only under an enabled `DEBUG` namespace —
**not checked**. If it writes unconditionally this is a log-amplification finding; if it is
namespace-gated it is a tripwire (`NOTE:` at the site) at most.

### Reviewed and clean

- Items 1 and 2 read correct. `npx tsc --noEmit` was clean at the implement stage; test-only
  `await`s on the now-sync functions are legal and harmless.
- No test covers item 4's two cases (NUL padding logs once with the right count; whitespace-only
  padding logs nothing). Missing coverage, not a defect.

## Remaining work

- Decide item 3: keep-and-update-tests, revert, or escalate the wire-format question to `blocked/`.
  Weigh the exported-seam argument above. Whichever way it goes, `yarn test` must be green before
  this reaches `complete/`.
- If item 3 is kept: update the 76 assertions and the two `docs/fret.md` passages, and trace the
  `Could not append value` failures to their actual line rather than assuming they share the cause.
- Check `@libp2p/logger`'s `.error` gating, then either file the log-amplification finding or park
  item 4's concern as a `NOTE:` tripwire at `decodeJson`.
- Add the two missing item-4 tests (NUL padding → one log, correct count, per end and both ends;
  whitespace-only → no log).
- Re-run `cd packages/fret && yarn test` and `npx tsc --noEmit`; both must pass.
- Write the `complete/` ticket with the `## Review findings` section, folding in the *Established
  findings* above (items 1 and 2 clean; item 3 disposition; item 4 disposition; docs updated).
