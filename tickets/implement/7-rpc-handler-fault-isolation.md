----
description: A badly-formed network message used to make the receiving code fail halfway through answering and never release the connection slot it arrived on. The fix and its regression tests are written and passing; what remains is running the full test suite as the final gate and writing the review handoff.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/rpc.handler-fuzz.spec.ts, docs/fret.md
difficulty: easy
----

<!-- resume-note: prior run implemented everything below and was stopped by BUDGET_WARNING
before the full-suite gate. Do not re-implement — verify and hand off. -->

### Already done (implemented, type-checked, new spec green)

All four phases of the original ticket landed:

- **(a) Registration seam** — `registerRpcHandler(node, protocol, serve)` in
  `src/rpc/protocols.ts`. Wraps every inbound handler: on success, closes a stream the handler
  left `open` (never re-releases a closed one); on error, logs and `abort()`s only a stream
  still `open` (so a remote-reset stream is left alone). All five `node.handle` sites
  (neighbors request, announce, maybeAct, leave, ping) moved onto it; their per-handler
  `try/catch` deleted; ping's previously unguarded reply tail is now inside the guard.
- **(b)** `decodeJson` rejects a non-object top level (`null`, array, number, string, boolean).
- **(c)** `sanitizeReplacements` (`src/rpc/leave.ts`) requires `Array.isArray` and skips
  non-string entries — a numeric `replacements` is treated as absent, not a throw.
- **(d)** `validateRouteAndMaybeAct` exported from `src/rpc/maybe-act.ts` (pure type guard,
  caps: key 1024 chars, correlation_id 256, breadcrumbs 64). Called in
  `FretService.handleMaybeAct` immediately after `bucketMaybeAct.tryTake()` and before the
  breadcrumb check; rejection = `staticReject()` + new `diag.rejected.malformed` counter.
  The key is decoded once in the handler and handed down — `routeAct(msg, keyBytes?)` /
  `nearAnchorOnly(msg, keyBytes?)` grew an optional param (public interface unchanged;
  extra optional param is assignable).
- **Spec** — `test/rpc.fuzz.spec.ts` deleted; `test/rpc.handler-fuzz.spec.ts` added, covering
  every edge case in the original ticket: release-exactly-once on stub streams (close for
  completed replies and identity-mismatch drops, abort for errors, nothing for remote-reset),
  decoder truth table, validator truth table (incl. the `want_k: "abc"` NaN-window wart),
  static/uncached/metered rejection at the service tier, the full malformed matrix over the
  memory transport with per-row open-stream assertions, a 16-wide concurrent burst, 40-message
  batch-then-recover on one connection over both memory and TCP+noise+yamux, the sender-aborts-
  ping shape, and a describe-level `unhandledRejection` guard. **Ran green in the prior run: 50
  passing.**
- **Docs** — `docs/fret.md`: inbound-release contract added to *Stream management*; the
  fictional Edge/Core stream-cap split corrected (no caps are passed; libp2p default 32/64 per
  protocol per connection; points at `backlog/debt-inbound-stream-caps-unimplemented`);
  validator + its bucket-relative position added to *Cheap-guard rejections*; top-level-object
  decoder rule added to *Wire formats*.
- `npx tsc --noEmit` clean.

### Remaining — the gate, then hand off

- Run `cd packages/fret && npx tsc --noEmit && yarn test` (full suite — the prior run only ran
  the new spec). Expected risk: near zero, but two specs assert on handler behavior the seam
  changed — `rpc.stream-errors.spec.ts` (sender-side; should be untouched) and any spec that
  drove an inbound handler with garbage expecting silent logging. If a failure is plainly
  pre-existing, follow the pre-existing-failure protocol; failures caused by these changes are
  ours to fix.
- Write the review/ handoff (`tickets/review/7-rpc-handler-fault-isolation.md`) summarizing the
  above for the reviewer: emphasize the malformed matrix as the validation surface, the
  release-exactly-once invariant, the bucket-before-validator ordering, and that
  `7.5-rpc-codec-property-tests` (already queued, prereq on this slug) owns the oversized-payload
  and rate-limit-enforcement tiers. Honest gaps to flag for review:
  - `estimated_cluster_size ≥ 15` is used in the spec as the "real answer vs static reject"
    discriminator — fine while `k` defaults to 15, brittle if the default moves.
  - The seam releases based on `stream.status === 'open'`; a libp2p change to status
    lifecycle would silently weaken it (covered by the wire-tier tests, which are status-blind).
  - Code comments in `releaseRpcStream` / `rpc.stream-errors.spec.ts` still cite the fictional
    "64 Edge / 256 Core" outbound caps; docs corrected, comments not — cosmetic, reviewer may
    fix inline.
- Delete this ticket when the handoff lands.
