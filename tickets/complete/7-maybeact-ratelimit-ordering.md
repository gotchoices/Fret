description: Fixed a bug where a flood of trivially-invalid requests could dodge the server's rate limiter and still force it to do expensive work, by checking the rate limit before that work runs and by making the invalid-message replies cheap.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/pick-anchors.spec.ts, packages/fret/test/payload-bounds-ttl.spec.ts, docs/fret.md
----

## What changed

`handleMaybeAct` (fret-service.ts) takes the `bucketMaybeAct` rate-limit token as the very
first thing it does, before any per-message work — breadcrumb-loop check, dedup lookup,
timestamp freshness, TTL, oversized payload. Previously those guards ran first and each
rejection called `nearAnchorOnly()`, which hashes the key and runs two membership-filtered
ring walks plus two next-hop selections. A flood of already-invalid messages (stale
timestamp, `ttl: 0`) therefore never touched the bucket and still forced that per-message
ring work every time.

The four cheap-guard rejection paths (loop, stale/future timestamp, expired TTL, oversized
payload) return a new `staticReject()` — a hardcoded `NearAnchorV1` with empty
`anchors`/`cohort_hint` and `estimated_cluster_size`/`confidence` both `0`. No key hashing,
no ring walk, no next-hop selection.

`nearAnchorOnly()` is unchanged and now has exactly one caller: the `catch` arm when
`routeAct()` throws unexpectedly. That runs after the token was spent and real routing was
attempted, so a real ring walk is worth its cost there.

## Review findings

**Checked**: the implement-stage diff (`2e7d060`) read before its handoff summary; the full
`handleMaybeAct` guard chain and each rejection path; every consumer of `NearAnchor.anchors`
in `iterativeLookup` (empty anchors fall back to the local cohort — graceful, no dead-end);
the dedup cache's capacity/TTL reasoning against the new ordering (its "only a rate-limited
request reaches `cacheResponse`" premise is now *more* true, not less); the other three
inbound handlers (`handleNeighborsRequest`, `handlePingRequest`, `handleLeave`,
`handleAnnounce`) to confirm they were already bucket-first, so the doc claim about ordering
holds service-wide; `docs/fret.md` against the new behavior. Ran `npx tsc --noEmit` (clean)
and the full `yarn test` (344 passing). There is no lint step in this repo — `yarn check`
(typecheck + build + test) is the gate, per AGENTS.md, and `yarn format` is documented as
not-runnable here.

**Minor — fixed in this pass:**

- *The behavior change had no regression test.* The implementer flagged the omission and
  called it belt-and-suspenders; it is not — reverting the ordering to guards-first passes
  every existing test in the suite, which makes the fix free to undo by accident. Added
  `test/payload-bounds-ttl.spec.ts` → "rate limit precedes the cheap validity guards": one
  test that a single `ttl: 0` message still spends a token, one that 40 such messages
  produce at least one `busy` reply.
- *`docs/fret.md` was stale in one place and silent in another.* The breadcrumbs bullet
  still said a loop "answers with anchors only", which is exactly what stopped being true;
  corrected to say it answers an empty `NearAnchor`. Added a "Cheap-guard rejections"
  subsection under the maybeAct routing rule stating the ordering, why it is load-bearing,
  what a guard rejection now returns, the one remaining real-anchor case, and that guard
  rejections are never cached. Extended the security section's rate-limiting bullet to point
  at it.

**Major — none.** The ordering, the static reply, and the narrowing of `nearAnchorOnly` to a
single caller are each correct and minimal; no root-cause class was found behind this
instance, so nothing was filed.

**Tripwires — two, both parked as `NOTE:` at their code site, not filed as tickets:**

- Putting the dedup lookup behind the bucket means that under an empty bucket a legitimate
  retry gets `busy` instead of its cached certificate. Not an idempotency regression — the
  work is still never performed twice and the sender has `retry_after_ms` — but if retry
  latency under load ever matters, the fix is a cheaper dedup-only pre-check, not moving the
  bucket back behind the guards. `NOTE:` at the `tryTake()` site in `handleMaybeAct`.
- `staticReject()`'s `estimated_cluster_size: 0` / `confidence: 0` differ from the values
  `nearAnchorOnly()` produces (`cfg.k` / `0.5`). No consumer reads either field today (per
  the existing `NOTE:` on `nearAnchorOnly`), so 0/0 — "no information given" — is the honest
  choice for a rejection. `NOTE:` added on `staticReject` recording that if a consumer ever
  starts reading these, both sites must be revisited together, and that this one cannot
  report a real estimate without giving back the cost it exists to avoid. This was the
  implementer's flagged open question; resolved as-is rather than changed.

**Accepted tradeoffs encountered — none.** No `NOTE:` at any touched site had already
declined a finding of ours.

**Pre-existing failures — none.** Full suite was green before and after.

## Verification

- `npx tsc --noEmit` — clean.
- `yarn test` — 344 passing (up from 342; the two added ordering tests).
