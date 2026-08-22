description: A test file was added that checks the network code handles peers replying "I'm busy" or with garbage; the review of that test file was cut short by a budget limit and needs finishing.
files: packages/fret/test/maintenance-nonok-replies.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, packages/fret/test/helpers/backoff.ts, packages/fret/src/service/fret-service.ts, packages/fret/test/fetch-snapshot-failure-arms.spec.ts, docs/fret.md
difficulty: medium
---

<!-- resume-note -->
A prior review run was cut off by `BUDGET_WARNING` before it could run validation or reach a
disposition. No code was changed and no findings were filed. This ticket replaces the original
review ticket; the implement-stage handoff it was reviewing is reproduced under *Handoff being
reviewed* below so the next agent does not need to re-read the git history for it.

## What the prior run established

**The diff under review is one commit, `1b85381`, and it is test-only.** It adds
`packages/fret/test/maintenance-nonok-replies.spec.ts` (197 lines) and moves the ticket file.
No production source changed. The `Behavior` widening on `test/helpers/maintenance-rig.ts`
(`busy` / `not-ok` / `undecodable`, per-(peer, protocol) overrides) landed earlier on this branch
in `9b7c410` under a different ticket and is **not** part of this diff — read it as context, not
as work to review here.

Both files were read in full. The rig's stub-connection approach, the framing of the
`undecodable` body, and the ping-only guard on `not-ok` all check out on inspection.

## Observations recorded but NOT yet dispositioned

These are candidate findings from a read of the spec alone. None was verified against the
production code, so each still needs the "is this real" pass before it is fixed, filed, or
dropped. Do not treat the list as a verdict.

- **`expectAnsweredNotStruck` asserts `membership === 'member'` against a peer seeded as
  `member`.** That assertion can only ever catch a *demotion*, never confirm the promotion the
  spec's headline claims ("an answer on our protocol confirms membership"). Seeding `unknown` on
  at least one arm would make it load-bearing. Check whether an `unknown` peer would still be
  selected by the near pass at all — the near list is live-member-gated, so it very likely would
  not, in which case the assertion is as strong as this rig can make it and the comment overstates
  what it proves. Decide which, and either strengthen the arm or soften the comment.
- **Case 3 (`undecodable`) drops the `pingsOk` delta assertion** that cases 1 and 2 both carry.
  Almost certainly an oversight rather than a decision; one line to restore symmetry.
- **`backoffOf` (`test/helpers/backoff.ts`) was never read.** Its `factor()` semantics are assumed
  by three arms (`> 0` on busy, `=== 0` on the two decay arms). Confirm `factor()` returns 0 rather
  than `undefined`/throwing for a peer with no backoff entry, or the two `=== 0` assertions may be
  passing on a coincidence.
- **Overlap with `fetch-snapshot-failure-arms.spec.ts` is asserted by the implementer, not
  verified.** The handoff itself invites deleting case 4 if a reviewer disagrees it is distinct.
  Read that spec and make the call.
- **Every assertion is untested against the production arms.** `probeNeighborLatency`,
  `noteRpcFailure`, `probeAndFetch` and `fetchAndMergeSnapshot` were not opened. The spec's claims
  about which arm moves which counter are plausible and internally consistent, but a review that
  never read the code under test has verified nothing.

## The one finding the implementer deliberately escalated

`getDiagnostics()` returns the live `diag` object rather than a copy
(`packages/fret/src/service/fret-service.ts:511`), so **any** spec that captures it as an object
and diffs later reads zero deltas and passes vacuously. This spec avoids the trap by reading
scalars. The implementer left the class-level question for the reviewer and did not audit other
specs.

Two things are still owed here, and neither was done:

- **The audit.** Grep the other specs for the object-snapshot pattern. If any spec has the hole, it
  is passing vacuously today and that is a real defect, not a tripwire.
- **The disposition.** Returning a frozen shallow copy would make the bad pattern unrepresentable,
  but it is a production change with a per-call allocation cost. Climb *Architecture first* before
  filing anything: this is a types/representation fix if it is worth doing at all. If it is
  declined, it needs an accepted-tradeoff `NOTE:` at the `getDiagnostics` site so the next reviewer
  does not re-discover it — the trap is currently documented only in the header of one spec, which
  is the wrong home for a class-level concern.

## Validation still owed

Nothing was run. All of it remains:

- `cd packages/fret && npx tsc --noEmit`
- `cd packages/fret && yarn test` (~8 min; foreground, no redirection — see the runner rules)

There is no lint step in this repo; `yarn check` (typecheck + build + test) is the gate, and
`yarn format` / `yarn format:check` must **not** be run (see AGENTS.md).

## Docs

`docs/fret.md` line 79 forward-references `test/maintenance-nonok-replies.spec.ts` twice. The
implementer says both were verified against the landed filename; that was not re-checked. Confirm
it, and check whether any *other* doc claim the spec touches (the `busy`-records-backoff arm, the
`fetchAndMergeSnapshot` silent arm) is now stated in the document but unpinned or misstated.

## Handoff being reviewed

The implement-stage handoff claimed: four cases, all passing; `tsc --noEmit` clean; `yarn test`
1264 passing / 0 failing; no `.pre-existing-error.md` written. It was honest about its gaps —
coarse backoff assertion (factor `> 0` only, arithmetic left to `debt-backoff-map-test-surface`),
core profile only, one peer per case, no negative-pong arm on the fetch side (the rig rejects it
loudly and a neighbors reply has no `ok` field), and no comparative case proving a bad answer
scores *lower* than a good one. Treat those as the floor the review should push on, not as
settled scope.
