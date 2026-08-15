description: Inbound peer-list announcements are now rate-limited and capped in size, so one oversized or spammed announcement can no longer force a node into thousands of expensive crypto operations. Reviewed and shipped.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/neighbors.ts, packages/fret/test/announce-rate-limit.spec.ts, docs/fret.md
---

## Summary

Implements threat-analysis §3.4 finding **M-core-2**: the inbound announce path was unbounded and unbucketed, unlike the neighbor-fetch merge. Two guards added in `fret-service.ts`:

1. **Inbound-announce token bucket** (`bucketAnnounceInbound`, Core 20/10, Edge 6/2). New `handleAnnounce(from, snap)` gate checks the bucket before any merge work; on rejection drops the message and increments `diag.rejected.rateLimited`. Wired at the `registerNeighbors` onAnnounce closure.
2. **Per-message merge caps** in `mergeAnnounceSnapshot`, sourced from new private helper `mergeSnapshotCaps()` (Core 16/16/8, Edge 8/8/6) shared with `mergeNeighborSnapshots` — single source of truth. Remote successors/predecessors/sample sliced before ingest.

`docs/fret.md` security section updated. New test file `test/announce-rate-limit.spec.ts` (6 cases).

## Review findings

**Verdict: ship as-is. No inline fixes required, no follow-up tickets filed.** Implementation is clean, DRY, well-commented, and correctly scoped.

### Checked — correct

- **Gate ordering (neighbors.ts).** Identity check (`snap.from === connection.remotePeer`) runs *before* `onAnnounce → handleAnnounce → bucket`. So a spoofed-`from` announce is dropped by the identity guard and never consumes a rate-limit token; only authenticated announces drain the bucket. Correct ordering.
- **Rate limit gates merge, not read/parse — by design.** The 128 KB `readAllBounded` + `decodeJson` in the announce handler run before the bucket check (bucket lives in `handleAnnounce`, invoked after decode). Intentional and documented: byte limit bounds parse, token bucket bounds the merge (hash+upsert) amplification that M-core-2 targets. See observation below.
- **Cap direction is safe.** Inbound merge caps (16/16/8, 8/8/6) are ≥ the outbound snapshot-build caps (`fret-service.ts:1112`, Core 12/12/8, Edge 6/6/6), so an honest snapshot from a same-or-smaller profile is never truncated. Cross-profile Core→Edge truncation (12 succ → 8) is pre-existing behavior in `mergeNeighborSnapshots`, not a regression.
- **Single source of truth correctly scoped.** `mergeSnapshotCaps()` folds only the *two merge paths*; the outbound-build caps at line 1112 are intentionally a distinct (smaller) constant set and correctly left separate — not a DRY violation.
- **No throw on rejection** → no inflight/counter desync. `void this.mergeAnnounceSnapshot(...)` fire-and-forget matches the pre-existing pattern.
- **`discovered` list (→ `announceToNewPeers` fanout) is now bounded** by the merge caps — an incidental improvement to announce amplification.
- **Type-check clean** (`npx tsc --noEmit` exit 0); **full suite 284 passing** (`yarn test`, ~4m). No pre-existing failures surfaced.

### Checked — tests

Test file drives the private handlers directly for determinism (no stabilization timing). Coverage: bucket-exhausted drop + counter + store unchanged; admit-with-tokens merge; Edge cap < Core cap; Core 30/30/20 → 41; Edge → 23; `mergeSnapshotCaps()` value assertion. The drop test uses the Edge profile (refill 2/sec = 500ms/token) so the drain→handleAnnounce gap cannot regenerate a token — deliberately non-flaky. Sample ids are plain strings (never `peerIdFromString`d), so the synthetic ids are valid. Store keyed by id, so absolute-size assertions hold.

### Minor gaps (accepted, not filed)

- **No end-to-end wire-path test of the gate** (register → announceNeighbors → readAllBounded → decode → gate). Implementer flagged; the identity portion is covered by `identity-verification.spec.ts`. An integration test spamming `announceNeighbors` and asserting `rejected.rateLimited > 0` would close it but is timing-sensitive. Not worth a ticket.
- **Refill/recovery over time untested.** Trivial `TokenBucket` behavior already covered by its own usage elsewhere.

### Observations (no action)

- **Parse-before-gate is architecture-wide, not new here.** Every FRET RPC handler reads+parses before its post-parse token bucket; inbound parse flooding is bounded by libp2p stream-concurrency limits (Max inbound 32 Edge / 128 Core), not by these buckets. Consistent with the whole codebase and out of M-core-2 scope. Mitigation (per-peer limiting) is already tracked in docs "not yet implemented".
- **Global, not per-peer bucket** → a hostile flood can drop honest announces (collateral). Explicitly out of scope; per-peer rate limiting remains planned in docs.
- **Sample coords still trusted as-is** (no re-hash). Separate planned item in docs; untouched.

### Tripwire (already parked by implementer — confirmed present, no action)

- `NOTE:` at the `bucketAnnounceInbound` init site (`fret-service.ts:~192`): the capacity/refill constants are first-cut guesses. Condition: if `diag.rejected.rateLimited` climbs in normal Core operation (large ring churn from distinct neighbors), raise the constants rather than assume an attack. Correctly a code comment, not a ticket. Verified in place.

## Validation

- `cd packages/fret && npx tsc --noEmit` → exit 0
- `cd packages/fret && yarn test` → 284 passing
