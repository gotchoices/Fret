description: A test was added to check that a departing peer's courtesy goodbye list is capped at a fixed number. Three reviewer runs have now been cut short by budget limits; the only remaining work is running the whole test suite once and confirming the project documentation still matches.
files: packages/fret/test/churn.leave.spec.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
difficulty: easy
----

<!-- resume-note -->
**Three prior review runs were cut short by a token budget warning.** Run 1 read the implement diff
and the production code. Run 2 re-read the diff with fresh eyes and cleared the orphaned-helper
check. **Run 3 did the expensive verification and both inline fixes** — see *Done* below. `git
status` now shows one real edit (`packages/fret/test/churn.leave.spec.ts`, comments only) plus the
ticket board. Nothing is half-applied.

**Budget note for the next run: only two items remain, and one of them is the ~8 minute full test
suite. Do it first, then the docs read, then write the `complete/` ticket. Do not re-derive any
analysis below — the review is finished apart from those two checks.**

## What is under review

Commit `5ea8321` (`ticket(implement): leave-fanout-cap-untested`). Test-only: `fret-service.ts` is
byte-identical to HEAD. Three edits in `packages/fret/test/churn.leave.spec.ts`:

- `makeSenderRig` gained an optional fourth parameter `profile: 'core' | 'edge' = 'core'`, threaded
  to its single `new CoreFretService(departing, { profile, k })` line. Every existing caller is
  unchanged.
- A new `describe` — *at the edge profile, with the fan-out pool wider than the cap* — with its own
  `before` / `after` (a service sends leave notices once per lifetime, so it cannot share the
  neighbouring rig's departure). It marks two window peers `dead` so the live-member-scoped cohort
  walk reaches further than the unfiltered successor/predecessor window walk, producing three
  eligible connected peers outside the window against an edge fan-out of 2, then asserts the *sum*
  of notices across those three equals the fan-out.
- Deletion of the misnamed `fan-out notifies peers beyond immediate S/P` star-topology test, whose
  own comment conceded it only asserted the survivors kept running.

The clamp under test is the `.slice(0, fanOut)` on the `extra` list in `sendLeaveToNeighbors`
(`src/service/fret-service.ts:1892`).

## Done (verified this run — do not redo)

- **Targeted spec passes**: `node --import ./register.mjs node_modules/mocha/bin/mocha.js
  "test/churn.leave.spec.ts" --timeout 30000` → 22 passing, 10 s. Both new cases green.
- **`npx tsc --noEmit` from `packages/fret` is clean** (exit 0), which also settles the
  orphaned-import question run 2 counted by hand.
- **Read `sendLeaveToNeighbors` in full** (`src/service/fret-service.ts:1860-1905`). It matches the
  test's account: unfiltered `ringNeighborsBothSides` walk for `ids` / `spSet`,
  `computeReplacements` off that set, serial notice loop with an `isDoomedDial` skip, then
  `expandCohort(ids, selfCoord, fanOut, {self})`, `filter(!spSet.has(id) && isConnected(id))`,
  `.slice(0, fanOut)`, second serial loop.
- **Read `makeSenderRig` / `SenderRig` in full** (`test/churn.leave.spec.ts:530-607`) plus the
  neighbouring `advertises the live members…` and `caps the replacement list at six ids` cases the
  new block was modelled on. The `profile` thread-through touches exactly one line and every
  existing caller keeps the `'core'` default.
- **Finding 1 (the fan-out premise comment) resolved and fixed inline.** Checked whether the number
  is exposed on the service: it is **not** — `fret-service.ts:1883` is a bare
  `this.cfg.profile === 'core' ? 4 : 2` local, and the only `cfg`-level fan-out is
  `announceFanout` (Core 8 / Edge 4, `fret-service.ts:500`), a *different* bound. So reading the
  real number off the service is not available and the comment was the thing to fix; it now says
  the derivation is a hand-copy and that the `expect(fanOut).to.equal(2)` below it is what catches
  a retune.
- **Finding 2 (the fixed `await delay(100)`) dispositioned as a tripwire, parked at the site.** It
  is a handler-delivery settle, not a convergence guess (every send is awaited inside `send()`),
  and no condition-shaped alternative exists that is not itself a settle. A `NOTE:` at the line
  states that and names the replacement to reach for if it ever flakes. Not a ticket.
- **Prior runs' cleared items**, restated so they are not re-derived: `(rig.svc as any).cfg` is
  long-standing house precedent in this spec (14 other sites); `delay` is an existing local helper
  already used by another case; the deletion orphaned no helper or constant.

## Remaining (all that is left)

- **Run the full suite in the foreground with no redirection**, from `packages/fret`:
  `yarn test` (~8 min). Must pass. There is no lint step in this repo — `yarn check` (typecheck +
  build + test) is the gate, and `yarn format` must **not** be run (see `AGENTS.md`). Typecheck is
  already green, so `yarn test` alone is sufficient.
- **Read `docs/fret.md`'s *Leave* section and decide one thing**: the sender-side beyond-S/P
  fan-out cap (Core 4 / Edge 2) does **not** appear to be stated anywhere in that section — step 3
  says only "Notify any connected peers outside S/P before disconnecting", and the stated
  "Per-leave outbound ceiling" bullet is about the *recipient's* cost and its `announceFanout`,
  which is a different number. Confirm by reading, then either add one sentence naming the Core 4 /
  Edge 2 cap under *Leave* (minor, fix inline in this pass) or record why it is already covered.
  This is the one docs decision left; everything else the change touches is test-only.
- Write the `complete/` ticket with a `## Review findings` section: what was checked, what was
  found, what was done. Fold in the *Done* list above verbatim, the two dispositioned findings, the
  docs decision, and the four gaps below. Say explicitly that no major finding was raised and why —
  the change is test-only, the production clamp is unmodified, and the new case was shown
  non-vacuous by the implementer's mutation check.

## Gaps the handoff declares openly — weigh and record, do not investigate

Each needs a disposition sentence in `## Review findings`, not new analysis:

- The new case couples to `expandCohort`'s alternating reach: a future change that shortens that
  reach fails the case as though the clamp broke. The case's own comment already says the count
  fails loudly rather than vacuously in that direction, which is the mitigation.
- Nothing asserts the edge profile changed *only* the fan-out; the rig trusts the profile split.
- `replacements` is deliberately unasserted in the new rig — covered by the sibling cases.
- `plan/23-fret-service-decomposition`'s second arm changes the target list `spSet` derives from;
  whichever of the two lands second must re-check the other's expectations. Note it, do not act.
- The implementer reports a mutation check (removing `.slice(0, fanOut)` fails the new case with
  `expected 3 to equal 2`) and that the file was restored. `git diff` against HEAD shows
  `fret-service.ts` unmodified, which corroborates the restore. Re-running the mutation is optional
  and was judged not worth the budget.
