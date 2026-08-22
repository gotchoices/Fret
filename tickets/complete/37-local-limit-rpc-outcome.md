description: Stopped our own node from blaming a healthy peer when it runs out of network stream slots, and made that event visible in diagnostics everywhere it can happen instead of only in some places.
files: packages/fret/src/service/fret-service.ts, packages/fret/src/rpc/outcome.ts, packages/fret/src/rpc/request.ts, packages/fret/test/rpc.request.spec.ts, packages/fret/test/dead-state.spec.ts, docs/fret.md
---

## What shipped

An outbound request can fail because *this* node hit its own per-connection ceiling on open
streams. libp2p raises that locally, before anything reaches the wire, so it says nothing about
the peer. It used to be classified as "unreachable", which booked a contact strike — three of
them marked a healthy peer dead and dropped it out of every ring view.

- `classify` (`src/rpc/request.ts`) gives that failure its own outcome variant, `local-limit`,
  matched by `isStreamLimitError` on the error's `name` rather than on message text.
- The variant scores nothing anywhere: no contact strike, no relevance decay, no backoff — the
  same treatment a tick-budget expiry gets.
- It is counted as `diag.streamLimit`, so a ceiling that fires is visible rather than silent.

## Added during review

- `FretService.countStreamLimit` — the single owner of the counter increment, documented at the
  site with *why* it must exist (the counter is a `local-limit`'s only trace, so every
  outcome-observing site has to reach it).
- `FretService.noteWriteOnlyOutcome` — counts the stream limit, then logs any outcome that is
  neither success nor our own cancellation. Replaces three near-identical log lines at the
  announce fan-out and both leave fan-outs, which previously *only* logged: a ceiling firing on
  an announce or a leave notice was invisible and the counter under-reported. They deliberately
  do not go through the scoring seam, which would turn their unreachable/timeout outcomes into
  contact strikes those passes are designed not to record.
- The warm-up ping pass and the iterative lookup walk now call `countStreamLimit` directly
  instead of the scoring seam — retiring the "a pass that scores nothing calls the scoring
  seam" asymmetry.
- `docs/fret.md` *Stream management* corrected: it overstated the counter's coverage. It now
  names the single owner, states that the write-only senders reach it through the shared helper
  rather than through the scoring seam, and says what was invisible before.

## Review findings

**Gate.** `cd packages/fret && yarn test` — **1235 passing, 0 failing, ~5 min.** Identical
count to the pre-edit run, so nothing regressed and nothing was silently dropped. No
pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written. There is no
lint step in this repo — `yarn check` (typecheck + build + test) is the gate, and `yarn format`
must not be run (no prettier config; it would rewrite every source file against the house tab
style). `npx tsc --noEmit` clean.

**Found and fixed in this pass (minor):**

- *Counter under-reported.* The three write-only send sites (one announce, two leave fan-outs)
  observed the outcome but only logged it, so a stream-limit refusal on those paths never
  reached the counter. Fixed via the shared `noteWriteOnlyOutcome` helper rather than by
  repeating the increment three times.
- *Documentation overstated reality.* The *Stream management* bullet claimed the counter covered
  every path. It did not. Corrected in the same pass.
- *Asymmetry.* The warm-up pass — which by design scores nothing against any peer — reached the
  scoring seam solely to get the counter bumped. Now calls the counter owner directly.

**Checked and closed as not-a-finding, with reasons:**

- *Outcome-classification ordering* in `src/rpc/request.ts` — the order in which failure shapes
  are tested determines which variant a stream-limit error lands in. Read through; correct as
  written. The reasoning is not stated at the site (the existing note there covers only the
  remote-inbound-ceiling residual), but the code is right, so this is a readability observation,
  not a defect.
- *Iterative lookup termination* — the walk's hop counter is now advanced on a code path that
  sends nothing, raising the question of whether the walk can fail to terminate. It cannot: the
  attempt counter that bounds the walk is independent of the hop counter. Closed.

**Parked as a tripwire, not a ticket:**

- The lookup walk's hop counter is advanced on the stream-limit path even though no message left
  this node, spending one hop of the time-to-live budget later messages carry. Harmless today —
  the walk is bounded by its attempt counter regardless, and over-spending is the conservative
  direction. Recorded as a `NOTE:` at that exact site in `fret-service.ts`, with the revisit
  condition (our ceiling firing often enough to shorten real routes).

**Filed as a new ticket (major):**

- `tickets/backlog/debt-local-limit-arms-untested.md` — seven places observe an outbound
  outcome and must handle this case; only one of them has a test, and it drives the seam in
  isolation rather than through a real call site. The three write-only sites under-reported for
  the life of the feature and were found by reading, not by a failing test. The ticket climbs
  the ladder rather than asking for six point tests: preferred fix is to count the event where
  it is *decided* (one place, `classify`) so no observing site can forget it; fallback is one
  table-driven test over all arms.

**Considered and dropped:** the implementer flagged the skip-the-snapshot-fetch-when-the-ping-
did-not-answer behaviour as untested. It is not — `test/stabilize-concurrency.spec.ts` covers
it ("a near peer whose ping never answers is not snapshot-fetched at all"), and that case passed
in this run. No ticket.

**Empty categories, stated explicitly:** no blocked items — nothing here needs a human decision
or an out-of-repo dependency. No accepted-tradeoff notes at any touched site had their revisit
condition trip, so nothing previously declined was re-filed.

**Expected merge touch:** the sibling `stream-caps-plumbing` ticket edits the same
*Stream management* bullet in `docs/fret.md`.
