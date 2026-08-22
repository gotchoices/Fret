description: A review pass over two simulation tests that check whether grouping peers into clusters really changes how messages travel was cut short by a budget limit; the code was read and notes taken, but the tests still need to be run and a few small clean-ups applied.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/simulation/placement-assertions.ts, packages/fret/test/simulation/placement.ts, packages/fret/test/simulation/fret-sim.ts, packages/fret/test/churn-scenarios.spec.ts, docs/fret.md
difficulty: medium
---

Continuation of the review stage for `sim-placement-guards-no-control`. The prior review run read
the whole implement-stage diff (`git diff 4584078..HEAD -- packages/fret/test/message-bus.spec.ts
packages/fret/test/churn-scenarios.spec.ts packages/fret/test/simulation/`) and hit the runner's
soft token budget before running anything. Nothing below needs re-reading the ticket history — the
findings are stated in full.

## Already done this run

- Read the cumulative diff for all five touched files with fresh eyes.
- **Fixed inline**: the doc comment on `MAX_PEERS_IN_ONE_SPACING_ARC` in
  `test/simulation/placement-assertions.ts` still said its two arms "are asserted below". They are
  not below — the constant moved out of `churn-scenarios.spec.ts` into this module and the
  assertions stayed behind. Comment now names the spec file. **This edit is uncommitted and
  unverified** (no typecheck run after it); it is a comment body only, so the risk is a long line,
  not a compile error.

## Must still be done before this ticket can move to complete/

**Validation — nothing was run.** Both from `packages/fret/`:

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" "test/churn-scenarios.spec.ts" --timeout 300000
npx tsc --noEmit
```

Budget permitting, also `yarn test` — the implement handoff never ran the full suite either, and
its stated blast-radius argument ("only a spec and a docs file changed") is reasoning, not a green
run. There is no lint step in this repo (`yarn check` = typecheck + build + test; `yarn format` is
forbidden, see AGENTS.md).

**Verify the API surface the new test leans on actually exists** — read, don't assume:
`FretSimulation.getStores()`, `scheduler.peek()`, `scheduler.advanceTo()`, and a `capacity` field
on `SimConfig` (`test/simulation/fret-sim.ts`). The typecheck above covers this, so running it is
the cheap proof.

## Findings recorded but not yet dispositioned

Each needs a judgement call the prior run did not get to make. None is believed to be a correctness
defect; they are hygiene and cost.

- **Two different pump idioms inside one `describe`.** The second test defines a local `pump(sim,
  uptoMs)` helper (peek/nextEvent/advanceTo). The first test's `reading()` hand-rolls a different
  loop that calls `nextEvent()` and then *discards* the popped event when its time exceeds the
  bound. Same intent, two implementations, and the first silently drops one event. Candidate for a
  shared helper in `test/simulation/` (the routing spec has a third copy of this idiom — check
  `test/simulation.routing.spec.ts` before writing a fourth). Disposition: probably a minor
  inline fix; if it grows past the two call sites, it is a `debt-` ticket.
- **`centersFor(seed)` builds and initializes an extra 300-peer simulation per seed purely to read
  the cluster centers**, then `measure()` builds another for the clustered arm with the same
  config. That is 5 wasted `initialize()` calls at n=300 across the sweep. Given the test already
  costs ~121 s, this is worth checking: if `measure()` can return the centers from the clustered
  arm it already builds and the uniform arm can be driven afterwards, the sweep loses a third of
  its sims. Do **not** restructure so the uniform arm derives centers separately — that would
  destroy the control (both arms must route between identical coordinates).
- **`storeSize` is sampled from the first sender only** (`firstSender ??= from`). One sample is
  enough to prove the bound bit, which is the assertion's stated purpose, so this is likely fine as
  is — but say so explicitly in the findings rather than leaving it unremarked.
- **`cfgFor` passes `clusterConfig` on the uniform arm too**, where it is unused. Harmless and
  arguably keeps the two configs identical-but-for-placement, which is the point of the control.
  Decide and state, don't silently leave it.
- **The runtime tax is the implement stage's own flagged gap** and is a judgement call for this
  review: `test/message-bus.spec.ts` went from a few seconds to ~130 s, all of it the second test
  (five seeds x two arms x ~12 s). Levers are fewer seeds or a smaller `ROUTES`. The implementer
  kept five seeds deliberately because the rewrite's whole point was to stop asserting on one seed.
  Either endorse that or cut it — but if cut, the measured table in the test's comment must be
  re-taken, not just trimmed.

## Aspect angles not yet covered

The prior run read for correctness and comment accuracy only. Still unexamined: source-file size
(`test/message-bus.spec.ts` is now large — measure it with a line count and state the number),
whether the second test's ~90-line comment block would be better as shorter prose plus a named
constant, resource cleanup (the sims are local and dropped, but confirm nothing arms a timer the
mocha exit watchdog would catch), and whether `docs/fret.md`'s new *Testing strategy -> Simulation*
bullet matches what the shipped test actually asserts (it was read in the AGENTS.md context and
looked accurate, but was not diffed against the final test body).

## Tripwires already parked at their code sites (do not re-file)

- `spreadBits` is exact only to ~52 bits because `CoordPlacement.clusteredCoord` scales its Gaussian
  offset through a JS float — noted at that site.
- The sim's near radius clamps to half the ring at a 32-entry store, so every candidate takes the
  selector's near branch — noted at `nearRadiusFor` in `test/simulation/fret-sim.ts` and restated in
  the test's comment.

## Output

The `complete/` ticket must carry a `## Review findings` section listing what was checked, what was
found, and what was done — with empty categories stated explicitly and with a reason, not omitted.
