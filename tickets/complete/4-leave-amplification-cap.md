description: A peer that tells us it is leaving used to cost us up to twenty outbound network requests in reply; now it costs none, plus at most one throttled batch of announcements. The departing peer's list of suggested stand-ins is remembered as a hint and checked later by the routine background pass, instead of being dialed on the spot.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/churn.leave.spec.ts, packages/fret/test/dialability.spec.ts, docs/fret.md, docs/threat-analysis.md

## What shipped

`FretService.handleLeave` no longer probes anything. The cohort assembly, the 6-wide warm loop
(`sendPing` + conditional `announceNeighbors` + `snapshot()` rebuild per iteration), the
`mergeNeighborSnapshots(warm.slice(0, 4))` call, and the `announceReplacementsToNeighbors` method
are gone. In their place `recordLeaveReplacements(replacements, departedId)` does a bare
`store.upsert` per sanitized id — skipping self, the departing peer, duplicates and anything not
`isDialable` — then calls `enforceCapacity()` once. The handler's announce now goes through the
same debounced `announceOnDeparture` the `peer:disconnect` path uses.

Per accepted leave: 0 pings, 0 neighbor fetches, ≤ 12 SHA-256 hashes + upserts, ≤ `announceFanout`
announces (Core 8 / Edge 4), themselves debounced to one burst per departed coordinate per 2 s and
metered by the global `bucketAnnounce`. No new constant introduced.

Docs: `docs/fret.md` *Leave*, *Security → Not yet implemented*, and *Ring membership →
Classification probe pass*; `docs/threat-analysis.md` §3.2, §4.2, §5.2, §7.2, §7.4 and the
top-20 summary table (see findings below).

## Review findings

Reviewed the implement diff (`21886dc`) against the source before reading the handoff summary.
Ran `npx tsc --noEmit` (clean) and `yarn test` from `packages/fret` — **544 passing, 0 failing**
(~4 min). There is no lint step in this repo; `yarn check` (typecheck + build + test) is the gate
and `yarn format` is documented as unusable here. No pre-existing failures surfaced;
`tickets/.pre-existing-error.md` not written.

### Checked and clean

- **The amplification claim itself.** `handleLeave` reaches no outbound RPC except the detached
  `announceOnDeparture`. `bucketLeave` is taken before any per-message work, so the local hash +
  upsert cost is metered too.
- **Guard ordering and correctness in `recordLeaveReplacements`** — self / departed / duplicate /
  undialable skips, and the `isDialable`-not-`isDoomedDial` choice (a `foreign` or `dead`
  replacement is deliberately still recorded, because `upsert` preserves the label and each has
  its own re-probe arm).
- **Table-pollution bound at capacity.** Inserted entries carry relevance 0, so `enforceCapacity`
  makes them preferred eviction victims rather than squatters; they are not in
  `protectedIdsAround`. The unconditional `enforceCapacity()` call after a loop that inserted
  nothing is a `store.size()` comparison and returns immediately — not worth guarding.
- **Hand-off to `classifyUnknownPeers`.** Its selection predicate (`membership === 'unknown'`,
  `state !== 'dead'`, off backoff, connected-or-addressable) does match what this handler writes,
  so the recorded entries are genuinely picked up rather than stranded.
- **Deleted-method fallout.** `expandCohort` still has live callers (`sendLeaveToNeighbors`, the
  public interface); nothing else referenced `announceReplacementsToNeighbors`.
- **The `NOTE:` at the `registerLeave` call site** explaining why leave alone skips
  `noteInboundRpc` is accurate — that hook would re-promote the peer `handleLeave` just removed.

### Found and fixed in this pass (minor)

- **`docs/threat-analysis.md` was left describing the deleted behavior as current** — the file the
  change should have touched and didn't. §3.2 and §4.2 still enumerated "warms up to 6
  replacements / fetches 4 snapshots / ~14N outbound operations", §4.2's mitigations line claimed
  "the amplification factor is still ~7x per accepted leave", §7.2 said recipients "warm them
  (ping + announce), and merge their snapshots", §7.4 listed "replacement warming" as a churn
  cost, and summary rows 13 / 18 were unqualified. All rewritten in the file's existing
  `**Status —**` idiom (past tense for what the section described, an explicit status line for
  what is now true). §7.2 is marked **reduced, not closed**: a named id the local peerStore
  already has an address for still enters the table and still consumes one slot of the
  classification pass's per-tick budget.
- **§5.2 of the same file contradicted the edit** — it stated no handler verifies `from` against
  the transport identity, which stopped being true before this ticket and would have read as a
  live contradiction next to the §3.2 text. Given a `**Status — done.**` line scoped to what
  transport verification does and does not buy (direct sender only; not a substitute for §5.1
  signatures).
- **`diag.leaveReplacementsInserted` counted things it did not insert.** The increment is
  unconditional, so a notice naming 12 ids already in the store bumped it by 12 while inserting
  nothing — misleading for anyone watching it as a table-pollution gauge. Renamed to
  `leaveReplacementsRecorded`, doc comment states the distinction; the five test references
  updated.
- **The announce target walk was a third copy of the same six lines** (`announceNeighborsBounded`
  and `announceOnDeparture`, with a comment in the first *promising* it matched its siblings —
  the smell that says the invariant is a convention). Extracted `announceTargetsAround(coord,
  exclude, fanout)`, which now states the two rules once: unfiltered walk (so a freshly-connected
  `unknown` peer is not stalled) and non-connected-but-addressable first.
  `announceToNewPeers` deliberately not folded in — it takes explicit ids and never falls back to
  connected peers, so it is a different rule, not a variant of this one.

### Found and fixed: test gaps (both were named as gaps in the handoff)

- **The fan-out clamp was untested.** The debounce spec seeds exactly 2 announce targets, so it
  could not distinguish a clamp from an exhausted candidate list. Added `'clamps the departure
  burst to announceFanout when more neighbors are eligible'` — an Edge rig (fan-out 4) seeded with
  6 eligible neighbors, asserting the delta is exactly 4. The two seeding blocks are now one
  `seedAnnounceTargets(rig, count)` helper that alternates ±1, ±2, … so both halves of the
  two-sided walk find candidates.
- **The `isDialable`-not-`isDoomedDial` decision had a comment and no test.** Added `'records a
  foreign replacement without clearing its label'`: a `foreign` dialable id is still recorded and
  keeps its label, which is what stops a leave notice from erasing local classification work.

### Recorded as a tripwire, not a ticket

- `upsert` refreshes `lastAccess` on an id already in the store, so naming a peer here nudges its
  future relevance up via the recency term with no contact having happened. Harmless today —
  eviction sorts on relevance alone and the nudge helps the named peer, not the namer. Parked as a
  `NOTE:` at the `store.upsert` call in `recordLeaveReplacements`, with the revisit condition
  (eviction sorting on `lastAccess`, or the recency weight growing) and the fix shape (a
  non-refreshing upsert variant, not a filter at this site).

### New tickets filed

None. Every finding resolved inline; nothing rose to a root cause needing its own site.

### Deliberately not addressed

- **`peer:disconnect` → `applyFailure` re-adds the peer `handleLeave` just removed**, as a fresh
  `unknown`. Already tracked as `backlog/debt-scoring-resurrects-removed-peers`; re-filing it as
  an arm here would duplicate an open ticket at the same site.
- **`announceNeighbors` swallows its own errors, so `diag.announcementsSent` counts attempts, not
  deliveries.** Pre-existing and outside this diff. The two announce specs give their targets a
  real handler, so they are not relying on the looser reading; the new clamp spec asserts a count
  the clamp decides, which is attempt-shaped either way.
- **`docs/threat-analysis.md` §7.6 ("Missing Dead State Transition") is stale** — the dead state
  landed in the ring-membership work. Unrelated to this diff's code, so left for the ticket that
  owns it rather than widened into here.
- **The `hashPeerId` failure arm in the insert loop is unreachable** (`sanitizeReplacements`
  parse-checks every id first) and stays untested. It logs and continues rather than throwing into
  the RPC handler, which is the right shape for a defensive arm.
- **No spec drives a real graceful departure end-to-end** and counts the combined leave +
  `peer:disconnect` announce bursts; the debounce is proven by two leave notices instead. The
  existing full-service churn specs cover that path for liveness. Adding a second, slower proof of
  an already-proven mechanism did not earn its runtime.
