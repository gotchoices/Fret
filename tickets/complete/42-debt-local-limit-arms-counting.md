description: When our own node runs out of network stream slots, several places in the service must react the same way — count it, blame nobody. A test now covers all of them, and the design doc says so.
files: packages/fret/test/rpc.stream-caps-local-limit-arms.spec.ts, packages/fret/src/service/fret-service.ts, docs/fret.md

## What shipped

One new spec, `packages/fret/test/rpc.stream-caps-local-limit-arms.spec.ts` (292 lines), and no
source change. It drives a *real* outbound stream-cap refusal (`maxOutboundStreams: 0` on the
dialing node) through every place in `FretService` that observes a `local-limit` outcome, and
asserts each one stays silent — no contact strike, no relevance decay, no backoff — while
`diag.streamLimit` rises by exactly one per refusal.

Structure: an `Arm` table (`name`, `protocol`, `drive()`, optional `proveControl`) of 8 rows, driven
through a `priv()` cast, run twice — a control block before any cap exists, then a capped block with
every distinct protocol registered at `maxOutboundStreams: 0`. `rewindSpacing()` clears
`lastContactFailureAt` between refusals so the 500 ms contact-failure spacing guard cannot mask a
strike the test is trying to catch. The local service is deliberately never `start()`ed; the remote
one is started so the control calls get real answers.

Review added the design-doc half: `docs/fret.md`'s *Stream management* section now names this spec
beside the scoring spec it complements, says which arms each covers, and states the two arms that
remain unpinned.

## Review findings

**Checked.** The implement diff read first, from `ed7b95a`, before the handoff summary. The arms
table verified row-by-row against every `local-limit` observation site in `fret-service.ts`. The new
spec read end to end. `docs/fret.md` and `src/store/digitree-store.ts` read for the claims below.
Typecheck (`npx tsc --noEmit`, exit 0) and the full suite (`yarn test`, **1281 passing, 7m**, zero
failures) both run green. There is no lint step in this repo and `yarn format` must not be run
(AGENTS.md), so typecheck plus the suite is the whole gate.

**Coverage is complete against the source.** Every site that observes a `local-limit` outcome has a
row: `noteRpcFailure` (`fret-service.ts:882`, plus the five call sites at 2472/2695/2754/3067/3436
that route into it), `noteWriteOnlyOutcome` on the announce path (1616) and on both leave arms
(1863, 1881), and `countStreamLimit` in the warm-up fan-out (1699/1703) and the iterative lookup
(3347/3357).

**No row is vacuous, and this is proven rather than assumed.** The capped block asserts the
`diag.streamLimit` delta is *exactly* `REFUSALS`, so a row whose protocol was never actually capped
would yield delta 0 and fail. The green run is therefore itself the mutation experiment a prior
review pass had proposed: it proves each row's cap really bit — including that `announceNeighbors`
dials `PROTOCOL_NEIGHBORS_ANNOUNCE` rather than `PROTOCOL_NEIGHBORS`, and that the lookup row
produces exactly one refusal per drive. No separate experiment was needed and none was run.

**Minor — fixed in this pass (1).** `docs/fret.md`'s *Stream management* section named only the
scoring spec as what pins the "every outcome-observing site reaches `countStreamLimit`" claim, which
was the stage requirement still unmet. It now names this spec too, states which arms each of the two
covers, and states the two unpinned arms below. That is the only edit this review made; no source or
test file was changed.

**Major — none, with reason.** Two suspicions were raised by reading and both resolved as
non-findings against the source rather than being filed:
- `rewindSpacing()` calls `store.update(peerId, { lastContactFailureAt: 0 })` between refusals, which
  would weaken the `relevance` / `successCount` / `failureCount` equality assertions if it refreshed
  `lastAccess` or re-scored. It does neither: `DigitreeStore.update`
  (`src/store/digitree-store.ts:307`) is `put({ ...cur, ...patch })` straight through the write seam,
  and only `upsert` refreshes `lastAccess`. The assertions read exactly as strongly as they look.
- The announce row takes five tokens from `bucketAnnounce` inside one before-to-after window (one in
  the control block, four in the capped one). Its capacity is Core 16 / refill 8 per sec, Edge 6 / 2
  (`fret-service.ts:465`), so five fits inside either capacity with no refill needed — comfortable
  margin, no flakiness risk, no `NOTE:` warranted. The failure mode was benign anyway: a dry bucket
  makes the announce skip *before* it sends, so the row would fail loudly rather than pass vacuously.

**Conditional / speculative — parked in the doc, not filed (2.)** Both are the implementer's own
declared gaps, judged here as acceptable-for-now rather than as work:
- The two leave rows call `sendLeave` directly instead of driving `sendLeaveToNeighbors`. That loop
  runs inside `stop()` and needs a cached self ring coordinate, so reaching it costs a materially
  different rig. What the rows *do* pin — that both `noteWriteOnlyOutcome` labels stay silent and
  count — is this ticket's actual claim; the loop that calls them is a different seam's coverage.
- No row drives two refusals concurrently, so "exactly once per refusal" is pinned sequentially only;
  a shared-increment bug under a pooled multi-peer warm-up would not be caught.
Parked as two sentences in the `docs/fret.md` paragraph rather than as `NOTE:` comments, because the
concern is about what the doc's "every site" claim is entitled to assert — architectural, with no
single code site. Same reason the lookup row's narrowness (it pins one refusal, not the walk's
reaction to it) is left unrecorded separately: it is the same sentence.

**Considered and kept (1).** Row 3 calls `noteRpcFailure` directly with a real refused outcome while
row 1 reaches the same seam through `probeNeighborLatency`. That is not one assertion in two dresses:
row 3 pins the seam independent of any caller, so it keeps guarding if `probeNeighborLatency` is ever
rewired away from it, and row 1 pins that the caller still routes there. Deleting either loses a
distinct fact.

**Known and accepted (1).** The spec reaches private methods through a `priv()` cast, so a rename
fails at runtime rather than at compile time. That is the standing pattern in this repo's service
specs, not something this ticket introduced; changing it is a suite-wide decision, not a finding
against this diff.

**Companion work, deliberately not absorbed.** `debt-local-limit-arms-noncounting` (sequence 42.5)
extends this same spec file with the `cancelled` / `skipped` rows plus its own source `NOTE:` and
`docs/fret.md` paragraph. Nothing in that scope was touched here.
