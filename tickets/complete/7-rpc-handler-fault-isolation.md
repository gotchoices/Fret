description: Inbound RPC handlers used to leak their network connection slot forever when a malformed or misbehaving message made them fail partway through; the leak is fixed, the malformed-input surface is validated, and both are covered by tests.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, packages/fret/test/rpc.stream-errors.spec.ts, docs/fret.md
----

### What shipped

A single registration seam, `registerRpcHandler(node, protocol, serve)` in
`src/rpc/protocols.ts`, now wraps every inbound FRET handler and owns stream release. All five
`node.handle` sites (neighbors request, announce, maybeAct, leave, ping) go through it and their
per-handler `try/catch` blocks are gone; `node.handle` appears exactly once in `src/` now.

Around that root fix, three hardening arms that remove the ways a handler could throw in the
first place:

- `decodeJson` rejects a non-object JSON top level (`null`, array, number, string, boolean), so
  no handler body null-checks what it decoded.
- `sanitizeReplacements` (`src/rpc/leave.ts`) treats a non-array `replacements` field as absent
  and skips non-string entries, instead of reaching `.slice` on a number and throwing.
- `validateRouteAndMaybeAct` (`src/rpc/maybe-act.ts`) structurally validates an inbound
  `RouteAndMaybeAct` — field types, finite numbers, a decodable `key`, and caps on `key` (1024
  chars) / `correlation_id` (256) / `breadcrumbs` (64). `FretService.handleMaybeAct` calls it
  immediately after `bucketMaybeAct.tryTake()` and before every other guard; rejection is a
  `staticReject()` plus a new `diag.rejected.malformed` counter. The key is decoded once in the
  handler and handed to `routeAct` / `nearAnchorOnly` via a new optional parameter.

### Gates

- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && yarn test` — **775 passing, 0 failing** (~3m), after the review fixes
  below. No pre-existing failures surfaced, so no `.pre-existing-error.md` was written.
- There is no lint step in this repo (`yarn check` = typecheck + build + test; `yarn format` is
  documented as unusable against the house tab style — see AGENTS.md).

---

## Review findings

### Major — root-cause defect in the seam itself (fixed in this pass)

**`stream.status === 'open'` cannot answer "did the handler already release this stream?", and
the wrapper used it for exactly that.** libp2p streams are half-closable: `Stream.close()` closes
the *write* end only, and `status` stays `'open'` until the **remote** also closes its write end
— which for every FRET sender happens only after it has read the reply. So on every real
connection, a handler that replied and closed still presented `status === 'open'` to the wrapper.

Consequences, both arms:

- Success arm — the "release only a stream still `open`" guard never fired as intended; it worked
  only because `close()` happens to be idempotent.
- Error arm — a handler that closed its write end and *then* threw would have been `abort()`ed,
  resetting a stream whose reply was already committed to the wire. The sender would see a reset
  instead of the answer it was reading. No handler takes that shape today, so this was latent,
  not live — but it is the behavior the seam's contract promises not to have.

Verified against the vendored implementation, not inferred: `@libp2p/utils/dist/src/abstract-stream.js`
`close()` sets `writeStatus = 'closed'` and only calls `onTransportClosed()` (which is what sets
`status = 'closed'`) when `remoteWriteStatus === 'closed'`.

Fixed at the one site: the success arm now calls `close()` unconditionally (it early-returns once
our write end is closing/closed, so it is a no-op rather than a second release), and the error arm
guards on `stream.status === 'open' && stream.writeStatus !== 'closed'`.

**Why this was not caught: the unit-tier stub modelled `close()` as fully closing the stream.**
`inboundStub` in `test/rpc.handler-fuzz.spec.ts` set `status = 'closed'` on close, so two
assertions — "does not re-release a stream the handler already closed" and "does not abort a
stream the handler closed before throwing" — passed for a reason production never supplies. The
stub now mirrors libp2p (`writeStatus` tracked separately; `close()` early-returns and leaves
`status` at `'open'`; `abort` and a remote reset both close the write end). Every existing
assertion still holds, now for the right reason, and one was strengthened to assert the stream is
still `'open'` at that point.

### Minor — fixed in this pass

- **`ping.ts`: the size-estimate `try` was wider than the estimate.** It also wrapped the
  send-and-close reply tail, so a stream that failed mid-reply was logged as `getSizeEstimate
  failed` and then answered a *second* time on the same broken stream. Extracted `pingReply()`;
  the `try` now covers the provider call alone and there is one send/close path in the handler.
- **Stale "64 Edge / 256 Core" outbound stream caps** in the `releaseRpcStream` doc comment and in
  `test/rpc.stream-errors.spec.ts` — the fiction `docs/fret.md` already corrected. Both now state
  libp2p's default of 64 per protocol per connection. (Flagged by the implementer as safe to fix
  inline; done.)
- **Stale ticket slug `8-rpc-shared-helper`** in `protocols.ts` and `neighbors.ts` comments — that
  slug does not exist; the live ticket is `plan/15-rpc-shared-helper`. Pre-existing, in files this
  change touches, so corrected here.
- **The `estimated_cluster_size >= 15` discriminator** the handoff flagged as brittle (it encodes
  the default `k`). A static reject reports 0 and a real answer reports at least `k`, so
  `> 0` discriminates just as well without pinning the default. Changed at all four sites.
- **`docs/fret.md`** — the *Stream management* inbound-release paragraph described the
  `status`-only rule that was wrong; rewritten to state the write-end rule and why `status` alone
  cannot express it.

### Tripwires — recorded at the site, not filed as tickets

- **`registerRpcHandler`'s success-path `close()` is unbounded on the write side.** It waits for
  the write queue to drain, so a remote that stops reading holds the handler and its stream slot
  with no budget of its own — the write-side twin of the existing read-side slow-loris note on
  `readAllBounded`. Not reachable today (FRET replies fit a muxer window), so it is conditional,
  not a defect. `NOTE:` at the seam, naming the fix (an `AbortOptions` deadline on the close).
- **The seam still reads libp2p's stream lifecycle**, which the handoff called out as a silent-
  weakening risk if libp2p changes it. Partly retired rather than merely noted: the predicate is
  now the narrower `writeStatus`, the stub encodes the real lifecycle (so a change to it breaks
  the unit tier rather than sliding past), and the wire-tier tests remain status-blind — they
  assert on observed stream release over a real transport. No further action.

### Checked and found clean

- **Coverage of the root fix.** `node.handle` appears exactly once in `src/` — no handler bypasses
  the seam.
- **Guard ordering in `handleMaybeAct`** — bucket → validator → breadcrumbs → dedup → timestamp →
  TTL → payload size → in-flight cap. The ordering the ticket claims, and the "malformed messages
  are metered" property is pinned by a test that drains an Edge bucket with a malformed burst and
  asserts every message hit exactly one of `malformed` / `rateLimited`.
- **`validateRouteAndMaybeAct` rejects what it claims.** `Number.isFinite` does not coerce, so
  `want_k: "abc"` (the NaN-window shape) is rejected rather than silently disabling the membership
  test. Confirmed empirically that `uint8arrays` base64url decoding throws on non-alphabet input
  and on truncated input, so the `key` check is a real check; `key: ""` decodes to an empty
  coordinate input, which `hashKey` handles.
- **`registerRpcHandler` error arm on a remote-reset stream** — status has already left `'open'`,
  so nothing is released twice. Pinned at both the unit and wire tiers.
- **The `unknown`/`foreign`/dead-peer and identity-mismatch paths** — mismatch drops close, never
  abort, on both leave and announce; both counted.
- **Announce merge with a non-array `successors`/`sample`** — throws into
  `mergeAnnounceSnapshot`'s own catch, and that merge is `detach`ed off the handler's stream path,
  so it cannot leak a stream. A validator for the other four wire messages is deliberately
  `plan/15-rpc-shared-helper`'s scope, not a gap here.
- **Test-suite hygiene** — the new spec's `unhandledRejection` guard is registered on its own
  `describe` (a top-level hook would be a root hook over the whole suite), and the deleted
  `test/rpc.fuzz.spec.ts` was fully superseded.

### Deliberately not filed

- **Oversized-payload and rate-limit-*enforcement* tiers** — owned by
  `implement/7.5-rpc-codec-property-tests`, which has `prereq:` on this slug. Out of scope by
  design, not an oversight.
- **Profile-split stream caps** — the fictional Edge/Core cap split that `docs/fret.md` used to
  claim is already tracked as `backlog/debt-inbound-stream-caps-unimplemented`. Confirmed the
  ticket exists; no duplicate filed.
