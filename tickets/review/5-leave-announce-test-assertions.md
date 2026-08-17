description: Tests around a peer leaving the network used to pass without proving anything. They now check the real effects — that the departing peer is actually forgotten, that the goodbye message carries the right list of stand-in peers, and that a burst of announcements stops when it runs out of budget.
files: packages/fret/test/churn.leave.spec.ts, packages/fret/test/proactive-announce.spec.ts, packages/fret/src/service/fret-service.ts
difficulty: medium
---

Tests only — **no production code changed**. `git status` shows exactly two modified files.

## What landed

### `packages/fret/test/churn.leave.spec.ts`

**Deleted** `leave notice includes replacement suggestions` (the six-node full mesh). Its
assertions were `expect(diag).to.have.property('pingsSent')` and `listPeers().length > 0`. A NOTE
in its place explains why a mesh at `k: 7` can never see a replacement list at all.

**Added, in `Leave amplification cap`** (the unstarted-receiver rig — no stabilization loop, so
every diagnostic delta is attributable):

- `removes the departing peer from the id map and from the ring window` — seeds the departing peer
  as a live `member` at `hashPeerId(departing.peerId)`, asserts as a premise that it is in the
  successor/predecessor window, sends the leave, then asserts both `store.getById(...) ===
  undefined` **and** absence from `svc.getNeighbors(selfCoord, 'both', max(2, cfg.m))` — the tree
  walk, not only the id index. Window width read from `cfg.m`, not a literal.
- `stops the departure burst at the first empty-bucket skip` — edge rig, `announceFanout + 2`
  seeded announce targets, a two-token announce bucket, one departure burst. Asserts
  `announcementsSent` grew by exactly 2 and `announcementsSkipped` by exactly 1 (one skip for the
  whole burst, not one per remaining target — the `break` in
  `sendAnnouncementsRateLimited`, `fret-service.ts:1301`).

**Added, new describe `Leave notice replacements (sender side)`** — first coverage of
`computeReplacements` (`fret-service.ts:1458`). `makeSenderRig(k, count)` seeds a departing node's
store with `count` live members at ring offsets `+1 … +count` from its own coordinate, one of which
(offset +1) is a real node running a spy `registerLeave` handler; the rest are bare keys libp2p has
no address for, which `isDoomedDial` skips as targets. `sendLeaveToNeighbors()` is called directly.

- `advertises the live members just outside the S/P window, and only those` — `k: 3` (so `m` = 2),
  9 seeded peers, offset +3 set `foreign` and +4 set `dead`. Asserts **set equality** of
  `notice.replacements` with `{+5, +6, +7}`, derived from the offsets; plus the `foreign` and
  `dead` exclusions by name, plus that none of the four notice targets (`+1, +2, +8, +9`) appears.
- `caps the replacement list at six ids` — `k: 7` (`m` = 4), 20 seeded peers, eight eligible
  candidates. Asserts `length === 6` and every advertised id comes from the eligible eight.

### `packages/fret/test/proactive-announce.spec.ts`

**Deleted** `rate limiting prevents announcement storms` (computed a `totalSkipped` it never
asserted on) and `diagnostics track announcementsSkipped counter` (asserted a field exists and is a
number). Both replaced by NOTEs pointing at the deterministic bucket spec in `churn.leave.spec.ts`.

**Added** the missing premise to `edge profile sends fewer announcements than core`: `edgeTotal > 0`
and `coreTotal > 0`, each with a message naming which side was silent, before the existing
`coreTotal >= edgeTotal`. Comparison deliberately left non-strict.

## Validation

`cd packages/fret && npx tsc --noEmit` — clean.

Full suite: `yarn test` → **694 passing, 0 failing** (~4m). No `.pre-existing-error.md` written.

Per-file runtimes, measured by running the pre-change files (extracted with `git show HEAD:…`) and
the post-change files separately on the same machine:

| spec | before | after |
|---|---|---|
| `churn.leave.spec.ts` | 13 s (14 tests) | 12 s (17 tests) |
| `proactive-announce.spec.ts` | 24 s (6 tests) | 17 s (4 tests) |

The ticket predicted the deleted mesh test cost ~7 s; measured it was **1.86 s** — an earlier
`waitFor` rewrite in that file had already removed most of it. The two deleted announce tests cost
4.22 s and 2.12 s. The three added deterministic specs cost ~0.9 s combined; the whole sender-side
describe runs in under 50 ms.

## Deviations from the ticket — read these

- **The announce bucket is replaced, not drained.** The ticket asked to "drain
  `bucketAnnounce` down to exactly 2 tokens". `TokenBucket` can be emptied but offers no way to
  drain *to* a level, and an emptied bucket then races its own refill. The spec installs
  `new TokenBucket(2, 2)` instead — capacity 2 at edge's own 2/s rate, so the level is exact and no
  token returns during a burst that completes in milliseconds. Cost: the spec no longer exercises
  the *profile's* configured capacity/refill values, only the skip-and-break logic.
- **The notice's target set is pinned indirectly, not asserted directly.** Only the peer at +1 is a
  real node, so it is the only observer, and there is no seam to spy on the full target list. What
  the specs pin is the *premise stated in comments* (clockwise `{+1, +2}`, counter-clockwise
  `{+9, +8}`) plus the replacement set that is computed by subtracting it — a wrong target walk
  yields a different replacement set and fails the equality assertion. A regression that narrowed
  which targets are *dialed* (e.g. an `isDoomedDial` change) would **not** be caught.
- **The 6-id cap needed its own spec.** At `m` = 2 the candidate pool tops out at 4, so
  `replacements.length <= 6` there is vacuous. Split into a second spec at `k: 7` / 20 peers where
  eight candidates compete for six slots, and asserted `=== 6` rather than `<= 6`.

## Finding: `sendLeaveToNeighbors`'s `slice(0, 8)` drops the whole predecessor side at default `k`

**Not fixed — out of scope for a tests-only ticket, and the reviewer should decide where it goes.**
`repro: verified` (ran it; probe script written, output captured below, script deleted).

`fret-service.ts:1487-1491` builds the notice's target list as the clockwise walk followed by the
counter-clockwise walk, then `.slice(0, 8)` with a hard-coded 8:

```ts
const ids = Array.from(new Set([
    ...this.store.neighborsRight(selfCoord, this.cfg.m),
    ...this.store.neighborsLeft(selfCoord, this.cfg.m)
])).filter((id) => id !== selfStr).slice(0, 8);
const spSet = new Set(ids);
```

At the shipped default `k: 15`, `m` = 8, so the unsliced walk is 16 ids and the slice keeps exactly
the first 8 — all clockwise. Measured on a hand-seeded 20-peer ring at `k: 15`:

```
unsliced S/P walk offsets: [1,2,3,4,5,6,7,8, 20,19,18,17,16,15,14,13]
sliced targets (slice 0,8): [1,2,3,4,5,6,7,8]
replacement offsets:        [9,10,11,12,13,14]
```

Two consequences:

1. **No predecessor is notified.** `docs/fret.md` (*Leave*, step 1) says the notice goes to all
   S(p) ∪ P(p). With a live service self is also in the store (both walks return self first), so
   the real steady-state slice is `[s1..s7, p1]` — one predecessor of seven. Either way the fan-out
   is heavily successor-biased, and the doc claim is wrong at the default config.
2. **`spSet` is built from the *sliced* list, so peers inside the departing node's own predecessor
   window get advertised as replacements.** Offsets 13 and 14 above are members of the
   counter-clockwise `m`-window, yet they appear in `replacements` — which
   `computeReplacements`' own doc comment describes as "the live members just *outside* our own S/P
   window".

The new sender-side specs do not trip this: at `k: 3` and `k: 7` the walk yields 4 and 8 ids, so the
slice never bites. That is why it is reported rather than asserted — adding a spec now would pin
current behavior, which is the wrong shape for a defect.

## Known gaps in what landed

- The beyond-S/P fan-out arm of `sendLeaveToNeighbors` (`expandCohort` → connected-only extras,
  `fret-service.ts:1502-1511`) is still untested. The sender rig has exactly one connected peer and
  it is already an S/P target, so nothing reaches that arm.
- The premise assertions added to `edge profile sends fewer announcements than core` sit on top of
  the existing fixed 4 s sleep and a six-node mesh; they were comfortably satisfied in every run
  here, but they are not deterministic. The ticket explicitly scoped the sleeps out.
- `announcementsSkipped` is now pinned for the departure-burst path only. `announceNeighborsBounded`
  and `announceToNewPeers` go through the same choke point, so the logic is shared, but neither
  caller has its own skip spec.
- The sender-side rig depends on `neighborsRight`/`neighborsLeft` **skipping and continuing** past a
  filter miss (which is what pulls the clockwise walk out to +5/+6 when +3 and +4 are excluded). If
  that store semantics ever changed to stop-on-miss, the expected set in the spec would need
  re-deriving — the spec would fail loudly, which is the intended behavior, but the reviewer should
  know the coupling exists.
