description: A test now covers the cap on how many extra peers a departing node says goodbye to, and the design doc records that cap.
files: packages/fret/test/churn.leave.spec.ts, packages/fret/src/service/fret-service.ts, docs/fret.md
----

Reviewed commit `5ea8321` (`ticket(implement): leave-fanout-cap-untested`). Test-only change;
`fret-service.ts` is byte-identical to HEAD. The clamp under test is the `.slice(0, fanOut)` on the
`extra` list in `sendLeaveToNeighbors` (`src/service/fret-service.ts:1892`), Core 4 / Edge 2.

The diff: `makeSenderRig` gained an optional `profile` parameter threaded to its single
`new CoreFretService(...)` line (every existing caller unchanged); a new `describe` at the edge
profile marks two window peers `dead` so the live-member-scoped cohort walk reaches further than the
unfiltered S/P window walk, producing three eligible connected peers outside the window against an
edge fan-out of 2, and asserts the *sum* of notices equals the fan-out; and the misnamed
`fan-out notifies peers beyond immediate S/P` star-topology test was deleted (its own comment
conceded it only asserted the survivors kept running).

## Review findings

**Checked**

- Read the implement diff with fresh eyes before the handoff summary, twice across runs.
- Read `sendLeaveToNeighbors` in full (`src/service/fret-service.ts:1860-1905`): unfiltered
  `ringNeighborsBothSides` walk for `ids` / `spSet`, `computeReplacements` off that set, serial
  notice loop with an `isDoomedDial` skip, then `expandCohort(ids, selfCoord, fanOut, {self})`,
  `filter(!spSet.has(id) && isConnected(id))`, `.slice(0, fanOut)`, second serial loop. Matches the
  test's account.
- Read `makeSenderRig` / `SenderRig` (`test/churn.leave.spec.ts:530-607`) and the neighbouring
  `advertises the live members…` / `caps the replacement list at six ids` cases the new block was
  modelled on.
- Targeted spec: 22 passing, ~10 s. `npx tsc --noEmit` from `packages/fret` clean (exit 0), which
  also settles the orphaned-type-import question by hand-counting.
- **Full suite: `yarn test` from `packages/fret` — 1248 passing, 0 failing, 9m.** No lint step
  exists in this repo (`yarn check` is the gate; `yarn format` must not be run per AGENTS.md), and
  typecheck was already green, so `yarn test` was the whole remaining gate.
- Docs: read the *Leave* section of `docs/fret.md` against the code.
- Deletion orphaned no helper or constant; `(rig.svc as any).cfg` is long-standing house precedent
  in this spec (14 other sites); `delay` is an existing local helper already used by another case.

**Found and fixed inline (minor)**

- *Fan-out premise comment.* The new case hand-copies the Core 4 / Edge 2 number. Checked whether it
  could read it off the service instead: it cannot — `fret-service.ts:1883` is a bare
  `this.cfg.profile === 'core' ? 4 : 2` local, and the only `cfg`-level fan-out is `announceFanout`
  (Core 8 / Edge 4), a different bound. So the comment was the thing to fix; it now states that the
  derivation is a hand-copy and that the `expect(fanOut).to.equal(2)` below it is what catches a
  retune.
- *Docs gap.* The sender-side beyond-S/P cap was stated nowhere in `docs/fret.md`. Step 3 of the
  leave protocol said only "Notify any connected peers outside S/P before disconnecting", and the
  *Per-leave outbound ceiling* bullet is about the recipient-side `announceFanout` — a different
  number that reads as if it covered this one. Added a sentence to step 3 naming Core 4 / Edge 2,
  distinguishing it from `announceFanout`, saying what pool it slices, and pointing at the new test.

**Tripwire (parked at the site, not filed)**

- The new case ends with a fixed `await delay(100)`. It is a handler-delivery settle rather than a
  convergence guess (every send is awaited inside `send()`), and no condition-shaped alternative
  exists that is not itself a settle. A `NOTE:` at that line states this and names the replacement
  to reach for if it ever flakes.

**Major findings: none, and the reason is specific** — the change is test-only, the production clamp
is unmodified (`git diff` against HEAD shows `fret-service.ts` untouched, corroborating the
implementer's report that the mutation check was reverted), and the implementer's mutation check
(removing `.slice(0, fanOut)` fails the new case with `expected 3 to equal 2`) shows the case is
non-vacuous. Re-running the mutation was judged not worth the budget.

**Gaps the handoff declared, weighed and accepted as-is**

- The case couples to `expandCohort`'s alternating reach: a future change shortening that reach fails
  the case as though the clamp broke. Accepted — the case's own comment says it fails loudly rather
  than vacuously in that direction, which is the mitigation, and the alternative (asserting the pool
  shape separately) buys less than it costs.
- Nothing asserts the edge profile changed *only* the fan-out; the rig trusts the profile split.
  Accepted — profile plumbing is pinned elsewhere (`test/rpc.stream-caps-profile.spec.ts` and
  friends), and re-asserting it here would duplicate that coverage.
- `replacements` is deliberately unasserted in the new rig. Accepted — the sibling cases in the same
  file cover it, and asserting it twice is where two expectations drift apart.
- `plan/23-fret-service-decomposition`'s second arm changes the target list `spSet` derives from.
  Noted, not acted on: whichever of the two lands second must re-check the other's expectations.

**Budget note.** Four review runs; the first three were cut short by the token budget before the full
suite could run. Nothing was left half-applied at any hand-off.
