----
description: Some tests around a peer leaving the network, and around the messages sent when one does, pass without proving anything — they check that a counter went up rather than that the departing peer was actually forgotten and the right messages went out. Replace them with checks on the real effect.
files: packages/fret/test/churn.leave.spec.ts, packages/fret/test/proactive-announce.spec.ts, packages/fret/test/helpers/ring.ts, packages/fret/src/service/fret-service.ts
difficulty: medium
----

Three weak spots in the leave/announce specs, all fixable with deterministic rigs that already
exist in `churn.leave.spec.ts`. No production code changes — this ticket is tests only. If an
assertion below cannot be made to hold, that is a finding about the service, not a licence to
weaken the assertion: report it in the review handoff.

### 1. The departing peer is removed from the recipient's table

`handleLeave` (`src/service/fret-service.ts:1519`) calls `store.remove(notice.from)` and that
removal is currently asserted nowhere. The existing mesh test
(`churn.leave.spec.ts:87-139`, "leave notice includes replacement suggestions") explicitly
*declines* to assert it, because in a live mesh the `peer:disconnect` that follows a graceful stop
runs `applyFailure`, whose `?? upsert` recreates the entry (open ticket:
`backlog/debt-scoring-resurrects-removed-peers`). That is a real service defect and is out of scope
here — do not try to fix it, and do not build the assertion on a rig that trips it.

Assert at the seam instead, in the existing `Leave amplification cap` describe. Its `makeLeaveRig`
builds a receiver whose `FretService` is deliberately never started, so no `peer:disconnect`
listener is attached and nothing can resurrect the entry:

- Seed the departing peer into the receiver's store as a live `member` at its true coordinate
  (`hashPeerId(rig.departing.peerId)`), and assert as a premise that it appears in the receiver's
  successor/predecessor window before the notice.
- Send the leave.
- Assert `store.getById(departingId) === undefined`, and that it is gone from the ring window too
  (the walk, not just the id map — a store whose tree and id index disagree would pass the first
  check alone; see *Routing store* in `docs/fret.md`).

### 2. The notice a departing node sends actually carries replacements

`computeReplacements` (`fret-service.ts:1457`) is untested. It has three rules worth pinning, and
the reason the current mesh test cannot see any of them is that with `k: 7` (so `m` = 4) and six
nodes, every remote peer falls inside the departing node's own successor/predecessor window, the
replacement pool is empty, and the notice ships `replacements: undefined`.

Build a deterministic rig rather than a bigger mesh: one real receiver node with a spy leave
handler (the pattern at `churn.leave.spec.ts:187-229` — `registerLeave` with a capture callback),
an unstarted `FretService` whose store is seeded by hand, and a direct call to
`(svc as any).sendLeaveToNeighbors()`.

- Use a small `k` so `m` is small and the two windows are separable — with `k: 3`, `m` = 2.
- Place peers at controlled ring positions with `ringOffset` from `test/helpers/ring.ts` (already
  imported by this spec), offsets +1..+9 from self's coordinate. The real receiver goes at +1 so it
  is a notice target; the rest are seeded ids with no address, which `isDoomedDial` skips as
  targets — that is fine and intended, only the real receiver has to receive.
- Expected: the notice's targets are the `m`-per-side walk (`+1, +2` clockwise and the two
  highest offsets counter-clockwise), and `replacements` is drawn from the `2m`-per-side walk
  *minus* those targets. Derive the expected set in the test from the same offsets rather than
  hard-coding ids, and assert set equality, not just non-emptiness.
- Assert the live-member scope: seed one of the would-be replacements `foreign` and another
  `dead`, and assert neither appears in the notice. This is the transitive-propagation guard
  documented under *Leave* in `docs/fret.md`; today nothing tests it.
- Assert the cap: `replacements.length <= 6` (`maxReplacements` in `computeReplacements`), and that
  no notice target appears in its own replacement list.

Then delete the old `leave notice includes replacement suggestions` test — its assertions
(`diag` has a `pingsSent` property; `listPeers().length > 0`) prove nothing the new specs do not,
and it spends ~7 s converging a six-node full mesh to do it. Keep `a graceful stop sends leave
notices to its neighbors without throwing` and `fan-out notifies peers beyond immediate S/P`: those
are smoke tests of the live path and are honest about what they observe (see the NOTE at
`churn.leave.spec.ts:165-171`).

### 3. The announce bucket's skip counter increments by the expected amount

`sendAnnouncementsRateLimited` (`fret-service.ts:1289`) increments `announcementsSkipped` **once**
and then `break`s, so the counter is at most +1 per call — a fact no test states. Two current tests
gesture at it and assert nothing:

- `proactive-announce.spec.ts:134-174` ("rate limiting prevents announcement storms") computes
  `totalSkipped` and never asserts on it. The only surviving assertion is `totalSent > 0`.
- `proactive-announce.spec.ts:216-245` ("diagnostics track announcementsSkipped counter") asserts
  the field exists and is a number.

Delete both, and add one deterministic spec to `Leave amplification cap` in `churn.leave.spec.ts`,
next to the existing `clamps the departure burst to announceFanout` test which already seeds
announce-eligible neighbors and asserts an exact burst size:

- Seed `announceFanout + 2` announce targets via the existing `seedAnnounceTargets`.
- Drain `(rig.svc as any).bucketAnnounce` down to exactly 2 tokens (`announce-rate-limit.spec.ts`
  has a `drainBucket` helper shape to copy; do not import across specs unless you move it into a
  helper — a local copy of a three-line loop is acceptable here).
- Trigger one departure burst.
- Assert `announcementsSent` grew by exactly 2, `announcementsSkipped` by exactly 1, and that the
  burst stopped there rather than continuing past the empty bucket.

### 4. The edge-vs-core announce comparison has no premise

`proactive-announce.spec.ts:85-132` asserts `coreTotal >= edgeTotal`, which holds when both are 0 —
so a total announce outage passes it. Add the premise both sides sent something (`edgeTotal > 0`
and `coreTotal > 0`) before the comparison, with messages naming which side was silent. Do not
tighten the comparison to strict `>`: fan-out is a *ceiling*, and on a six-node mesh both profiles
can legitimately saturate below it.

### Not in scope

- Fixing `applyFailure`'s create-on-miss (`backlog/debt-scoring-resurrects-removed-peers`).
- Consolidating mesh/star setup boilerplate or the coordinate helpers — `plan/21-cleanup-tests`
  owns that. Use `test/helpers/ring.ts` as it stands; do not widen it.
- The fixed `setTimeout` sleeps in `proactive-announce.spec.ts` tests you are not otherwise
  touching. Where you do rewrite a test, gate on a `waitFor` predicate
  (`test/helpers/wait-for.ts`) rather than a sleep — the predicate must describe convergence the
  ring cannot reach on its own (that helper's own doc comment explains the trap: a store holds its
  own entry from `start()`, so self-inclusive counts wait on nothing).

## Edge cases & interactions

- **Removal must be visible in the ring walk, not only the id map.** `DigitreeStore` keeps a tree
  and an id index; a removal that updates one and not the other is silently corrupting (see
  *Routing store* in `docs/fret.md`). Assert both.
- **The receiver's service is unstarted in `makeLeaveRig`, deliberately.** Do not start it to make
  a test easier — a started service's stabilization loop makes every diagnostic delta
  unattributable, which is the whole reason that rig exists (see its doc comment).
- **Replacement scoping is `isLiveMember` on the sender, `isDialable` on the receiver.** They are
  different predicates on purpose. A `foreign` peer must be absent from a notice we *send* and
  still recordable from a notice we *receive* (the existing `records a foreign replacement without
  clearing its label` spec pins the receive half). Do not unify them.
- **`m` follows `k`**: `m = ceil(k / 2)`. A spec that seeds ring offsets and asserts window
  membership must derive the window width from `(svc as any).cfg.m`, not from a literal, or it
  silently stops binding if the default `k` changes.
- **The announce burst is debounced per departed coordinate** (`DEPARTURE_DEBOUNCE_MS`, 2 s). A
  spec that triggers two departures in one test will see one burst — the existing `announces at
  most one debounced burst per departing peer` spec depends on exactly that. Give the bucket-skip
  spec its own rig, or a distinct departing coordinate.
- **`announceNeighbors` swallows its own errors** (`src/rpc/neighbors.ts:145`), so
  `announcementsSent` increments even when the remote rejects the stream. A spec asserting a
  *sent* count must therefore also confirm the targets are genuinely announce-capable —
  `seedAnnounceTargets` already registers `registerNeighbors` on each target for this reason.
- **Draining a token bucket mid-test races its refill** (Core 8/s, Edge 2/s). Drain and assert
  inside one turn; if the settle delay in `rig.leave(...)` lets a token refill back, use the edge
  profile (2/s) or shorten the settle, and say in a comment which one you relied on.
- **A leave notice's `from` must match the transport-authenticated sender.** `registerLeave` drops
  spoofed notices (`churn.leave.spec.ts:212-214`); a hand-built notice sent from the wrong node
  silently tests the identity gate instead of the thing you meant.

## TODO

- Add the departing-peer-removal spec to `Leave amplification cap`, asserting absence from both the
  id map and the ring window, with a pre-notice premise assertion.
- Build the seeded-ring rig for `sendLeaveToNeighbors` (small `k`, `ringOffset` placement, one real
  receiver with a spy `registerLeave` handler) and assert the notice's target set, replacement set
  equality, the `foreign`/`dead` exclusions, and the 6-id cap.
- Delete `leave notice includes replacement suggestions` from `churn.leave.spec.ts`.
- Add the announce bucket-skip spec (exact `+2` sent / `+1` skipped) to `Leave amplification cap`.
- Delete `rate limiting prevents announcement storms` and `diagnostics track announcementsSkipped
  counter` from `proactive-announce.spec.ts`.
- Add the `edgeTotal > 0` / `coreTotal > 0` premise to `edge profile sends fewer announcements than
  core`.
- Run `cd packages/fret && npx tsc --noEmit`, then the two touched specs, then the full
  `yarn test`. Report the runtime change for `churn.leave.spec.ts` and `proactive-announce.spec.ts`
  in the handoff — deleting two mesh tests should visibly shorten both.
