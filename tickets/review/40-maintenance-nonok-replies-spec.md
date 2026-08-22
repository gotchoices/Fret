description: A peer can reply "I am too busy" or send back an unreadable answer; new tests confirm the code treats those as real answers — the peer stays trusted and is never wrongly written off as unreachable.
files: packages/fret/test/maintenance-nonok-replies.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, packages/fret/test/helpers/backoff.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: medium
---

## What landed

One new file: `packages/fret/test/maintenance-nonok-replies.spec.ts`, four cases, all passing.
No production code changed. No other test changed. The harness half (the `Behavior` widening on
`test/helpers/maintenance-rig.ts`) had already landed on this branch in an earlier commit and was
not touched.

The headline the spec exists to hold: **an answer that is not a good answer is still an answer.**
It arrived over `/optimystic/<network>/fret/...`, a protocol only this network's peers serve, so it
confirms membership and clears the contact-failure run — and it must never book a contact strike.
Three strikes mark the peer `dead`, which silently drops it out of every ring view; a strike leaking
into one of these arms is the regression the spec catches.

`docs/fret.md` line 79 forward-references this spec path twice. Both references were verified
against the landed filename — the doc is true again, and renaming this file means editing that line.

## The four cases, and what each proves

All four seed **one** near peer as a live `member` at `contactFailures: 2`, then drive exactly one
`stabilizeOnce` directly (the rig never starts the service, so a live loop cannot race the
assertions). Core profile; one peer is well inside the near budget of 4 and the pool cap of 6, so
nothing can be truncated out of the tick and misread as "scored nothing". Phase 2 still runs but
selects nothing — no `unknown` / `foreign` / `dead` entry is seeded — so every recorded contact
belongs to the near pass.

- **ping `busy`** — backoff factor > 0, relevance *exactly* unchanged, `successCount` and
  `failureCount` both unchanged (this arm scores nothing at all), `pingsSent` +1, `pingsFail` +1,
  `pingsOk` +0.
- **ping `not-ok`** (`ok: false`) — `failureCount` +1, `successCount` unchanged, backoff factor 0,
  `pingsSent` +1, `pingsFail` +1.
- **ping `undecodable`** — same shape as `not-ok`: `failureCount` +1, backoff 0. This is
  `noteRpcFailure`'s decay-only arm, reached via `decode-error`.
- **neighbors `busy` behind an `answers` ping** — the ping half is credited (`successCount` +1,
  relevance strictly up, `pingsOk` +1) while `fetchAndMergeSnapshot`'s busy arm stays completely
  silent: `snapshotsFetched` +0 and `failureCount` unchanged.

Every case additionally asserts, through one shared helper (`expectAnsweredNotStruck`):
`contactFailures` driven from the pre-seeded 2 to **0**, `membership === 'member'`,
`state !== 'dead'`, and that the neighbors protocol was opened **after** the ping for that peer —
proving the near pass did the contacting and that `probeAndFetch` did not skip the fetch.

Arm 4 was checked against `fetchAndMergeSnapshot` before being written, as the source ticket
required: `busy` and `decode-error` share one silent arm that returns before `snapshotsFetched++`
and scores nothing. Confirmed at `packages/fret/src/service/fret-service.ts:2725`.

## Two measurement traps this spec hit, and how to re-hit them

Both were written the wrong way first and passed vacuously or failed loudly; both are now
documented in the spec's file header. A reviewer changing these assertions should know why they
are shaped as they are.

- **`getDiagnostics()` returns the service's live `diag` object, not a copy.** A "before" reference
  and an "after" reference are therefore the same object, and every delta computes as 0 — an
  assertion that silently passes in exactly the direction it was written to catch. The spec reads
  the counters as scalars through a small `pings()` helper. **This trap is not local to this
  spec** — any spec taking an object snapshot of diagnostics has the same hole. Worth a grep during
  review; see *Not done* below.
- **A freshly seeded entry sits at `relevance: 0`, and `applyFailure` recomputes `base · S(x)` from
  the counters rather than multiplying the stored value down.** So the *first* scoring call raises
  relevance whatever the arm, and "relevance strictly decreased" — which the source ticket asked
  for on arms 2 and 3 — is not assertable against a seeded baseline. The decay arms are asserted on
  `failureCount` instead, which is the input that actually distinguishes decay from credit.
  Relevance is still asserted where unambiguous: exactly unchanged on the busy ping, strictly up on
  arm 4's credited ping.

## Validation run

- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && yarn test` — **1264 passing, 0 failing** (8m). Foreground, no redirection.
- No `.pre-existing-error.md` written; nothing failed.
- The rig's `teardown` restores `STABILIZE_TICK_BUDGET_MS` and `getConnections`. This spec never
  calls `setTickBudget`, so it leaks no static into later specs in the same mocha process.

## Known gaps — treat the tests above as a floor

- **The backoff assertion is coarse by design.** Arm 1 asserts only `factor(id) > 0`, never which
  factor it lands on or how long the window is. Pinning the arithmetic is
  `debt-backoff-map-test-surface`'s scope and needs a fake clock this spec deliberately does not
  install.
- **Core only.** The arms are profile-independent but were run on core alone. An edge run would
  exercise the tighter `maintenanceConcurrency` (2) and near budget, though with one seeded peer
  neither can bind. Cheap to add if a reviewer wants it; not obviously worth the runtime.
- **One peer per case.** Multi-peer interaction — several near peers answering badly in the same
  tick, or a bad answerer sharing a tick with a hung peer — is untested here. `opened` is
  append-ordered per peer so per-peer ordering stays safe, but no case asserts across peers.
- **`not-ok` is ping-only.** The rig rejects loudly against the neighbors protocol, so there is no
  negative-pong arm on the fetch side and there cannot be one — a neighbors reply has no `ok`
  field.
- **The relevance question is dodged, not answered.** Nothing here proves that a bad answer scores
  *lower than* a good one; it proves only which counter each arm moves. A comparative case (bad-arm
  relevance vs good-arm relevance on identically-seeded peers) would close that and was not
  written.
- **Arm 4 overlaps `fetch-snapshot-failure-arms.spec.ts` in subject but not in method** — that spec
  calls `fetchAndMergeSnapshot` directly, one arm at a time, against its own stub. Arm 4 is the
  whole-tick composition (ping scores, fetch silent, one `stabilizeOnce`). A reviewer who disagrees
  that this is distinct enough should delete arm 4 and keep arms 1–3, which nothing else covers.

## Not done — worth a reviewer's judgement

The live-`diag`-object trap above is a **class**, not an instance: `getDiagnostics()` returns
`this.diag` directly (`packages/fret/src/service/fret-service.ts:511`), so any spec that captures it
as an object and diffs later reads zero deltas and passes vacuously. This spec is now safe; other
specs were not audited for it. The architectural fix is at the source — returning a frozen shallow
copy would make the bad pattern impossible rather than merely documented — but that is a production
change outside this ticket's scope and it has a real cost (an allocation per call). Deliberately
left as a finding for the reviewer to weigh rather than filed as a ticket or fixed inline.
