description: Fixed a bug where a flood of trivially-invalid requests could dodge the server's rate limiter and still force it to do expensive work, by checking the rate limit before that work runs and by making the invalid-message replies cheap.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/pick-anchors.spec.ts, packages/fret/test/payload-bounds-ttl.spec.ts
difficulty: easy
----

## What changed

`handleMaybeAct` (fret-service.ts) now takes the `bucketMaybeAct` rate-limit token as
the very first thing it does, before any of the cheap validity checks (breadcrumb-loop,
timestamp freshness, TTL, oversized payload). Previously those checks ran first and, on
rejection, each called `nearAnchorOnly()` — which hashes the key and runs two
membership-filtered ring walks plus two next-hop selections — meaning a flood of
already-invalid messages (e.g. stale timestamp, `ttl: 0`) never touched the bucket and
still forced that per-message ring work every time.

The four cheap-guard rejection paths (loop, stale/future timestamp, expired TTL,
oversized payload) now return a new `staticReject()` — a hardcoded `NearAnchorV1` with
empty `anchors`/`cohort_hint` and `estimated_cluster_size`/`confidence` both `0` — instead
of calling `nearAnchorOnly()`. No key hashing, no ring walk, no next-hop selection.

`nearAnchorOnly()` itself is unchanged and still exists, but now has exactly one caller:
the `catch` arm in `handleMaybeAct` when `routeAct()` throws unexpectedly. That path runs
*after* the token has already been taken and real routing work was already attempted, so
paying for a real ring walk there is fine — it's the best-effort answer for a message that
did pass all cheap checks. Its doc comment was updated to describe this new role.

## Test changes

- `test/pick-anchors.spec.ts`: the existing "breadcrumb-loop reply anchors on the key's
  nearest peer" test asserted the *old* contract (loop rejection returns computed anchors
  via `nearAnchorOnly`). Rewrote it to assert the new contract: loop rejection returns
  `anchors: []` / `cohort_hint: []` (the static reject), with zero ring computation. Added
  a new test that forces `routeAct` to throw (via reassigning the private method on the
  service instance) to keep end-to-end coverage of `nearAnchorOnly`'s anchor-on-key-coord
  correctness now that the breadcrumb-loop path no longer reaches it — this is the same
  regression class `pick-anchors.spec.ts` exists to guard (anchors must be measured from
  the key's own coordinate, not a fixed point).
- `test/payload-bounds-ttl.spec.ts`: updated one stale comment that said a stale-timestamp
  rejection was "rejected via nearAnchorOnly" — it's now the static reject. No assertion
  changes needed elsewhere; those tests only check `result` has an `anchors` property
  (still true — `staticReject()` returns a `NearAnchorV1`-shaped object), or check
  `busy`/`retry_after_ms` for the already-passing rate-limit tests.

## Verification

- `npx tsc --noEmit` — clean.
- `test/pick-anchors.spec.ts` + `test/payload-bounds-ttl.spec.ts` + `test/profile.behavior.spec.ts` — 61 passing.
- Full `yarn test` — 342 passing, no regressions.

## Gaps / things a reviewer should check

- `staticReject()`'s `estimated_cluster_size: 0` / `confidence: 0` differ from the old
  `nearAnchorOnly()`-derived reject values (`this.cfg.k` / `0.5`). Per the existing
  docstring on `nearAnchorOnly`, no consumer reads either field today, so this was treated
  as a free choice — 0/0 reads as "no information given," which seemed more honest for a
  reject than borrowing plausible-looking numbers. Worth a second opinion if a consumer
  starts reading these fields.
- Didn't add a dedicated flood/perf test proving the bucket now actually bounds
  invalid-message throughput (e.g. N stale messages doing O(1) ring walks instead of O(N)).
  The reordering is straightforward enough that this felt like belt-and-suspenders, but
  flagging in case the reviewer wants one.
