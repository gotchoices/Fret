description: Finish a read-and-correct pass checking the design doc's "Stream management" section against the code — two items left after three verification passes.
files: docs/fret.md, packages/fret/src/service/fret-service.ts (snapshot() ~2702, registerRpcHandler in packages/fret/src/rpc/protocols.ts)
difficulty: easy
tradeoffs: The remaining claims are one numeric check and one careful re-read of already-implemented code, low risk of being wrong, so a maintainer may reasonably defer this until the next time this area is touched.
---

Continuation of a prior pass verifying `docs/fret.md`'s **Stream management** bullets against
code. Three prior passes ran out of budget partway through. This is a read-and-correct pass, not
a code change: read each remaining bullet, find the code it describes, and either confirm it or
correct the text. Anything that turns out to be a genuine code defect rather than a stale sentence
should be filed on its own (a fresh ticket, not folded into this one).

**Already checked and confirmed matching in this and prior passes (no further work needed):**
- All bullets listed as confirmed in the prior ticket (36-verify-fret-docs-stream-management,
  now deleted) — RPC_TIMEOUT_MS/MAINTENANCE_*_TIMEOUT_MS/SHUTDOWN_BUDGET_MS/LEAVE_NOTICE_TIMEOUT_MS
  constants, stream-cap defaults, readFramed's two implementations and truncation invariant,
  registerRpcHandler / registerJsonHandler two-tier rule description, RpcOutcome variants,
  halfCloseBeforeRead / dial:'never' claims, all five sender wrappers, byte-cap constants
  (MAX_ACTIVITY_BYTES, MAYBE_ACT_OVERHEAD_BYTES, MAX_NEIGHBORS_BYTES, the 11,575-byte Core figure).
- **New this pass:** `registerRpcHandlers` (`src/service/fret-service.ts:1233-1283`) confirmed —
  maybeAct registers via `registerMaybeAct` (parses inside its own handler body, after its
  rate-limit bucket, per the inline `NOTE` at lines 1249-1253); neighbors/leave/ping register via
  the shared `registerJsonHandler`-based registrars (`registerNeighbors`, `registerLeave`,
  `registerPing`). This matches the doc's claim about why maybeAct is the exception, exactly.
- **New this pass:** `mergeSnapshotCaps()` (`src/service/fret-service.ts:2006-2010`) confirmed —
  returns `{successors: 16, predecessors: 16, sample: 8}` for `core`, `{8, 8, 6}` for edge. This is
  the *acceptance*-side cap (what an inbound snapshot message is truncated to before merge), and it
  matches the doc's "Security and abuse considerations" section numbers (Core 16/16/8, Edge 8/8/6)
  exactly. This is a separate number from the *emission* caps still to check below — don't conflate
  the two when closing this out.

**Still to verify:**
- Confirm the snapshot **emission** caps stay profile-split (Core 12/12/8, Edge 6/6/6, metadata
  allowance 8 KiB Core / 4 KiB Edge) as distinct from the acceptance counts just confirmed above and
  the byte cap. Read `snapshot()` (`src/service/fret-service.ts` ~2702) — this is the outgoing
  snapshot builder, called from the maintenance fan-outs (lines 1314, 1624, 1958, 1978) — and find
  where it pulls its id-list limits and metadata allowance from (likely a sibling private
  method/constant near `snapshot()`, analogous to how `mergeSnapshotCaps()` serves the acceptance
  side). Check the actual numbers against the doc's 12/12/8, 6/6/6, 8 KiB/4 KiB claims.
- Re-read the "inbound handlers release their stream on every path" paragraph in full against
  `registerRpcHandler` (`src/rpc/protocols.ts`) once more with fresh eyes (it was skimmed, not
  deeply checked in any of the three prior passes) — in particular the claim that `status` alone
  cannot answer "did the handler already release this" and that the write-end status is the
  load-bearing check.

Work through these in order; each is a small, independent check. If everything above is
confirmed clean, close out with a `## Review findings` note that the read-and-correct pass found
no discrepancies and move the ticket to `complete/` per normal review-stage rules (this ticket
should transition to `implement/` only if a correction is actually needed — if the whole remaining
list confirms clean, this can go straight from this check to `complete/` since no code or doc
change is required; note that explicitly when you close it out).
