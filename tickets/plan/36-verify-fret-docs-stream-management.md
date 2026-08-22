description: Continue a read-and-correct pass checking the design doc's "Stream management" section against the code — first half already checked clean, second half still needs checking.
files: docs/fret.md, packages/fret/src/rpc/protocols.ts, packages/fret/src/rpc/request.ts, packages/fret/src/rpc/outcome.ts, packages/fret/src/rpc/ping.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/src/rpc/maybe-act.ts, packages/fret/src/rpc/leave.ts, packages/fret/src/service/fret-service.ts (registerRpcHandlers ~1233)
difficulty: easy
tradeoffs: The remaining claims are mostly constant-value checks and sender-body call-site checks, low risk of being wrong, so a maintainer may reasonably defer this until the next time this area is touched.
----

Continuation of a prior pass verifying `docs/fret.md`'s **Stream management** bullets against
code (the section covering read deadlines, stream release, the inbound handler seam, and the
agreement between the five outbound senders). The prior pass ran out of budget partway through.
This is a read-and-correct pass, not a code change: read each remaining bullet, find the code it
describes, and either confirm it or correct the text. Anything that turns out to be a genuine code
defect rather than a stale sentence should be filed on its own (a fresh ticket, not folded into
this one).

**Already checked and confirmed matching (no further work needed on these):**
- `RPC_TIMEOUT_MS` = 5000 (`src/rpc/protocols.ts`) is the whole-outbound-RPC budget (dial + open +
  write + read), not read-alone — matches doc.
- `MAINTENANCE_RPC_TIMEOUT_MS` = 2000, `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` = 1000, `SHUTDOWN_BUDGET_MS`
  = 3000, `LEAVE_NOTICE_TIMEOUT_MS` = 1500 (all `src/service/fret-service.ts`) — match the numbers
  the doc states.
- No `maxInboundStreams` / `maxOutboundStreams` passed to `node.handle` anywhere in the source —
  matches the doc's stream-cap bullet (defaults apply regardless of profile).
- `readFramed`'s two implementations (`readFramedFromStream` / `readFramedFromIterable`,
  dispatched by `isMessageStream`), no per-chunk idle timer anywhere in the function, cap enforced
  at the length prefix before any body byte — matches doc prose closely, including the
  "invariant: a frame the remote actually wrote is never reported as truncated" claim.
- `registerRpcHandler`'s success-close-budget / synchronous-abort-on-error rule, and
  `registerJsonHandler`'s two-tier "frame-level failure aborts, body-level failure closes" rule —
  both match the doc's description in detail (including the skip conditions for the abort arm).
- `RpcOutcome` (`src/rpc/outcome.ts`) variants — `ok`, `skipped`, `cancelled`, `timeout`,
  `unreachable`, `foreign-protocol`, `decode-error`, `busy` — match the doc's enumerated list
  exactly, including which are contact strikes vs proof-of-life.
- `sendMaybeAct` passes `halfCloseBeforeRead: true` to `rpcRequest` (confirmed via
  `src/rpc/maybe-act.ts:75`) — matches the doc's claim about the half-close pattern.
- `fetchNeighbors` passes `dial: 'never'` (confirmed via `src/rpc/neighbors.ts:116`) — matches the
  doc's claim that the snapshot fetch is connection-only.

**Still to verify:**
- Read the bodies of `sendPing` (`src/rpc/ping.ts`), `fetchNeighbors` / `announceNeighbors`
  (`src/rpc/neighbors.ts`), `sendMaybeAct` (`src/rpc/maybe-act.ts`), and `sendLeave`
  (`src/rpc/leave.ts`) in full, and confirm each is "a thin wrapper over `rpcRequest`" as the doc
  claims, with the specific per-sender details the doc states (e.g. `sendMaybeAct` deliberately
  left at the 5s default timeout because it's a route budget not a link one; `announceNeighbors` /
  `sendLeave` are write-only with no `decode`).
- Confirm the byte-cap constants the doc names: `MAX_ACTIVITY_BYTES` (128 KiB) +
  `MAYBE_ACT_OVERHEAD_BYTES` (16 KiB) = 144 KiB total for maybeAct; `MAX_NEIGHBORS_BYTES` (16 KiB,
  one number for both profiles); leave's fixed 4096. Find where each is declared and check the
  arithmetic the doc states around them (e.g. the Core worst-case snapshot byte count of 11,575
  claimed in the doc).
- Confirm the snapshot **emission** caps stay profile-split (Core 12/12/8, Edge 6/6/6, metadata
  allowance 8 KiB Core / 4 KiB Edge) as distinct from the acceptance counts and the byte cap, per
  the doc's closing paragraph on this.
- Read `registerRpcHandlers` (`src/service/fret-service.ts` ~1233) and confirm which of the five
  protocols (neighbors request, neighbors announce, maybeAct, leave, ping) sit on the
  `registerJsonHandler` seam vs which (maybeAct) parse inside their own handler body before taking
  the rate-limit bucket, matching the doc's claim about why maybeAct is the exception.
- Re-read the "inbound handlers release their stream on every path" paragraph in full against
  `registerRpcHandler` once more with fresh eyes (it was skimmed, not deeply checked) — in
  particular the claim that `status` alone cannot answer "did the handler already release this"
  and that the write-end status is the load-bearing check.

Work through these in order; each is a small, independent check. If everything above is
confirmed clean, close out with a `## Review findings` note that the read-and-correct pass found
no discrepancies and move the ticket to `complete/` per normal review-stage rules (this ticket
should transition to `implement/` only if a correction is actually needed — if the whole remaining
list confirms clean, this can go straight from this check to `complete/` since no code or doc
change is required; note that explicitly when you close it out).
