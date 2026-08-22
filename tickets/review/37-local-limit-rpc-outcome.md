description: Third pass over the finished work that stops our own node blaming a healthy peer when it runs out of network streams. The build and tests now pass; one small inconsistency is left to fix and the design document needs one sentence corrected.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/outcome.ts, packages/fret/src/rpc/request.ts, packages/fret/test/rpc.request.spec.ts, packages/fret/test/dead-state.spec.ts, docs/fret.md
difficulty: easy
---

<!-- resume-note -->
Run 3 ran the gate (green) and closed every outstanding investigation item. **No code has been
changed yet.** What is left is one small, fully-specified inline fix plus the doc sentence it
corrects, then the `complete/` ticket. Everything needed to do that is written below — no
re-reading of the implement diff is required.

## Settled — do not re-derive

- **Gate is green.** `cd packages/fret && npx tsc --noEmit` → clean. `yarn test` → **1235 passing,
  0 failing** (~5 min). No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was
  not written. There is no lint step (`yarn check` is the gate; do **not** run `yarn format`).
- **All seven `local-limit` sites** (from run 2, still accurate): `fret-service.ts` 898
  (`noteRpcFailure`), 1681 (`pingWarmupTargets`), 2425 (`probeNeighborLatency`), 2648
  (`probeMembership`), 2707 (`fetchAndMergeSnapshot`), 3020 (`routeAct` forward path), 3334
  (`iterativeLookup`).
- **Ordering inside `classify` is correct** (from run 2): caller's signal → `foreign-protocol` →
  frame truncation → payload-too-large → `local-limit` → deadline → `unreachable`. Putting the
  stream-cap identity ahead of the deadline check is right — the error identity is a more specific
  fact than "a deadline had fired by the time we looked", and both score nothing either way. The
  reasoning is unstated at the site; the existing `NOTE:` there covers only the
  remote-inbound-cap residual.
- **`iterativeLookup` (3334) terminates — NOT a major finding, closed.** The walk is
  `for (let attempt = 0; attempt < maxAttempts; attempt++)` (line 3246) with
  `maxAttempts = options.maxAttempts ?? ttl + 2`. That counter is independent of `hop`, so the
  arm's `hop++; continue;` cannot spin: worst case every candidate meets the ceiling, all 10
  attempts burn, and the walk yields `exhausted`. `visited.add(target)` (line 3299) runs *before*
  the send, so the arm's comment claim ("`target` is already in `visited`") is true.
  - One residual worth a sentence, not a ticket: `hop++` on `local-limit` spends a hop of the
    `ttl - hop` budget carried by later messages even though no message left this node. Harmless
    (the walk is bounded by `maxAttempts` regardless, and spending the hop is the conservative
    direction), but if the fix below is being written anyway, consider recording it as a `NOTE:`
    at that arm.
- **`pingWarmupTargets` (1681) asymmetry is explained but awkwardly.** Its
  `foreign-protocol` / `unreachable` / `timeout` arm logs and returns without scoring (correct —
  this pass deliberately scores nothing), while the `local-limit` arm calls `noteRpcFailure`
  purely to reach the counter. The comment there does say "counted only, never scored", so it is
  not undocumented — but calling the *scoring* seam from a pass that scores nothing is the
  awkwardness. The fix below removes it.

## The one remaining fix (minor — apply inline, then run the gate)

**Finding: `diag.streamLimit` under-counts, and `docs/fret.md` overstates it.**
`openRpcStream` raises the stream-cap error at the *open*, before any write, so the two
write-only senders can observe `local-limit` too — but all three of their call sites only log
`out.kind` and never touch the counter:

- `sendAnnouncementsRateLimited`, `fret-service.ts` ~1597
- `sendLeaveToNeighbors` S/P notices, ~1843
- `sendLeaveToNeighbors` beyond-S/P fan-out, ~1861

So a ceiling firing on an announce or a leave notice is invisible, while the *Stream management*
bullet in `docs/fret.md` (line ~218) claims a firing ceiling "is visible rather than silent".

Do **not** route those sites through `noteRpcFailure` — it would turn their `unreachable` /
`timeout` outcomes into contact strikes, which those passes deliberately do not record today.
Instead single-source the increment so it appears exactly once:

- Add a private `countStreamLimit(outcome: RpcOutcome<unknown>): void` on `FretService` that
  increments `this.diag.streamLimit` when `outcome.kind === 'local-limit'` and does nothing else.
  Document at it *why* it exists: the counter is the only trace a `local-limit` leaves — it scores
  nothing — so every outcome-observing site must reach it, including the two write-only senders
  that must never reach the scoring seam.
- Have `noteRpcFailure`'s `local-limit` case call it instead of incrementing directly (898).
- Have `pingWarmupTargets`' `local-limit` arm call it instead of `await this.noteRpcFailure(...)`
  (1681) — this also retires the asymmetry noted above.
- Add a small shared helper for the three write-only sites that calls `countStreamLimit` and then
  logs any non-`ok`, non-`cancelled` outcome, replacing the three near-identical log lines. The
  announce site keeps its own `announcementsSent++` on `ok`.
- Then correct the `docs/fret.md` sentence so it states what the counter actually covers.

Re-run `npx tsc --noEmit` and `yarn test` from `packages/fret/` after the edit.

## Remaining review work after the fix

- **Weigh the implementer's stated test gaps.** No test drives `local-limit` through a real call
  site (the two specs cover `classify` and `noteRpcFailure` in isolation), and
  `probeNeighborLatency` returning `false` — so `probeAndFetch` skips the snapshot fetch — is an
  untested behavior choice. Climb the architecture ladder before filing: one generalized test
  asserting *no scoring side effect* across all seven arms beats seven point tests and beats a
  ticket per gap. The write-only counter arm added above wants covering by the same test.
- **Confirm `docs/fret.md` reflects shipped reality** beyond the one sentence above. Expect a
  merge touch with the sibling `stream-caps-plumbing` ticket on the same *Stream management*
  bullet.
- **Produce the `complete/` ticket** with a `## Review findings` section. Carry forward, with
  reasons: the gate result; the `classify` ordering (checked, correct, reasoning unstated at the
  site); `iterativeLookup` termination (checked, terminates, closed as not-a-finding); the
  `pingWarmupTargets` asymmetry (explained at the site, retired by the fix); the counter
  under-count (found, fixed inline); the `hop++`-spends-a-hop residual (parked as a tripwire, not
  a ticket). State empty categories explicitly with a reason — no silent gaps, no "looks good".
