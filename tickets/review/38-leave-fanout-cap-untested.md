description: A test was added to check that a departing peer's courtesy goodbye list is capped at a fixed number. Two reviewer runs have now been cut short by budget limits, so the remaining checks — running the test suite and confirming the project documentation still matches — still need doing.
files: packages/fret/test/churn.leave.spec.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: medium
----

<!-- resume-note -->
**Two prior review runs were cut short by a token budget warning.** Run 1 read the implement diff
and the production code under test. Run 2 re-read the diff with fresh eyes and cleared one
checklist item (orphaned helpers). **Neither run changed any code** — `git status` is clean apart
from the ticket board and `tickets/.in-progress`. Nothing is half-applied.

Resume at the checklist at the bottom. **Budget note for the next run:** the two remaining
expensive items are the test runs and the docs read. Do those *first*, before re-deriving any
analysis already written down here — the two candidate findings below are the only open judgement
calls and both are small.

## What is under review

Commit `5ea8321` (`ticket(implement): leave-fanout-cap-untested`). Test-only:
`packages/fret/src/service/fret-service.ts` is byte-identical to HEAD. Three edits, all in
`packages/fret/test/churn.leave.spec.ts`:

- `makeSenderRig` gained an optional fourth parameter `profile: 'core' | 'edge' = 'core'`, threaded
  to the single `new CoreFretService(departing, { profile, k })` line. Every existing caller is
  unchanged.
- A new `describe` — *at the edge profile, with the fan-out pool wider than the cap* — with its own
  `before`/`after` (`sendLeaveToNeighbors` is once-per-lifetime per service, so it cannot share the
  neighbouring rig's departure). It marks two window peers `dead` so the live-member-scoped cohort
  walk reaches further than the unfiltered S/P window walk, producing three eligible connected
  peers outside the window against an edge `fanOut` of 2, then asserts the *sum* of notices across
  those three equals `fanOut`.
- Deletion of the misnamed `fan-out notifies peers beyond immediate S/P` star-topology test, whose
  own comment conceded it only asserted the survivors kept running.

The clamp under test is the `.slice(0, fanOut)` on the `extra` list in `sendLeaveToNeighbors`
(`src/service/fret-service.ts`, around line 1892).

## What the interrupted runs established

Read and confirmed by eye, not by running anything:

- The production `sendLeaveToNeighbors` body matches the ticket's description of it: unfiltered
  `ringNeighborsBothSides` walk for `ids`/`spSet`, `computeReplacements` off that set, serial S/P
  notice loop with an `isDoomedDial` skip, then `expandCohort(ids, selfCoord, fanOut, {self})`,
  `filter(!spSet.has(id) && isConnected(id))`, `.slice(0, fanOut)`, second serial loop. So the
  test's account of *why* the slice is otherwise a structural no-op is consistent with the code.
- `(rig.svc as any).cfg` reaching into private service state is long-standing house precedent in
  this spec (14 other sites), so the new case's use of it is not a new finding.
- `delay` is a local one-line helper at the top of the file and is already used by an existing case
  (`await delay(settleMs)`), so the new `await delay(100)` is not a new idiom in this file.
- **The deletion orphaned nothing** (checklist item cleared by run 2). Occurrence counts in
  `packages/fret/test/churn.leave.spec.ts` after the deletion: `buildMesh` 3, `Mesh` (the type
  import plus the `let mesh` declaration), `waitFor` 7, `allConverged` 2, `anyProgressed` 2,
  `alreadyStopped` 4, `CONVERGE_MS` 2, `PROGRESS_MS` 2 — every helper and constant the deleted
  case used still has at least one other user, so no import or local went dead. (Two occurrences
  of a name means the declaration plus one use.) `tsc --noEmit` is still the authority here and is
  on the checklist anyway.

## Findings so far (not yet dispositioned)

Neither has been verified against a run; treat both as candidates, not conclusions.

- **The `fanOut` premise comment overstates what it does.** The new case computes
  `fanOut = (rig.svc as any).cfg.profile === 'core' ? 4 : 2` and comments that it is "read from the
  profile rather than written as a literal, so a profile retune fails the premise below instead of
  quietly making the case vacuous". It reads the profile *name* and then re-derives the number with
  a hand-copy of the production expression — so the fan-out magnitude now exists in two places with
  nothing tying them together. The `expect(fanOut).to.equal(2)` immediately below does catch a
  retune, but by the literal, not by the derivation the comment claims. Decide between: fixing the
  comment to say what the line actually does; or reading the real number off the service the way
  the line above it reads `cfg.m` (first check whether the fan-out is exposed on `cfg` at all — if
  it is, that is the fix and it retires the whole finding). Likely minor — fix inline.
- **The fixed `await delay(100)` settle**, which the implementer flagged themselves. It is not a
  convergence guess (all sends are awaited inside `send()`), only a handler-delivery settle, but it
  is a wall-clock guess in a file whose header is largely about having removed fixed sleeps. Judge
  whether a condition-shaped alternative exists; if not, this is a tripwire (`NOTE:` at the site),
  not a ticket.

## Remaining checklist

- **Run these first** (they are the budget risk), from `packages/fret`, and require passing:
  `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/churn.leave.spec.ts" --timeout 30000`,
  then `npx tsc --noEmit`, then the full `yarn test` (~8 min; run in the foreground with no
  redirection so the runner's idle timer stays alive). There is no lint step in this repo —
  `yarn check` (typecheck + build + test) is the gate, and `yarn format` must **not** be run
  (see `AGENTS.md`).
- Confirm `docs/fret.md` needs no change. The *Leave* section already states the fan-out and its
  bound; the handoff says nothing in `docs/` referenced the deleted test. Verify by reading, not by
  assuming — treat docs as out of date until read.
- Read the whole new `describe` in context, plus the neighbouring `at the shipped k of 15` block
  it was modelled on, and `makeSenderRig` / `SenderRig` (`noticesAt`, `idAt`, `send`) — neither
  interrupted run saw them outside the diff. (Spec file is 853 lines; the sender-rig region starts
  around line 555.)
- Re-check the rig arithmetic independently (the handoff calls every number load-bearing): m = 8,
  40 seeded peers, cohort ask of 18 alternating 9 per side, dead +2/+3 pulling the clockwise reach
  to `{+1, +4..+11}`, +32 dropped as a ghost by `isConnected`. A wrong number here makes the case
  pass vacuously.
- Decide whether the anti-vacuity proof needs re-running. The handoff reports a mutation check
  (removing `.slice(0, fanOut)` makes the new case fail `expected 3 to equal 2`) and that
  `fret-service.ts` was restored afterwards — `git diff` against HEAD is clean, which corroborates
  the restore but not the mutation result.
- Weigh the four gaps the handoff declares openly, and record each as fixed / tripwire /
  new ticket / accepted: the coupling to `expandCohort`'s alternating reach (a shortened reach
  fails as "the clamp broke"); nothing asserting the edge profile changed only `fanOut`;
  `replacements` deliberately unasserted in the new rig; and the interaction with
  `plan/23-fret-service-decomposition`, whose second arm changes the target list `spSet` derives
  from — whichever lands second must re-check the other's expectations.

## Output

A `complete/` ticket with a `## Review findings` section covering what was checked, what was found,
and what was done — including the two candidate findings above, dispositioned. Empty categories are
fine when stated with a reason.
