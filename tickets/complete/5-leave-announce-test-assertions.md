----
description: Tests around a peer leaving the network used to pass without proving anything. They now check the real effects — that the departing peer is actually forgotten, that the goodbye message carries the right list of stand-in peers, and that a burst of announcements stops when it runs out of budget.
files: packages/fret/test/churn.leave.spec.ts, packages/fret/test/proactive-announce.spec.ts
difficulty: medium
----

Tests only — **no production code changed**, in the implement pass or in this review pass.

## What landed

### `packages/fret/test/churn.leave.spec.ts`

**Deleted** `leave notice includes replacement suggestions` (a six-node full mesh whose only
assertions were that `getDiagnostics()` has a `pingsSent` property and that `listPeers()` is
non-empty). A `NOTE:` in its place explains why a mesh at `k: 7` can never observe a replacement
list at all.

**Added** to `Leave amplification cap` (the unstarted-receiver rig, so every diagnostic delta is
attributable to the leave and nothing else):

- `removes the departing peer from the id map and from the ring window` — asserts both
  `store.getById(...) === undefined` and absence from the member-scoped ring walk, so a removal
  that updated only one of the store's two views is caught.
- `stops the departure burst at the first empty-bucket skip` — pins that
  `sendAnnouncementsRateLimited` increments `announcementsSkipped` once and `break`s, rather than
  once per remaining target.

**Added** a new describe, `Leave notice replacements (sender side)` — first coverage of
`computeReplacements`. Two specs: exact set equality of the advertised replacements against a
hand-seeded ring (including the `foreign` and `dead` exclusions), and the six-id cap at a `k` wide
enough for the cap to bind.

### `packages/fret/test/proactive-announce.spec.ts`

**Deleted** `rate limiting prevents announcement storms` (computed a `totalSkipped` it never
asserted on) and `diagnostics track announcementsSkipped counter` (asserted a field exists and is a
number). Both replaced by `NOTE:`s pointing at the deterministic bucket spec.

**Added** the missing premise to `edge profile sends fewer announcements than core`: both totals
must be non-zero before the comparison, so a total announce outage no longer passes.

## Validation

- `npx tsc --noEmit` — clean.
- `yarn test` — **694 passing, 0 failing** (~4m). No pre-existing failures surfaced; nothing
  written to `tickets/.pre-existing-error.md`.

## Review findings

### Checked and correct — the substance of the new specs

Both sender-side expected sets were **re-derived independently from `computeReplacements` and
`sendLeaveToNeighbors` before reading the handoff's reasoning**, and both are right:

- At `k: 3` (`m` = 2), 9 seeded peers with `+3` foreign and `+4` dead: targets `{+1,+2,+8,+9}`,
  live-member pool `{+1,+2,+5,+6}` ∪ `{+9,+8,+7,+6}`, minus targets → `{+5,+6,+7}`. Matches.
- At `k: 7` (`m` = 4), 20 seeded peers: eight eligible ids compete for six slots. Matches, and the
  cap genuinely binds rather than being vacuous.

The rigs' attribution claims also hold: the receiver service is never started, so no stabilization
loop or `peer:disconnect` listener can contaminate a delta; and `expandCohort`'s beyond-S/P arm
cannot fire in the sender rig (its one real peer is already a ring target), so the specs measure
what they claim to.

### Minor — fixed in this pass

- **`stops the departure burst at the first empty-bucket skip` asserted the wrong premise.** It
  checked `targets.length > 2` (the *seeded* count), but the burst is clamped to `announceFanout`
  before the bucket ever sees it, so the premise that actually produces a skip is `fanout > 2`.
  A profile whose fan-out dropped to 2 would have spent both tokens, skipped nothing, and failed at
  the `announcementsSkipped` assertion with no hint that the fan-out was the cause. Now asserts on
  `fanout` first, and keeps the seeded-count check as a separate, correctly-worded premise.

### Major — filed, not fixed here

- **`sendLeaveToNeighbors`'s `.slice(0, 8)` drops the predecessor side at the shipped default `k`.**
  Reported by the implementer; **independently re-verified** with a throwaway probe at `k: 15`
  (script deleted after use, output recorded in the ticket). Targets come out as
  `[s1..s7, p1]` — one predecessor of seven — contradicting `docs/fret.md` (*Leave*, step 1), and
  six genuine S/P members remain replacement-eligible, contradicting `computeReplacements`' own doc
  comment.

  **Appended as a second arm on item (a) of `plan/23-fret-service-decomposition` rather than filed
  fresh.** That ticket already claims these exact five lines (its existing off-by-one arm names
  "leave-notice targets" among the affected sites) and already proposes the helper that retires the
  class — a per-side two-sided walk — so a point ticket would have been the Nth instance of a class
  already ticketed. The arm records that it is shippable standalone and should not wait on the full
  decomposition.

  One correction to the handoff: it claimed offsets 13 and 14 "appear in `replacements`" while
  being inside the counter-clockwise window. In the measured run the shipped replacements were
  `[8..13]` and the counter-clockwise window was `{14..20}`, so that specific claim does not hold.
  The accurate — and still defective — statement is the one the arm carries: six genuine S/P
  members *pass the eligibility filter*, and a single connected predecessor would sort them to the
  front and ship them. Latent wrong-result rather than a currently-observable one.

- **The beyond-S/P leave fan-out is entirely untested** →
  `backlog/debt-leave-fanout-beyond-sp-untested`. The implementer listed this as a known gap; it is
  a real, non-conditional coverage hole, so it gets a ticket rather than a tripwire. Filed at the
  generalized rung: the ticket asks for the rig that unlocks the arm *and* repairs
  `fan-out notifies peers beyond immediate S/P`, whose name promises coverage its star topology
  cannot deliver. Checked first that nothing open claimed the site, and that `createIdentifyNode`
  already exists in `test/helpers/libp2p.ts` — so the missing piece is a spec, not a helper, which
  is why this is cheap enough to be worth filing.

### Conditional — recorded as a tripwire, not a ticket

- **`proactive-announce.spec.ts` still gates every test on a fixed 2-4 s sleep.** The premise
  assertions this ticket added are now load-bearing rather than throwaway `> 0` checks, so a slow
  CI box would fail them rather than shrug. It is not wrong today — announces fire on the first
  stabilization tick, leaving several ticks of headroom — and the ticket explicitly scoped sleep
  removal out. Parked as a `NOTE:` at the top of that describe naming `waitFor` as the fix if it
  ever flakes, rather than as a ticket.

### Checked and clean — with reasons, not "looks good"

- **No coverage was lost to the three deletions.** Traced each: the deleted mesh test could not
  reach `expandCohort` either (at `k: 7` all five remotes fell inside `spSet`), so the beyond-S/P
  arm is no *more* uncovered than before; leave-under-real-disconnect is still covered by
  `a graceful stop sends leave notices to its neighbors without throwing`; and the two deleted
  announce tests' only surviving claim (`totalSent > 0`) is made by three remaining tests in the
  same file.
- **Docs are accurate for this change.** Grepped `docs/` for every deleted test name and for both
  spec files — no design-doc text referenced them, and a tests-only change moves no documented
  behavior. The one genuine doc-vs-code mismatch found (*Leave* step 1 vs the `slice(0, 8)`
  truncation) describes the **defect**, so it is carried in the `plan/23` arm to be reconciled with
  the fix rather than edited to describe buggy behavior.
- **No resource leaks.** Both new rigs construct a `FretService` they never start and never stop.
  The mocha exit watchdog (which fails the run on any handle still open 10 s after the last test)
  passed on the full suite, so construction arms no timers and attaches no listeners.
- **No accepted-tradeoff `NOTE:`s were overridden.** Read around every site touched; none of the
  findings above sits at a site carrying one.
- **File size is fine.** `wc -l packages/fret/test/churn.leave.spec.ts` reports 677 (up from 541).
  Three describes, each a distinct half of the leave protocol, so no split is warranted yet.
- **Runtime did not regress.** The two files together run in 29 s; the three added deterministic
  specs cost under 1 s combined, and the whole sender-side describe runs in ~100 ms.

### Empty categories

- **Type safety** — nothing found. The new specs use `(rig.svc as any)` for private members, which
  is the established pattern throughout this suite (`cfg.m`, `announceFanout`, `stabilizeOnce` are
  all reached that way in pre-existing tests); introducing a test-only public seam for them is a
  larger call than this ticket, and `plan/23`'s decomposition would change the answer anyway.
- **Error handling / resource cleanup** — nothing found beyond the leak check above. Every new spec
  wraps its body in `try/finally { await rig.stop() }`, matching the file's existing rigs.
- **DRY** — nothing worth acting on. `makeSenderRig` and `makeLeaveRig` share some node-setup
  shape, but they model opposite ends of the protocol (sender vs receiver) and merging them would
  produce a rig parameterized on which half it is testing — more coupling than the ~10 duplicated
  lines cost.
