description: Final pass over the finished work that stops our own node blaming a healthy peer when it runs out of network streams. The one remaining code fix and the documentation correction are done; what is left is re-running the test suite and writing the archived summary.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/outcome.ts, packages/fret/src/rpc/request.ts, packages/fret/test/rpc.request.spec.ts, packages/fret/test/dead-state.spec.ts, docs/fret.md
difficulty: easy
---

<!-- resume-note -->
Run 4 applied the fix and the doc correction, then hit the token budget before the test gate.
Type-check is clean; **`yarn test` has not been run against the edit**. Nothing else is
outstanding except the gate, the test-gap decision, and the `complete/` ticket.

## Settled — do not re-derive

Everything under "Settled" in run 3 still holds and is not repeated here beyond what the
remaining work needs:

- `classify` ordering in `src/rpc/request.ts` — checked, correct, reasoning unstated at the site
  (the existing `NOTE:` there covers only the remote-inbound-cap residual).
- `iterativeLookup` termination — checked, terminates (`maxAttempts` counter is independent of
  `hop`), closed as not-a-finding.
- Run 3's gate was green: 1235 passing, 0 failing, ~5 min. No pre-existing failures.
  `tickets/.pre-existing-error.md` was not written. There is no lint step; `yarn check` is the
  gate and `yarn format` must not be run.

## Done in run 4 (uncommitted, in the working tree)

`packages/fret/src/service/fret-service.ts`:

- New private `countStreamLimit(outcome)` — the single owner of the `diag.streamLimit` increment,
  documented at the site with why it exists (the counter is a `local-limit`'s only trace, so every
  outcome-observing site must reach it, including the two senders that must never reach the
  scoring seam).
- New private `noteWriteOnlyOutcome(id, outcome, what)` — counts the stream limit, then logs any
  non-`ok`, non-`cancelled` outcome. Replaces the three near-identical log lines at
  `sendAnnouncementsRateLimited` and both `sendLeaveToNeighbors` fan-outs. The announce site keeps
  its own `announcementsSent++` on `ok`.
- `noteRpcFailure`'s `local-limit` case now calls `countStreamLimit` instead of incrementing.
- `pingWarmupTargets`' `local-limit` arm calls `countStreamLimit` instead of
  `await this.noteRpcFailure(...)` — retiring the "a pass that scores nothing calls the scoring
  seam" asymmetry.
- `iterativeLookup`'s `local-limit` arm calls `countStreamLimit`, and carries a new `NOTE:`
  recording the tripwire that `hop++` there spends a hop of the `ttl - hop` budget even though no
  message left this node (harmless — bounded by `maxAttempts` — with the revisit condition stated).

`docs/fret.md`: the *Stream management* bullet no longer overstates the counter — it now names the
single owner and states that the write-only senders reach it through the shared helper rather than
through `noteRpcFailure`, and says what was invisible before.

`cd packages/fret && npx tsc --noEmit` → clean after these edits.

## Remaining work

- **Run the gate**: `cd packages/fret && yarn test` (foreground, no redirection; ~5 min). It must
  pass. The edit is behavior-preserving for every previously-counted path and adds counting on
  three previously-uncounted ones, so a failure would most likely be a spec asserting on the old
  announce/leave log text.
- **Weigh the implementer's stated test gaps.** No test drives `local-limit` through a real call
  site (the two specs cover `classify` and `noteRpcFailure` in isolation), and
  `probeNeighborLatency` returning `false` — so `probeAndFetch` skips the snapshot fetch — is an
  untested behavior choice. Climb the architecture ladder before filing: one generalized test
  asserting *no scoring side effect* across all seven `local-limit` arms beats seven point tests
  and beats a ticket per gap; the new write-only counter arm wants covering by the same test.
- **Confirm `docs/fret.md` reflects shipped reality** beyond the sentence already corrected.
  Expect a merge touch with the sibling `stream-caps-plumbing` ticket on the same *Stream
  management* bullet.
- **Produce the `complete/` ticket** with a `## Review findings` section. Carry forward, with
  reasons: the gate result; the `classify` ordering (checked, correct, reasoning unstated at the
  site); `iterativeLookup` termination (checked, terminates, closed as not-a-finding); the
  `pingWarmupTargets` asymmetry (explained at the site, retired by the fix); the counter
  under-count and the doc overstatement (found, both fixed inline); the `hop++`-spends-a-hop
  residual (parked as a `NOTE:` tripwire at the site, not a ticket). State empty categories
  explicitly with a reason — no silent gaps, no "looks good".
