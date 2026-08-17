description: Inbound RPC handlers used to leak their network connection slot forever when a malformed or misbehaving message made them fail partway through — this is now fixed, tested, and ready for review.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, docs/fret.md
difficulty: easy
----

### What landed

All four phases of the original ticket, implemented and gated:

- **(a) Registration seam** — `registerRpcHandler(node, protocol, serve)` in
  `src/rpc/protocols.ts`. Wraps every inbound handler: on success, closes a stream the handler
  left `open` (never re-releases a closed one); on error, logs and `abort()`s only a stream
  still `open` (so a remote-reset stream is left alone). All five `node.handle` sites
  (neighbors request, announce, maybeAct, leave, ping) moved onto it; their per-handler
  `try/catch` deleted; ping's previously unguarded reply tail is now inside the guard.
- **(b)** `decodeJson` rejects a non-object top level (`null`, array, number, string, boolean).
- **(c)** `sanitizeReplacements` (`src/rpc/leave.ts`) requires `Array.isArray` and skips
  non-string entries — a numeric `replacements` field is treated as absent, not a throw.
- **(d)** `validateRouteAndMaybeAct` exported from `src/rpc/maybe-act.ts` (pure type guard,
  caps: key 1024 chars, correlation_id 256, breadcrumbs 64). Called in
  `FretService.handleMaybeAct` immediately after `bucketMaybeAct.tryTake()` and before the
  breadcrumb check; rejection = `staticReject()` + new `diag.rejected.malformed` counter.
  The key is decoded once in the handler and handed down — `routeAct(msg, keyBytes?)` /
  `nearAnchorOnly(msg, keyBytes?)` grew an optional param (public interface unchanged;
  extra optional param is assignable).

### Gate results (this session)

- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && yarn test` — **775 passing, 0 failing** (~3m). No pre-existing-failure
  report needed.

### Validation surface for the reviewer

`test/rpc.handler-fuzz.spec.ts` (replaces the deleted `test/rpc.fuzz.spec.ts`) is where to look
first — it is the malformed-input matrix this ticket exists to cover:

- **Release-exactly-once on stub streams**: close for completed replies and identity-mismatch
  drops, abort for handler errors, nothing for an already remote-reset stream.
- **Decoder truth table** for `decodeJson` (object vs `null`/array/number/string/boolean top
  level).
- **Validator truth table** for `validateRouteAndMaybeAct`, including the `want_k: "abc"` NaN
  edge case (see gap below).
- Static/uncached/metered rejection ordering at the service tier (bucket → validator → other
  guards).
- The full malformed matrix run over the in-memory transport with per-row assertions that the
  inbound stream was actually released (not just that the handler didn't throw).
- A 16-wide concurrent burst, and a 40-message batch-then-recover run on one connection, over
  both the in-memory transport and TCP+noise+yamux.
- The sender-aborts-mid-ping shape.
- A describe-level `unhandledRejection` guard, so a leaked rejection anywhere in the suite fails
  loud instead of silently passing.

Use cases to exercise manually if reviewing by hand: send a non-object JSON body to any of the
five protocols; send `maybeAct` with an oversized `breadcrumbs` array or a non-string `key`;
send `leave` with a numeric `replacements` field; kill a connection mid-handler. In every case
the fix is that the inbound stream is released (closed or aborted) and the protocol keeps
working for the next message on that connection — pre-fix, ~32 such messages permanently
poisoned the protocol on that connection (libp2p's default inbound stream cap).

### Docs

`docs/fret.md` updated: inbound-release contract added to *Stream management*; the fictional
Edge/Core stream-cap split corrected (no caps are passed; libp2p default 32/64 per protocol per
connection; points at `backlog/debt-inbound-stream-caps-unimplemented`); validator + its
bucket-relative position added to *Cheap-guard rejections*; top-level-object decoder rule added
to *Wire formats*.

### Honest gaps for review

- `estimated_cluster_size ≥ 15` is used in the spec as the "real answer vs static reject"
  discriminator — fine while `k` defaults to 15, brittle if the default moves.
- The seam releases based on `stream.status === 'open'`; a libp2p change to status lifecycle
  would silently weaken it. Partially covered: the wire-tier tests in this spec are status-blind
  (they assert on stream-release side effects over a real transport, not on the `status` field
  itself), so a lifecycle change would surface as a release-assertion failure there even though
  it wouldn't be caught at the unit level.
- Code comments in `releaseRpcStream` (`src/rpc/protocols.ts`) and
  `test/rpc.stream-errors.spec.ts` still cite the fictional "64 Edge / 256 Core" outbound caps —
  docs (`docs/fret.md`) were corrected, these comments were not. Cosmetic; safe to fix inline
  during review.
- `7.5-rpc-codec-property-tests` (queued in `tickets/implement/`, `prereq:` on this slug) owns
  the oversized-payload and rate-limit-enforcement tiers — deliberately out of scope here, not
  forgotten.

### Suggested review focus

1. Confirm `registerRpcHandler`'s open/close/abort branching against the five call sites — this
   is the root-cause fix, everything else is validation hardening around it.
2. Confirm bucket-before-validator-before-other-guards ordering in `handleMaybeAct` (a flood of
   malformed messages must still be metered, not free).
3. Spot-check the malformed matrix in the new spec covers what the reviewer would think to
   fuzz; add cases inline if not exhaustive enough for the review bar.
