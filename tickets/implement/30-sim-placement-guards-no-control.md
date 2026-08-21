description: Three simulation tests claim to prove that different peer-layout strategies produce different ring shapes, but two of them would pass just as happily against the default layout, so they prove nothing; give them the same both-directions check a sibling test already uses.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/churn-scenarios.spec.ts, packages/fret/test/simulation/placement-assertions.ts, packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation/sim-metrics.ts
difficulty: easy
---

<!-- resume-note -->
TWELFTH run: hit BUDGET_WARNING on the very first two tool calls (two Reads, done in parallel to
confirm state cheaply). Per the budget-warning rule, stopping here WITHOUT running tests or `tsc`.
**All code edits are done — this ticket now has exactly three remaining steps, none of which are
edits**: measure one threshold, run mocha, run tsc. Do all three next run.

**Confirmed this run (cheap, targeted reads only — do not re-verify)**:
- `packages/fret/test/message-bus.spec.ts` L1-7: import line present —
  `import { coordToBigInt, maxPeersInOneSpacingArc, PLACEMENT_SEEDS } from
  './simulation/placement-assertions.js'` at L7, right after the `FretSimulation` import. This
  confirms the eleventh run's section-3 edit landed (import + both case bodies). Do NOT re-read
  the full file to re-verify the case bodies — trust the eleventh run's resume-note (preserved
  below) which quotes them verbatim; it was written immediately after the edit succeeded.
- `packages/fret/test/simulation/placement-assertions.ts` — full file read, verbatim match to
  what every prior run expected. Exports: `coordToBigInt`, `maxPeersInOneSpacingArc`,
  `PLACEMENT_SEEDS = [8008, 8009, 8010, 4242, 99]`, `MAX_PEERS_IN_ONE_SPACING_ARC = 7`.

**Do not repeat the mistake of the last several runs**: do not Read full files "just to be sure."
The two edited files (`message-bus.spec.ts`, `churn-scenarios.spec.ts`) are done. The new file
(`placement-assertions.ts`) is done. Nothing left needs an Edit or Write tool call. What's left is
three shell commands. Run them directly.

## Exact next steps (in order, next run)

### 1. Measure `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC`

In `message-bus.spec.ts`, the `'clustered placement: peers cluster around centers'` case (added
by the eleventh run, right after the `'DeterministicRNG extensions'` describe block, inside
`describe('Placement distributions', ...)`) currently has:

```ts
const CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC = /* MEASURE AND FILL IN */ 0
```

Run just that one test case:

```
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" --grep "peers cluster around centers" --timeout 60000
```

It will fail (threshold 0 always fails `expect(uniform).to.be.at.most(0)` unless uniform reads
exactly 0, which it won't) — that's expected and fine, the point is the `console.log` output. Read
the printed `clustered X, uniform Y` lines for all 5 `PLACEMENT_SEEDS`. Pick a threshold strictly
between the worst (highest) uniform reading and the best (lowest) clustered reading, with margin —
same method as `MAX_PEERS_IN_ONE_SPACING_ARC` in `placement-assertions.ts` (see its doc comment,
reproduced above: picks a value ~1.75x above the worst "fixed" reading and ~1.57x below the best
"buggy" reading). Replace the `/* MEASURE AND FILL IN */ 0` line with the real number, and replace
the comment above it (currently "MEASURE FIRST: ... Replace this comment with the measured table
once done") with an actual measured table in the same format as `placement-assertions.ts`'s doc
comment — seed-by-seed clustered/uniform readings, one line stating the chosen threshold and why
it separates.

Then re-run the same command to confirm the case now passes.

### 2. Resolve the hop-count statistic for case 2

The `'clustered placement: inter-cluster routing takes more hops'` case (added by the eleventh
run, same describe block) is already written to log both candidate statistics:

```
console.log(`  ${placement ?? 'uniform'}: avgRoutingHops ${metrics.avgRoutingHops}, ` +
  `successfulRouteHops avg ...`)
```

and currently asserts only `expect(clustered).to.be.greaterThan(uniform)` on `avgRoutingHops`
(all attempts, success or fail). Run it:

```
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" --grep "inter-cluster routing takes more hops" --timeout 60000
```

- If it passes and the logged numbers show clean separation (clustered avgRoutingHops clearly
  higher than uniform's) — done, leave as-is. Optionally delete the now-unused
  `successfulRouteHops` half of the console.log line (harmless to keep either way).
- If it fails or the two numbers don't separate cleanly, try switching the function to compute and
  return the `successfulRouteHops` average instead (already computed in the log line — just return
  that instead of `metrics.avgRoutingHops`), add a one-line comment saying why (mirroring the
  `successfulRouteHops` doc comment in `sim-metrics.ts`), and re-run.
- If **neither** statistic separates (clustered ≈ uniform either way), the target-generation loop
  (`target[j] = (seed * (j + 1) * 37) & 0xff`) isn't landing targets across cluster boundaries
  under the clustered layout. In that case: read `packages/fret/test/simulation/placement.ts` to
  find where cluster centers are computed (`clusterConfig: { numClusters: 3, spreadBits: 32 }`),
  and change target generation so each of the 10 targets aims near a *different* cluster's region
  (e.g. offset by `i % numClusters` bucket) rather than pure hash noise. Don't ship this case
  unseparating — if this path is needed, it's real investigation and may warrant its own follow-up
  run rather than finishing in the same run as steps 1 and 3 below, depending on budget.

### 3. Full validation

Once both cases above pass:

```
cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" "test/churn-scenarios.spec.ts" --timeout 60000
```

Confirm all cases pass, finishes well inside the 60s timeout.

```
cd packages/fret && npx tsc --noEmit
```

Confirm no type errors (checking specifically that the new `placement-assertions.ts` module and
both edited spec files type-check clean — the earlier-observed "unused import" TS diagnostic on
the placement-assertions import in `message-bus.spec.ts` was suspected stale/mid-edit noise from
an eleventh-run intermediate state; confirm it's actually gone now that both edits are landed).

If any pre-existing (unrelated) test failure surfaces during the full run, follow the Pre-existing
test failures protocol in the ticket workflow rules (check `tickets/.pre-existing-known.md` first,
then `tickets/.pre-existing-error.md` if new) rather than chasing it here.

## After all three steps pass

Write the review/ handoff ticket (slug `sim-placement-guards-no-control`, same as this one minus
the sequence prefix) summarizing: what changed (two vacuous placement tests replaced with
both-directions clustered-vs-uniform checks, following the `assertPlacementSeparates` pattern
already proven in `churn-scenarios.spec.ts`), the new shared module
`test/simulation/placement-assertions.ts`, the measured threshold and its provenance, and which
hop statistic case 2 ended up using and why. Flag any gaps honestly (e.g. if case 2 needed the
target-generation fix, note that as a real change beyond the ticket's original snippet). Delete
this implement-stage ticket file once the review ticket is written.

---

## Preserved from eleventh run (for full context — do not re-verify, described state already
confirmed above)

**What changed in `message-bus.spec.ts`** (verify by reading the file, not by re-deriving):
- Added `import { coordToBigInt, maxPeersInOneSpacingArc, PLACEMENT_SEEDS } from
  './simulation/placement-assertions.js'` after the `FretSimulation` import.
- Replaced `'clustered placement: peers cluster around centers'` with a both-directions
  `reading()` version (builds a `'clustered'` sim and a default/uniform sim per seed, compares
  `maxPeersInOneSpacingArc` between them across `PLACEMENT_SEEDS`).
- Replaced `'clustered placement: inter-cluster routing takes more hops'` with a real
  clustered-vs-uniform comparison (`avgHopsFor(placement?)` builds each sim, warms to t=5000,
  schedules 10 routes, drains to t=8000, returns `metrics.avgRoutingHops`; asserts
  `clustered > uniform`).
- `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC` is set to `10` as an UNVERIFIED PLACEHOLDER — never
  executed, not measured. Treat exactly like the original `/* MEASURE AND FILL IN */ 0` — this
  ticket update replaces the `10` back with the explicit placeholder marker so it can't be
  mistaken for a real number; see step 1 above.

**`churn-scenarios.spec.ts`** — DONE, confirmed, do not touch: import added, four lifted
definitions (`coordToBigInt`, `maxPeersInOneSpacingArc`, `PLACEMENT_SEEDS`,
`MAX_PEERS_IN_ONE_SPACING_ARC`) deleted, now resolve via the import. `PlacementCase` /
`placementReading` / `assertPlacementSeparates` untouched in place.

**`packages/fret/test/simulation/sim-metrics.ts`** (unchanged, confirmed complete in prior runs):
`recordRoute(success, hops)` pushes to `routingHops` always, to `successfulRouteHops` only on
success. `finalize()` sets `avgRoutingHops` = mean of all of `routingHops` (every attempt, success
or fail) — no precomputed average of `successfulRouteHops` exists; average `metrics.successfulRouteHops`
by hand if needed.

**`packages/fret/test/simulation/placement.ts`** (unchanged, confirmed in prior runs):
`export type PlacementStrategy = 'uniform' | 'clustered' | 'skewed' | 'clumped-joiners'`;
`export interface ClusterConfig { numClusters: number; spreadBits: number }`. Omitting `placement`
in a `SimConfig` defaults to `'uniform'`. A `'clustered'` sim REQUIRES both `placement: 'clustered'`
AND `clusterConfig`, or a later `centers!` throws.

**`packages/fret/test/simulation/fret-sim.ts`** (unchanged, confirmed in prior runs): `SimConfig`
takes `placement?: PlacementStrategy` and `clusterConfig?: ClusterConfig` as top-level sim fields,
consumed once at `FretSimulation` construction — no way to switch strategy mid-run, so each
comparison arm needs its own `new FretSimulation({...})`.

**`'skewed placement: some regions are denser than others'`** case — already correct, left
untouched (optional cosmetic `coordToBigInt` swap only, not required).

## Design rationale (for context only — decisions already made, don't reopen)

The `largestGap > medianGap` check that used to be in case 1 is an arithmetic identity for almost
any non-uniform spacing — proves nothing about clustering specifically. The `routingAttempts === 10`
check that used to be in case 2 only proves routes were attempted, and the sim never even set
`placement: 'clustered'`, so it silently ran uniform the whole time. `maxPeersInOneSpacingArc`
(already proven out in `churn-scenarios.spec.ts`) is the correct statistic: it directly measures
"how many peers pile into a small arc," which both clustering and clumped joining actually do and
uniform placement doesn't.

`clusterConfig` is inert on a non-`'clustered'` sim (`placement.ts`: `clusterCenters` only built
when `placement === 'clustered' && clusterConfig` supplied) — so it's fine to omit both
`placement` and `clusterConfig` together for the uniform arm of each comparison, rather than
passing `clusterConfig` alongside `'uniform'` placement and hoping it's ignored.

## TODO

- [x] Create `packages/fret/test/simulation/placement-assertions.ts` — DONE, confirmed on disk
- [x] Edit `churn-scenarios.spec.ts` (import + delete four lifted definitions) — DONE, confirmed
- [x] Edit `message-bus.spec.ts` (both vacuous cases replaced with both-directions snippets) —
      DONE, confirmed (import present at L7; case bodies per eleventh-run resume-note above)
- [ ] Measure and fill in `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC` (step 1 above)
- [ ] Resolve which hop statistic case 2 uses (step 2 above)
- [ ] Run `test/message-bus.spec.ts` + `test/churn-scenarios.spec.ts` together, confirm pass
      (step 3 above)
- [ ] Run `npx tsc --noEmit`, confirm clean (step 3 above)
- [ ] Write review/ handoff ticket, delete this implement/ ticket

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
