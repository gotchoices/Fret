description: Finish a read-and-correct pass checking the design doc's "Stream management" section against the code — one item left after four verification passes.
files: docs/fret.md, packages/fret/src/rpc/protocols.ts (registerRpcHandler)
difficulty: easy
tradeoffs: The remaining claim is a careful re-read of already-implemented code (not a numeric check), low risk of being wrong, so a maintainer may reasonably defer this until the next time this area is touched.
---

Continuation of a prior pass verifying `docs/fret.md`'s **Stream management** bullets against
code. Four prior passes ran out of budget partway through. This is a read-and-correct pass, not
a code change: read the remaining bullet, find the code it describes, and either confirm it or
correct the text. Anything that turns out to be a genuine code defect rather than a stale sentence
should be filed on its own (a fresh ticket, not folded into this one).

**Already checked and confirmed matching in this and prior passes (no further work needed):**
- All bullets listed as confirmed in the prior ticket (37-verify-fret-docs-stream-management,
  now deleted) — RPC_TIMEOUT_MS/MAINTENANCE_*_TIMEOUT_MS/SHUTDOWN_BUDGET_MS/LEAVE_NOTICE_TIMEOUT_MS
  constants, stream-cap defaults, readFramed's two implementations and truncation invariant,
  registerRpcHandler / registerJsonHandler two-tier rule description, RpcOutcome variants,
  halfCloseBeforeRead / dial:'never' claims, all five sender wrappers, byte-cap constants
  (MAX_ACTIVITY_BYTES, MAYBE_ACT_OVERHEAD_BYTES, MAX_NEIGHBORS_BYTES, the 11,575-byte Core figure),
  registerRpcHandlers' maybeAct-is-the-exception claim, mergeSnapshotCaps() acceptance-side numbers
  (Core 16/16/8, Edge 8/8/6).
- **New this pass:** snapshot *emission* caps confirmed against `snapshot()`
  (`packages/fret/src/service/fret-service.ts:2800-2852`) — `capSucc`/`capPred` = 12 (core) / 6
  (edge), `capSample` = 8 (core) / 6 (edge), matching the doc's Core 12/12/8, Edge 6/6/6 exactly.
  Metadata allowance confirmed too: `MAX_SNAPSHOT_METADATA_BYTES_CORE` = 8 * 1024 and
  `MAX_SNAPSHOT_METADATA_BYTES_EDGE` = 4 * 1024 (`packages/fret/src/rpc/validate.ts:137,142`),
  matching the doc's 8 KiB Core / 4 KiB Edge exactly. This is distinct from the *acceptance*-side
  `mergeSnapshotCaps()` numbers already confirmed in the prior pass — don't conflate the two.

**Still to verify:**
- Re-read the "inbound handlers release their stream on every path" paragraph in full against
  `registerRpcHandler` (`packages/fret/src/rpc/protocols.ts`) once more with fresh eyes (it was
  skimmed, not deeply checked in any of the four prior passes) — in particular the claim that
  `status` alone cannot answer "did the handler already release this" and that the write-end
  status is the load-bearing check. Read the actual `registerRpcHandler` implementation and its
  close/abort logic, and check each specific sub-claim in that doc paragraph against it:
  - the success-path close is budgeted (has its own deadline separate from the RPC timeout)
  - a close that exhausts its budget lands in the same catch arm as a thrown handler, but is
    logged distinctly
  - the error arm is skipped for a stream whose write end the handler already closed, and for one
    already reset by the remote (`status` already `open`... check what field is actually read)
  - identity-mismatch drops (leave/announce) close rather than abort

Work through this single check. If it confirms clean, close out with a `## Review findings` note
that the read-and-correct pass found no discrepancies and move the ticket to `complete/` per
normal review-stage rules (this ticket should transition to `implement/` only if a correction is
actually needed — if the whole remaining item confirms clean, this can go straight from this check
to `complete/` since no code or doc change is required; note that explicitly when you close it
out).
