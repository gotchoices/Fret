description: A peer could send a nonsense confidence or size number over the network and have it accepted; those numbers are now range-checked where they arrive, and refused at the one place that already claimed to be the boundary.
files: packages/fret/src/rpc/validate.ts, packages/fret/src/service/size-observer.ts, packages/fret/test/size-observer.spec.ts, packages/fret/test/rpc.codec-properties.spec.ts, docs/fret.md
---

## What the work was

Two advisory numbers ride on FRET wire messages: `size_estimate` (how big the sender thinks the
network is) and `confidence` (how sure it is, nominally a 0-to-1 fraction). Both are fed into the
receiver's own network-size estimate. Before this change the parsers checked only that each was a
finite number, so a peer — or a buggy local caller — could supply a negative size or a confidence
of 5 and have it accepted.

`confidence` is the sharper of the two, because it is not merely reported: it is the **weight** in
the blend. An out-of-range value re-scales every *other* observation's contribution — a confidence
of 5 lets one report outvote five honest ones, and a negative one subtracts from the total weight,
which can cancel it to zero (returning the degenerate answer) or drive it negative (inverting the
blend).

### Shipped

- **`src/rpc/validate.ts`** (implement stage, commits `edb7a35` / `224c001`) — `finiteNumberOr`
  became `finiteNumberInRangeOr(value, min, max, fallback)`, applied to `size_estimate`
  (`[0, Infinity]`) and `confidence` (`[0, 1]`) in both `makeSnapshotParser` and
  `parsePingResponse`. Out-of-range fields drop individually; no message is rejected for one bad
  advisory field, matching the house style for such fields.
- **`src/service/size-observer.ts`** (review stage, commit `2f7074a`) — `SizeObserver.report`
  refuses a `confidence` outside `[0, 1]` beside its existing non-finite refusal, with the reason
  stated at the site.
- **Tests** (commit `2f7074a`) — `test/size-observer.spec.ts` gained two: out-of-range confidences
  are not stored while the inclusive boundaries 0 and 1 are, and a crafted high-confidence report
  cannot outvote an honest one in the blend. `test/rpc.codec-properties.spec.ts` gained a
  `fast-check` property over arbitrary finite doubles generalizing the range rule for both fields
  on the snapshot parser.
- **`docs/fret.md`** (review stage) — three places updated: the *Wire-shape parsers* table rows for
  `makeSnapshotParser(caps)` and `parsePingResponse` (both now document the bounds and the
  out-of-range drop), and the *Network size estimation* `SizeObserver` bullet (the `report`
  refusal, why a weight is different from a reported number, and the deliberate non-refusal of a
  negative `estimate` — that gate lives at `calibrateSizeFromSnapshot`). No other `docs/` file
  mentions these parsers or `SizeObserver`.

## Review findings

**Verification run.** `npx tsc --noEmit` from `packages/fret/` — clean. `yarn test` — **1196
passing, 0 failing, 0 pending** (~3 min). No lint step exists in this repo (`yarn check` =
typecheck + build + test), and `yarn format` is not run per AGENTS.md. No pre-existing failures
surfaced, so no `.pre-existing-error.md` was written.

**Confirmed correct.** The parser range check is sound. `isFiniteNumber` runs first, so `Infinity`
and `NaN` are already excluded and the `Infinity` upper bound on `size_estimate` is only a "no
ceiling" spelling. `-0` passes the `[0, …]` range and is dropped downstream by the `> 0` gate; the
JSON codec turns `-0` into `0` on the wire anyway. Fields drop independently rather than rejecting
the message. The test-generator change is correct and necessary: the round-trip property would
otherwise generate a negative `size_estimate` that the tightened parser correctly refuses.

**Two claims in the implement handoff are wrong.** Recorded so they are not repeated:
- It claims a `src/service/fret-service.ts` change. There is none.
  `calibrateSizeFromSnapshot`'s `snap.size_estimate > 0 && snap.confidence > 0` gate predates this
  ticket; `git diff 93add3d..HEAD --stat` shows `src/rpc/validate.ts` as the *only* production file
  the implement stage touched.
- It overstates the ping-reply half. Nothing in the service reads `size_estimate` / `confidence`
  off a ping reply — `sendPing`'s three call sites use only liveness and latency, and
  `reportNetworkSize` is reached only from the snapshot path. That tightening is defense in depth
  for a path that does not exist yet, not a live fix.

**Major finding — fixed in this pass rather than filed.** `SizeObserver.report` was documented as
"the boundary now" and refused non-finite input, but accepted any finite `confidence`.
`FretService.reportNetworkSize` is public API and passes straight through, so the exact corruption
this ticket set out to prevent stayed reachable from a local caller. The parser fix closes today's
two wire paths one at a time; the refusal at `report` closes the class at the point that already
claims to be the boundary — the *invariant* rung of the architecture ladder, not a point fix.

**Minor findings.** None beyond the docs staleness above, which was fixed in this pass.

**Tripwire recorded.** `SizeObserver.blend(local)` applies no range check to the
`LocalSizeEstimate` it is handed, even though `local.confidence` is a blend weight exactly like a
reported one. Not reachable today: all four call sites feed it a clamped
`estimateSizeAndConfidence` result, and `blend` is not on the public `FretService` surface
(`getNetworkSizeEstimate` builds `local` itself). Conditional, so parked as a `NOTE:` at `blend`
in `src/service/size-observer.ts` naming the condition — not filed as a ticket.

**Checked and clear.** `parseNearAnchor` range-checks nothing beyond finiteness, but
`fret-service.ts` carries a `NOTE:` saying no consumer reads `estimated_cluster_size` /
`confidence` off a NearAnchor, and a grep confirms it. No finding.

**New tickets filed.** None. The one major finding was resolvable inline at the invariant site, and
the only remaining concern was conditional and became a tripwire.
