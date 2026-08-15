----
description: Messages are now only accepted while the duplicate-request cache still remembers them, request identifiers are unguessable, and the cache is sized to the node's role — reviewed, corrected, and shipped.
files: packages/fret/src/rpc/protocols.ts, packages/fret/src/service/fret-service.ts, packages/fret/src/service/dedup-cache.ts, packages/fret/src/index.ts, packages/fret/test/replay-hardening.spec.ts, packages/fret/test/payload-bounds-ttl.spec.ts, packages/fret/test/README.md, docs/fret.md, docs/threat-analysis.md, docs/threat-rir-mitigated.md, AGENTS.md
----

Three arms landed and were reviewed. Final state: `npx tsc --noEmit` clean, `yarn build` clean,
335 tests passing.

### What shipped

**1. Freshness window narrowed to the dedup TTL.** `validateTimestamp`'s default `maxDriftMs` is
30_000, matching `DEDUP_TTL_MS` (exported from `service/dedup-cache.ts`, re-exported from
`src/index.ts`, and the `DedupCache` constructor's own default). The two constants live in
different layers — `rpc/protocols.ts` cannot import from `service/` without inverting the
dependency direction — so the alignment is held by a test rather than by the type system
(see findings). All three `validateTimestamp` call sites (maybeAct, leave, neighbor snapshot)
take the default.

**2. Correlation IDs from the WebCrypto RNG.** Module-level `randomToken()` in
`fret-service.ts`: `crypto.randomUUID()`, falling back to `getRandomValues` (16 bytes, hex),
throwing when neither exists rather than degrading to a guessable id. `newCorrelationId(phase)`
keeps its `<selfId>-<timestamp>-<random>-<phase>` shape and its per-phase minting.

**3. Dedup capacity derived from the profile.** `dedupCache` is constructed (not
field-initialized — the profile isn't known that early) at 2048 for Core / 512 for Edge. FIFO
eviction untouched; `tickets/fix/15-dedup-cache-eviction` still owns that code.

### Review findings

**Read first:** the implement commit `d4c6be5` in full (src, test, docs), then the surrounding
code — `handleMaybeAct`/`cacheResponse`/`dedupKey`, the constructor's token-bucket block,
`TokenBucket`, `rpc/maybe-act.ts`, and every doc section naming the changed constants.

**Correctness — verified, no defects found.**

- *Window-vs-TTL direction is safe.* The dedup entry is stamped at **receipt**, the freshness
  check runs against the message's **creation** timestamp, so the entry always outlives the
  window by the network delay rather than expiring inside it. Aligning the two constants is
  sufficient; no slack remains.
- *Ordering in `handleMaybeAct` is right.* Breadcrumb check → dedup lookup → timestamp →
  TTL/size → rate limit → work. A replay inside the window is answered from cache without
  re-validating; one outside is rejected before any work.
- *`randomToken`'s throw is safely placed.* Its only callers are the two `newCorrelationId`
  calls at the head of `iterativeLookup`, so a missing WebCrypto surfaces to the caller rather
  than killing a background loop. `randomUUID`'s secure-context caveat in the doc comment is
  accurate.
- *No dash-parsing of correlation ids anywhere in `src/`* — confirmed by grep — so switching the
  random segment to a dashed UUID broke no consumer. The tests that do split are careful to
  `slice(2, -1).join('-')`.

**Capacity claim — checked by arithmetic; sound, but the stated reason was wrong.** The
implement comment justified the sizes by "Core carries the higher inbound rate and is the harder
node to flush," which is hand-waving. Only a rate-limited request reaches `cacheResponse`, so the
real ceiling on attacker-inserted entries per TTL is `burst + refill × TTL`: Core `32 + 16/s × 30s
= 512`, Edge `8 + 4/s × 30s = 128` — each exactly a quarter of the capacity chosen. So the sizes
are correct and, notably, Edge's *drop* from the old flat 1024 to 512 is not a weakening: it still
holds 4× what the Edge rate limit can force. Rewrote the comment to carry that arithmetic
(`fret-service.ts` constructor) so the next person tuning the buckets sees the coupling.

**Minor — fixed in this pass.**

- `fret-service.ts:169` had a dangling `{@link dedupCapacity}` pointing at a member that does not
  exist. Rewritten to point at the constructor.
- The `carries at least 128 bits of randomness` test overstated `randomUUID`, which spends 6 of
  its 128 bits on version/variant fields (122 random). Retitled and the comment corrected; the
  assertion itself (≥32 hex digits) was already right. `test/README.md` line matched.
- `docs/threat-analysis.md` §3.6 (*Dedup Cache Poisoning*) is squarely about the capacity this
  ticket changed and was left un-annotated, still describing a flat 1024-entry cache. Added a
  `Status — mitigated` line with the rate-limit arithmetic above. Summary-table row 12 ("Replay
  attacks with 9.5-minute window") likewise still read as open; struck through with the
  leave-notice arm called out as the part still open.

**Test gaps — one closed, two accepted.**

- *Closed:* nothing asserted that the tightening actually rejects anything new. The existing
  `handleMaybeAct` coverage used a 10-minute-stale message, which the **old** ±5 min default also
  rejected, so it would have passed unchanged had the tightening been reverted. Added a 60 s-stale
  case (distinct correlation id, so the cache cannot answer first) asserting
  `rejected.timestampBounds` increments — a real regression guard for the new bound.
- *Accepted:* the capacity test reads `(svc as any).dedupCache.maxSize`. Proving 2048 slots
  behaviorally means ~2049 inbound RPCs at 16/s — minutes of wall clock for a constant. The
  white-box read is the right trade; it proves the profile is wired, which is what changed.
- *Accepted:* the "neither `randomUUID` nor `getRandomValues`" throw stays read-only-verified.
  Faking it means deleting `globalThis.crypto`, which libp2p in the same process needs.

**Invariant guard — better than the handoff claimed.** The handoff says the TTL/window alignment
is "held by comment on both sides, not by the type system." It is in fact held by a test:
`payload-bounds-ttl.spec.ts` → *"defaults to the dedup TTL"* asserts `DEDUP_TTL_MS ± 1s` against
`validateTimestamp`'s default and fails if **either** constant moves without the other (checked
both directions). That is rung 2 of the architecture ladder — a generalized test over the class —
so the two literals were left in place rather than forcing an `rpc/ → service/` import to
collapse them.

**Tripwires recorded (not filed as tickets).**

- Clock skew now has a 30 s budget — the tightest sync requirement in the system — and a skewed
  peer presents only as a rising `timestampBounds` tally. `NOTE:` at the rejection site in
  `handleMaybeAct` saying to record the observed offset if skew ever needs diagnosing in the
  field. Conditional: costs nothing until someone has to debug a real deployment.
- Dedup capacity is coupled to the `bucketMaybeAct` rates by arithmetic, not by code. `NOTE:` at
  the sizing site: raising the bucket without raising the capacity re-opens the eviction hole.
- `yarn format:check` fails on all 21 source files and `yarn format` would rewrite the whole
  codebase into space indentation — no prettier config reconciles it with the repo's tabs. This
  is the second review to rediscover it (the first recorded it in
  `tickets/complete/3-membership-classification-strength`, which nobody greps), so it now lives
  where a contributor meets it: a `NOTE:` in AGENTS.md's Development quickstart, with the revisit
  condition (a prettier config matching the tab style).

**Filed elsewhere — one arm, no new ticket.** `handleMaybeAct` uses the sender-supplied
`correlation_id` verbatim as the dedup cache key with no length check; the only bound is the
512 KB whole-message cap. The cache bounds entry *count*, not entry *size*, so a sender can
inflate the memory a full cache holds for 30 s by orders of magnitude over a normal ~100-character
id. Pre-existing (the cache predates this ticket) and not worsened by it — the rate limit, not the
capacity, is what bounds insertions. The root cause is the absent per-message field validator,
whose site is already claimed by `tickets/plan/8-rpc-shared-helper` ("No shape validation of
decoded messages"), so this was appended there as an arm rather than filed as a separate ticket.

**Empty categories, with reasons.**

- *No `fix/` or `backlog/` tickets filed.* Every defect found was either a comment/doc/test
  inaccuracy fixable in this pass, or an instance of a class whose site is already claimed.
- *No `blocked/` tickets.* Nothing here needs a human decision; the one judgment call the handoff
  flagged (whether clock skew deserves a distinct signal) is genuinely conditional and became a
  tripwire.
- *No lint findings.* The repo has no lint step — `yarn check` (typecheck + build + test) is the
  gate, and all three are clean. See the prettier tripwire above for why `format:check` is not one.
- *No performance findings.* The diff adds one `crypto.randomUUID()` per lookup phase (two per
  lookup) and 30 bytes to a correlation id on the wire; neither is on a hot path.

### Known limitations carried forward (unchanged by this review)

- **Leave-notice replay is untouched** — no correlation id, no dedup — and remains owned by the
  leave-authentication work. `docs/fret.md`'s planned list carries that arm; `threat-analysis.md`
  §3.3's status line names it explicitly as the part still open.
- **`docs/threat-analysis.md` is stale beyond this ticket's arms.** §3.7 still describes a 100 ms
  idle read timeout that no longer exists, §3.4's zero-inbound-announce-rate-limit claim is
  outdated, and several sections predate later work. The four sections this ticket's arms touch
  (§3.2, §3.3, §3.6, §5.4, §5.6, plus summary row 12) are now annotated; the rest is not, and the
  file should not be read as current.
- **A caller may still pass a wider `maxDriftMs`** for poor clock sync, which re-opens the replay
  gap by exactly that amount. Documented at `validateTimestamp` and in `docs/fret.md`.
