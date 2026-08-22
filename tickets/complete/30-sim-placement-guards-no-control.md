description: The simulation test that checks whether grouping peers into clusters makes messages travel farther was correct but so slow it tripped the test framework's five-minute limit. It now runs in under three minutes by reusing measurements between its two halves instead of rebuilding them, and the duplicated clock-driving helper the simulation tests each carried a copy of now lives in one place.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/simulation/pump.ts, packages/fret/test/simulation.routing.spec.ts, packages/fret/test/churn-scenarios.spec.ts, docs/fret.md
---

Review of `sim-placement-guards-no-control` complete. The implement-stage work — a bounded-store
placement guard with a real uniform control — is correct as measured and now runs inside its
timeout.

## What shipped in the review pass

- **`test/simulation/pump.ts`** (new, 9 lines) — the shared `pump(sim, uptoMs)`: drive every event
  scheduled up to `uptoMs`, then park the clock there. It was byte-identical in
  `simulation.routing.spec.ts` and `message-bus.spec.ts`; both now import it.
- **`message-bus.spec.ts`** — `centersFor` deleted. It built and `initialize()`d a whole 300-peer
  clustered simulation purely to read its cluster centers back, once per seed: 5 of the sweep's 15
  300-peer initializations existed only to fetch three numbers. `measure(seed, placement, given?)`
  now returns the centers the clustered arm placed, and the uniform arm is *required* to be handed
  them — so the control keeps identical coordinates and an identical sender-selection rule, and the
  requirement is asserted rather than assumed.
- **`churn-scenarios.spec.ts`** — one `NOTE:` tripwire (see *Tripwires parked* below).

## Review findings

### Blocking failure — fixed

`clustered placement: inter-cluster routing takes more hops` exceeded mocha's 300 s timeout. Every
measurement it made was correct and reproduced the table in its own comment; the failure was elapsed
wall time alone (the test body is synchronous, so the timer fires only once it returns). Caused by
this ticket's own diff, so it was fixed here rather than reported as pre-existing.

Fixed by removing the five redundant 300-peer initializations described above — 15 sims down to 10.
**Measured: 171 s, from over 300 s.** The seed set and `ROUTES` were left untouched, so the measured
seed table in the test's comment still describes exactly what the test runs. Raising the timeout was
explicitly rejected: a single test over five minutes is past agent-runnable.

### Fixed inline (minor)

- **`pump` duplicated verbatim across two specs** — extracted to `test/simulation/pump.ts`.
- **`centersFor` throwing away a third of the sweep's work** — folded into `measure`, above.
- **Unescaped apostrophe inside a single-quoted assertion message** (the previous review run wrote
  `'uniform arm must be given the clustered arm's centers'`), a syntax error caught by `tsc` at the
  start of this pass. Reworded to `'uniform arm must be given the clustered centers'`.

### Considered and accepted as shipped (recorded at their code sites)

- **`storeSize` sampled from the first sender only.** One sample proves what the assertion claims —
  that the capacity bound actually bit — and every peer in the sweep is enforced against the same
  capacity. `NOTE:` at the sample site in `measure`.
- **`cfgFor` passes `clusterConfig` on the uniform arm too**, where it is unused. Accepted, and
  arguably right: the two configs then differ by `placement` alone, which is the whole point of the
  control. Comment at that field.
- **The ~90-line comment block above the second test.** Judged and left as-is. The source-hygiene
  rule prefers naming and composition over comment blocks, but this block is not explanation that
  a name could carry: it is two *measured* seed tables plus the three-conditions argument for why
  the earlier shapes of the test measured nothing. Both tables are load-bearing evidence for the
  thresholds — deleting either leaves the numbers unjustified. The constants it explains are already
  named (`CAPACITY`, `CONVERGE_MS`, `ROUTES`, `MIN_HOP_MARGIN`).

### Aspect angles examined

- **Source file size.** `wc -l`: `message-bus.spec.ts` 589, `simulation/fret-sim.ts` 923,
  `simulation/placement.ts` 135, `simulation/placement-assertions.ts` 81, `simulation/pump.ts` 9.
  No split filed. 589 lines across five `describe` blocks is within range for a spec file, and the
  natural seam (`Placement distributions`) is 190 of those lines — splitting now buys a second file
  and a shared-import hop for no readability gain. It is the seam to take if the file grows.
- **Resource cleanup.** Simulations are local values dropped at the end of each `it`; nothing arms a
  wall-clock timer (the sim clock is a scheduler the test drives by hand). Confirmed rather than
  assumed: the mocha exit watchdog is armed via `.mocharc.json` on every run from `packages/fret/`
  and fails a run still alive 10 s after the last test — this run exited cleanly.
- **Type safety.** `npx tsc --noEmit` clean against the shipped tree, including
  `verbatimModuleSyntax` (`pump.ts` imports `FretSimulation` as `import type`; both specs still
  *use* the value import after the pump deletions).
- **Docs.** `docs/fret.md`, *Testing strategy → Simulation*, the bullet beginning "**Placement is
  guarded by two tests**". Diffed against the shipped test bodies and against this run's output —
  every number it quotes still holds: n=30 / 12–17 vs 1 at threshold 5; n=300 / capacity 32 /
  4.8–7.1 vs 2.0–3.1 hops; 1.5-hop margin against a smallest observed margin of 2.4; 2m+1 = 17.
  No edit needed.

### Empty categories, stated

- **No major findings, so no new `fix/`, `plan/` or `backlog/` tickets were filed.** Everything
  found was either a duplication or a redundant-work defect fixable in this pass, or a judgement
  call resolvable at its own code site.
- **No `blocked/` ticket.** Nothing here needed a human decision or an out-of-repo dependency.
- **No pre-existing failures reported.** The one failure this ticket's validation surfaced was
  caused by this ticket's own diff, so `tickets/.pre-existing-error.md` was deliberately not written.

## Tripwires parked (not tickets)

- **A second, different pump idiom** — pop an event, then discard it when it lands past the bound,
  where the shared `pump` peeks first and leaves it queued. It is pre-existing, was not introduced by
  this diff, and appears at nine sites (`churn-scenarios.spec.ts` x6, `sim-profiles.spec.ts` x2,
  `message-bus.spec.ts` x1). Checked all nine: every one is the *last* drain of its simulation,
  followed only by reads (`metrics.finalize()`, `snapshotCoverage()`, a `return`), so the dropped
  event changes no reading today. `NOTE:` parked at the first `churn-scenarios.spec.ts` site with
  the condition that would make it matter — a site that drains to a bound and then keeps simulating.
- Two tripwires from earlier runs stay where they were parked and were not re-filed: `spreadBits`
  is exact only to ~52 bits because `CoordPlacement.clusteredCoord` scales its Gaussian offset
  through a JS float (noted at that site), and the sim's near radius clamps to half the ring at a
  32-entry store so every candidate takes the selector's near branch (noted at `nearRadiusFor` in
  `test/simulation/fret-sim.ts`, restated in the test's own comment).

## Validation

```
cd packages/fret && npx tsc --noEmit                                    # clean
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/message-bus.spec.ts" "test/churn-scenarios.spec.ts" --timeout 300000
```

**29 passing, 0 failing, 4m total.** The formerly-timing-out test: 171 460 ms, comfortably inside its
300 s timeout. All five seeds reproduce the comment's table exactly (clustered 4.90 / 5.00 / 7.10 /
4.80 / 6.70 versus uniform 2.30 / 2.60 / 2.00 / 2.00 / 3.10), every arm 10/10 successful at store
size 32.

There is no lint step in this repo — `yarn check` (typecheck + build + test) is the gate, and
`yarn format` / `format:check` are documented as unusable against the house tab style
(see `AGENTS.md`).
