description: Documented in the design doc that a network call we cancelled ourselves is never held against the peer it was aimed at, and corrected a stale description of how long an outbound call is allowed to take.
files: docs/fret.md
----

Documentation half of the cancellation-evidence work for `rpc-service-signals` (Phase 4 of
`7-rpc-abort-deadlines`). The test half, `rpc-cancel-evidence-tests`, already landed
(`tickets/complete/7.4-rpc-cancel-evidence-tests.md`) — its two source changes (the
`sendAnnouncementsRateLimited` top-of-loop guard and the `iterativeLookup` `exhausted` `NOTE:`)
were re-verified against current source before writing this doc, so nothing below describes a gap
that no longer exists.

Docs-only change; no source touched.

## What changed in `docs/fret.md`

**Stream management** (under *libp2p integration*). The stale claim that the read deadline is
"one overall budget per read (`readAllBounded`, 5s default)" is corrected: the budget covers the
**whole outbound RPC** — dial + stream open + write + read — via `RPC_TIMEOUT_MS`
(`src/rpc/protocols.ts:15`, 5000ms). Documented the three per-call-site overrides and why each
differs from the default:
- `MAINTENANCE_RPC_TIMEOUT_MS` = 2000ms (`fret-service.ts:292`) — maintenance pings/announces.
- `sendMaybeAct` stays at the 5s default deliberately — it's a *route* budget (waits for the whole
  remaining route downstream), not a link budget (`src/rpc/maybe-act.ts:43-46`).
- `SHUTDOWN_BUDGET_MS` = 3000ms / `LEAVE_NOTICE_TIMEOUT_MS` = 1500ms (`fret-service.ts:301,303`) —
  whole leave fan-out / per-notice, running after the run signal aborts so it can't reuse it.
The existing "no per-chunk idle timer" reasoning was left untouched — still correct.

**Stabilization and churn handling.** Added a new bullet stating that a run-signal abort (our own
cancellation) records no contact failure, no backoff, no ping-failure diagnostic — only the RPC's
own timeout does. Explained the caller-signal-as-discriminator mechanism (sender's deadline is a
*child* of the caller's signal, so it fires on both a timeout and a cancellation, while the
caller's own signal fires only on cancellation) and why no new error type was needed. Stated
honestly that this is enforced at **seven of eight** guarded call sites — the one gap is
`fetchNeighbors` behind `mergeNeighborSnapshots`, whose sender swallows its own errors; pointed at
the accepted-tradeoff `NOTE:` at `fret-service.ts:1770`. (The `sendAnnouncementsRateLimited` site
is *not* listed as a gap — `rpc-cancel-evidence-tests` fixed it; verified the fix is present in
current source before writing this.)

**Service shell & lifecycle (A1).** Added one line next to the run-generation paragraph: the
run-scoped `AbortController` (`runAbort`) is minted with `runGen` on `start()` (`fret-service.ts:771`)
and aborted on `stop()` right after the loop timers are cleared, before the leave fan-out — which
carries its own budget and so isn't silenced by the abort. Noted the controller is deliberately
kept rather than nulled, so a late read from an interrupted tick reports "cancelled" rather than
"no signal at all".

**RouteAndMaybeAct pipeline (A5).** Added a bullet documenting that `RouteProgress`
(`src/index.ts:79`, part of the public `FretService` interface) has no `cancelled` variant by
design — adding one is an API change every consumer would have to learn — so `{ type: 'exhausted' }`
covers both "the ring had no more hops" and "the run was cancelled under us". Stated the
consequence for callers: a caller must re-check service state before concluding the ring was
exhausted, and an undelivered activity is one possible outcome. The matching code `NOTE:`
(`fret-service.ts:2740`) landed with the sibling ticket; not duplicated here.

## Validation

- `cd packages/fret && npx tsc --noEmit` — clean.
- `cd packages/fret && yarn test` — 630 passing, 0 failing (~3 min). No pre-existing failures
  encountered (the one flagged by a prior ticket, `test/message-bus.spec.ts`, was already fixed
  upstream — see `tickets/complete/7.4-rpc-cancel-evidence-tests.md`).

## For the reviewer

- Pure prose change to `docs/fret.md`, four sites. Cross-check each added claim against the cited
  file:line — all four were read from current source (not copied from the ticket body) before
  writing, since the ticket noted line numbers might have drifted from the sibling ticket's landing.
  They matched exactly at time of writing.
- Nothing to test functionally — no code changed. The two `npx tsc` / `yarn test` runs above are
  the whole validation surface, and they only guard against an accidental source edit that didn't
  happen.
- No new tripwires or accepted-tradeoff `NOTE:`s were added by this ticket — both `NOTE:`s referenced
  above already existed from the sibling ticket.
