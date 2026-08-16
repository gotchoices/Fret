description: A peer that tells us it is leaving used to cost us up to twenty outbound network requests in reply; now it costs none, plus at most one throttled batch of announcements. The departing peer's list of suggested stand-ins is remembered as a hint and checked later by the routine background pass, instead of being dialed on the spot.
files: packages/fret/src/service/fret-service.ts, packages/fret/test/churn.leave.spec.ts, packages/fret/test/dialability.spec.ts, docs/fret.md
difficulty: medium

## What changed

`FretService.handleLeave` (`src/service/fret-service.ts:1239`) no longer probes anything.

**Deleted** from the handler: the `base` / `expanded` / `baseSet` / `localNew` / `newIds` cohort
assembly, the 6-wide `warm` loop (`sendPing` + conditional `announceNeighbors` + `snapshot()`
rebuild per iteration), the `mergeNeighborSnapshots(warm.slice(0, 4))` call, and the whole
`announceReplacementsToNeighbors` method (`handleLeave` was its only caller).

**Added**: `recordLeaveReplacements(replacements, departedId)` (`fret-service.ts:1270`), which
iterates the sanitized ids and does nothing but a bare `store.upsert`, then calls
`enforceCapacity()` once. Per id it skips self, the departing peer, duplicates, and anything
`!isDialable`. Four load-bearing decisions carry comments at the site (bare `upsert` and *not*
`applyTouch`; `isDialable` and not `isDoomedDial`; why self is a correctness guard; why
`departedId` is skipped).

**Swapped**: `handleLeave` now detaches `announceOnDeparture(peerId, coord)` instead of
`announceReplacementsToNeighbors(coord)` — same walk, but debounced per departed coordinate
(2000 ms) and excluding the departed peer.

**Also**:
- New diagnostic counter `diag.leaveReplacementsInserted` (`fret-service.ts:239`).
- `NOTE:` at the `registerLeave` call site (`fret-service.ts:808`) explaining why leave alone
  skips `noteInboundRpc` (it would re-promote the peer `handleLeave` just removed).
- `computeReplacements` doc comment rewritten — its justification named the behavior this ticket
  deleted. The live-member filter itself is unchanged and still correct.

Resulting ceiling per accepted leave: 0 pings, 0 neighbor fetches, ≤ 12 SHA-256 hashes + upserts,
≤ `announceFanout` announces (Core 8 / Edge 4) — themselves debounced to one burst per departing
coordinate per 2 s and metered by the existing global `bucketAnnounce`. No new constant added.

## Validation

`cd packages/fret && npx tsc --noEmit` — clean.
`cd packages/fret && yarn test` — **542 passing, 0 failing** (~4 min). No pre-existing failures
surfaced; `tickets/.pre-existing-error.md` not written.

## Use cases the reviewer should exercise

New `describe('Leave amplification cap')` in `test/churn.leave.spec.ts` uses a rig
(`makeLeaveRig`) whose receiver registers the **real** `registerLeave` handler over a **real**
second libp2p node — so the transport identity check runs rather than being bypassed — but whose
`FretService` is deliberately **never started**. That is what makes the diagnostic deltas
attributable: with no stabilization loop, every ping / fetch / announce counted came from
`handleLeave`.

Cases covered:

- **no ping, no neighbor fetch** on an accepted leave carrying a dialable replacement (fails
  loudly against the old handler)
- **replacement recorded as `membership: 'unknown'`, `relevance === 0`**
- **undialable replacement dropped** — not inserted at all
- **existing `member` not demoted or re-zeroed** when named as a replacement
- **self and the departing peer never inserted** — self's `addressKnown` is forced true in that
  spec, otherwise the dialability filter drops self first and the guard goes untested
- **12 duplicate ids collapse to 1** insert
- **announce burst is bounded and debounced** — two leaves from the same peer inside the 2 s
  window produce exactly one burst
- **classification hand-off** — insert via leave, run one `stabilizeOnce()`, assert the
  replacement is pinged and promoted to `member`

Renamed/rewritten elsewhere:
- `'recipients probe suggested replacements from leave notice'` — **deleted**; its name asserted
  the opposite of the new contract and its `>=` assertions were trivially satisfiable. The
  replacement cases above cover it with equality assertions.
- `'sendLeave triggers stabilization and replacement warming'` → `'a graceful stop sends leave
  notices to its neighbors without throwing'` (body unchanged; only the name lied).
- `dialability.spec.ts` `'handleLeave still warms a replacement whose address the peerStore
  holds'` → `'handleLeave records a replacement whose address the peerStore holds'`, now
  asserting the store insert instead of a dial count. Its sibling negative case gained an
  assertion that the undialable id never enters the table.
- `'oversized replacements array is truncated'` kept as-is (exercises `src/rpc/leave.ts`).

## Known gaps — treat as a floor, not a finish line

- **The debounce spec asserts `delta === 2` because it seeds exactly 2 announce targets.** It
  proves debouncing and that the burst is `<= announceFanout`, but it does *not* prove the
  fan-out is clamped when more than `announceFanout` targets exist — that clamp is
  `announceOnDeparture`'s pre-existing `.slice(0, this.announceFanout)` and is untested here.
- **`announceNeighbors` swallows its own errors, so `diag.announcementsSent` increments even
  when the dial fails.** The debounce spec sidesteps this by giving its targets a real announce
  handler, but any future spec counting that diagnostic should know it measures *attempts*, not
  deliveries. Pre-existing, not introduced here.
- **No spec drives a real graceful departure end-to-end and counts the combined leave +
  `peer:disconnect` announce bursts.** The debounce is verified by sending two leave notices, not
  by the actual notice-then-disconnect sequence the change exists to collapse. The existing
  full-service churn specs cover that path for liveness only.
- **`recordLeaveReplacements` returns early on an empty list and so skips `enforceCapacity()`.**
  Correct (nothing was inserted), but it means the "once after the loop" call is conditional on
  there being a loop at all.
- **The `hashPeerId` failure arm inside the insert loop is unreachable in practice**
  (`sanitizeReplacements` already parse-checked every id) and therefore untested. It logs and
  continues rather than throwing into the RPC handler.
- **Not addressed, deliberately**: `peer:disconnect` → `applyFailure` re-adds the peer
  `handleLeave` just removed, as a fresh `unknown`. Tracked as
  `backlog/debt-scoring-resurrects-removed-peers`. No spec here assumes the departing peer stays
  absent from the store.

## Docs updated (`docs/fret.md`)

- `## Leave` — step 1's justification rewritten (recipients record rather than dial); step 3's
  "probe suggested replacements" replaced with the untrusted-hint contract plus the stated
  per-leave outbound ceiling and the latency trade.
- *Security → Not yet implemented → Leave authentication* — "treat suggested replacements as
  untrusted hints" marked done; signature and liveness-ping items left standing.
- *Ring membership → Classification probe pass* — now names leave replacements as one of the
  sources of `unknown` entries it vets.
