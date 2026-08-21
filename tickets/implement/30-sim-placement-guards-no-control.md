description: Three simulation tests claim to prove that different peer-layout strategies produce different ring shapes, but two of them would pass just as happily against the default layout, so they prove nothing; give them the same both-directions check a sibling test already uses.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/churn-scenarios.spec.ts, packages/fret/test/simulation/placement-assertions.ts (new), packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation/sim-metrics.ts
difficulty: easy
---

<!-- resume-note -->
EIGHTH run continues here. Sections 1 AND 2 are now DONE and confirmed:

- `packages/fret/test/simulation/placement-assertions.ts` exists (section 1, done several runs
  ago) exporting `coordToBigInt`, `maxPeersInOneSpacingArc`, `PLACEMENT_SEEDS`,
  `MAX_PEERS_IN_ONE_SPACING_ARC` — verbatim per "1." below. Do not touch.
- `packages/fret/test/churn-scenarios.spec.ts` (section 2, done THIS run): L3 now has
  `import { coordToBigInt, maxPeersInOneSpacingArc, PLACEMENT_SEEDS, MAX_PEERS_IN_ONE_SPACING_ARC } from './simulation/placement-assertions.js'`
  right after the existing L1–2 imports; the four lifted local definitions (old `coordToBigInt`,
  `maxPeersInOneSpacingArc`, `PLACEMENT_SEEDS`, the measured-table comment + `MAX_PEERS_IN_ONE_SPACING_ARC`)
  are deleted. `PlacementCase` interface survives untouched, now starting at L338. Confirmed by
  re-reading L325–354 after the edit: `interface PlacementCase { ... }` sits directly after the
  `describe` block's closing `})`, followed by `placementReading`. A transient TS2440 "Import
  declaration conflicts with local declaration" diagnostic appeared between the two edit calls
  (expected — it's a snapshot taken between deleting the import-adding edit and the
  local-decl-deleting edit landing) and is gone once both edits are applied; do not re-chase it,
  it is not a real conflict in the current file.

**Ninth run: go straight to section 3 (edit `message-bus.spec.ts`).** Do not re-read
`churn-scenarios.spec.ts` or `placement-assertions.ts` — both confirmed correct above. Section
3 needs a Read of `message-bus.spec.ts` first (required by the Edit tool anyway), then the two
`Edit` calls per "3." below, including the measure-run to fill in
`CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC` (this needs actually running the test file once with a
loose threshold — a real `node --import ./register.mjs ...mocha.js "test/message-bus.spec.ts"`
invocation, not a guess). Then the two verification commands at the bottom of the TODO list
(mocha run + tsc). If BUDGET_WARNING fires again before section 3's edits land, stop immediately
rather than starting the measure-run mid-budget — a half-applied edit plus an unrun measurement
is worse than leaving section 3 untouched for the next run.

Confirmed exact state as of this run (message-bus.spec.ts untouched across all runs so far):

- `packages/fret/test/message-bus.spec.ts`: imports at L1–6, including L6
  `import { FretSimulation } from './simulation/fret-sim.js'`. The `describe('Placement
  distributions', ...)` block starts L292 (`this.timeout(60000)` at L293). Three cases, exact
  current bodies:
  - L295–332 `'clustered placement: peers cluster around centers'` — builds one sim with
    `placement: 'clustered', clusterConfig: { numClusters: 3, spreadBits: 32 }` (n:30, k:15, m:8,
    churnRatePerSec:0, stabilizationIntervalMs:500, durationMs:5000), hand-rolls a coord→BigInt
    loop, sorts, takes gaps, asserts `largestGap > medianGap` — vacuous, true for almost any
    non-uniform spacing.
  - L334–370 `'clustered placement: inter-cluster routing takes more hops'` — builds
    `clusterSim` with **no `placement` field at all** (n:30, k:15, m:8, churnRatePerSec:0,
    stabilizationIntervalMs:500, durationMs:8000) despite the variable name, warms up to t=5000
    via `clusterSim.scheduler.advanceTo(5000)`, schedules 10 routes via a target-generation loop
    (`target[j] = (seed * (j + 1) * 37) & 0xff` where `seed = 42 + i * 13`), drains to t=8000,
    asserts only `metrics.routingAttempts === 10` — never reads a hop count, never sets
    `placement: 'clustered'`.
  - L372–405 `'skewed placement: some regions are denser than others'` — already correct, leave
    untouched (optional cosmetic swap only, see TODO).
- `packages/fret/test/simulation/sim-metrics.ts` (full file, confirmed complete in a prior run,
  unchanged): `recordRoute(success, hops)` pushes to `routingHops` always, to
  `successfulRouteHops` only on success. `finalize()` sets `avgRoutingHops` = mean of all of
  `routingHops` (every attempt, success or fail) — no precomputed average of
  `successfulRouteHops` exists; if you need that instead, average `metrics.successfulRouteHops`
  by hand.
- `packages/fret/test/simulation/placement.ts` (confirmed in a prior run, unchanged):
  `export type PlacementStrategy = 'uniform' | 'clustered' | 'skewed' | 'clumped-joiners'`;
  `export interface ClusterConfig { numClusters: number; spreadBits: number }`. Omitting
  `placement` in a `SimConfig` defaults to `'uniform'` (`opts.placement ?? 'uniform'`) — no need
  to pass the literal string. A `'clustered'` sim REQUIRES both `placement: 'clustered'` AND
  `clusterConfig`, or a later `centers!` throws.
- `packages/fret/test/simulation/fret-sim.ts` (confirmed in a prior run, unchanged): `SimConfig`
  takes `placement?: PlacementStrategy` and `clusterConfig?: ClusterConfig` as top-level sim
  fields, consumed once at `FretSimulation` construction — no way to switch strategy mid-run, so
  each comparison arm needs its own `new FretSimulation({...})`.

---

## Exact edits to make (in order)

### 1. New file: `packages/fret/test/simulation/placement-assertions.ts`

Lifted verbatim from `churn-scenarios.spec.ts` L337–394, each export unchanged, just adding
`export`:

```ts
/** Inverse of toCoord in test/helpers/ring.ts: 32-byte big-endian Uint8Array -> BigInt. */
export function coordToBigInt(coord: Uint8Array): bigint {
	let v = 0n
	for (let i = 0; i < 32; i++) {
		v = (v << 8n) | BigInt(coord[i]!)
	}
	return v
}

/**
 * How clumped a ring is: scan an arc one even-spacing wide (ringSize / peers) anchored at each
 * peer in turn, wrapping, and return the most peers any such arc contains.
 *
 * This replaced a largest-gap-over-even-spacing statistic, which was vacuous here: piling every
 * joiner into one sliver makes that sliver denser while the surviving evenly-placed initial
 * population still holds the largest hole down, so the number barely moves — and on the pure
 * batch-join case the buggy and fixed placements produced bit-identical readings.
 */
export function maxPeersInOneSpacingArc(coords: readonly bigint[]): number {
	const ringSize = 1n << 256n
	const sorted = [...coords].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
	if (sorted.length === 0) return 0
	const arcWidth = ringSize / BigInt(sorted.length)

	let worst = 0
	for (const anchor of sorted) {
		let inArc = 0
		for (const other of sorted) {
			const offset = (other - anchor + ringSize) % ringSize
			if (offset < arcWidth) inArc++
		}
		if (inArc > worst) worst = inArc
	}
	return worst
}

/** Seeds every placement reading below is taken over. */
export const PLACEMENT_SEEDS = [8008, 8009, 8010, 4242, 99]

/**
 * Peers-in-one-even-spacing-arc readings, over PLACEMENT_SEEDS at n=40 / k=15 / m=8 /
 * stabilize 500ms / 10s:
 *
 *   join pattern     uniform (fixed)   clumped-joiners (the bug)
 *   batch burst      3 3 3 3 3         11 11 11 11 11
 *   steady trickle   3 3 3 4 3         18 18 16 16 16
 *
 * Worst fixed reading 4, best buggy reading 11, nothing in between — so 7 sits 1.75x above
 * everything the fixed placement produced and 1.57x below everything the bug produced. Both
 * arms are asserted below, so the threshold's separating power is re-proved on every run
 * rather than measured once at authoring time.
 */
export const MAX_PEERS_IN_ONE_SPACING_ARC = 7
```

### 2. `churn-scenarios.spec.ts`

- Add import (after the existing L2 import):
  `import { coordToBigInt, maxPeersInOneSpacingArc, PLACEMENT_SEEDS, MAX_PEERS_IN_ONE_SPACING_ARC } from './simulation/placement-assertions.js'`
- Delete L337–371 (`coordToBigInt` + `maxPeersInOneSpacingArc` + their doc comments) — now
  imported.
- Keep `PlacementCase` interface (was L373–376) unchanged, in place.
- Delete the `PLACEMENT_SEEDS` const (was L378–379) and the measured-table comment +
  `MAX_PEERS_IN_ONE_SPACING_ARC` const (was L381–394) — now imported.
- Keep `placementReading` and `assertPlacementSeparates` (was L396–453) unchanged, in place —
  they already reference `maxPeersInOneSpacingArc`, `coordToBigInt`, `PLACEMENT_SEEDS`,
  `MAX_PEERS_IN_ONE_SPACING_ARC` by name, which now resolve via the new import instead of local
  definitions.

### 3. `message-bus.spec.ts`

Add import near the top (after the existing `FretSimulation` import at L6):
`import { coordToBigInt, maxPeersInOneSpacingArc, PLACEMENT_SEEDS } from './simulation/placement-assertions.js'`

(Deliberately NOT importing `MAX_PEERS_IN_ONE_SPACING_ARC` — that constant was measured for the
churn file's n=40/k=15/m=8 config; this file's cases run n=30, a different population, and need
their own freshly-measured threshold(s). Reusing the churn threshold on a different population
size is exactly the "measured once, trusted everywhere" mistake this ticket is about.)

**Replace the `'clustered placement: peers cluster around centers'` case (current L295–332)**
with a both-directions check, following `assertPlacementSeparates`'s shape:

```ts
it('clustered placement: peers cluster around centers', () => {
	function reading(placement?: 'clustered', seed = 42): number {
		const sim = new FretSimulation({
			seed,
			n: 30,
			k: 15,
			m: 8,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 5000,
			...(placement
				? { placement, clusterConfig: { numClusters: 3, spreadBits: 32 } }
				: {}),
		})
		sim.initialize()
		while (sim.scheduler.pending() > 0) {
			const evt = sim.scheduler.nextEvent()
			if (!evt || evt.time > 5000) break
			sim.processEvent(evt)
		}
		const alive = Array.from(sim.getPeers().values()).filter((p) => p.alive)
		return maxPeersInOneSpacingArc(alive.map((p) => coordToBigInt(p.coord)))
	}

	// MEASURE FIRST: run this loop with the threshold below set very loose (e.g. 0), capture the
	// printed uniform/clustered readings across PLACEMENT_SEEDS, then pick a threshold strictly
	// between the worst uniform reading and the best clustered reading, with margin — same method
	// as MAX_PEERS_IN_ONE_SPACING_ARC in placement-assertions.ts. Replace this comment with the
	// measured table once done (see that file's doc comment for the format to copy).
	const CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC = /* MEASURE AND FILL IN */ 0

	for (const seed of PLACEMENT_SEEDS) {
		const clustered = reading('clustered', seed)
		const uniform = reading(undefined, seed)
		console.log(
			`  clustered vs uniform seed ${seed}: clustered ${clustered}, uniform ${uniform}` +
				` (threshold ${CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC})`
		)
		expect(uniform).to.be.at.most(CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC)
		expect(clustered).to.be.greaterThan(CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC)
	}
})
```

**Replace the `'clustered placement: inter-cluster routing takes more hops'` case (current
L334–370)** with a real clustered-vs-uniform comparison:

```ts
it('clustered placement: inter-cluster routing takes more hops', () => {
	function avgHopsFor(placement?: 'clustered'): number {
		const sim = new FretSimulation({
			seed: 42,
			n: 30,
			k: 15,
			m: 8,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 8000,
			...(placement
				? { placement, clusterConfig: { numClusters: 3, spreadBits: 32 } }
				: {}),
		})
		sim.initialize()

		for (const evt of sim.scheduler.advanceTo(5000)) {
			sim.processEvent(evt)
		}

		const alivePeers = Array.from(sim.getPeers().values()).filter((p) => p.alive)
		for (let i = 0; i < 10; i++) {
			const from = alivePeers[i % alivePeers.length]!
			const target = new Uint8Array(32)
			const seed = 42 + i * 13
			for (let j = 0; j < 32; j++) target[j] = (seed * (j + 1) * 37) & 0xff
			sim.scheduleRoute(from.id, target, 5001 + i)
		}

		while (sim.scheduler.pending() > 0) {
			const evt = sim.scheduler.nextEvent()
			if (!evt || evt.time > 8000) break
			sim.processEvent(evt)
		}

		const metrics = sim.metrics.finalize()
		expect(metrics.routingAttempts).to.equal(10)
		console.log(
			`  ${placement ?? 'uniform'}: avgRoutingHops ${metrics.avgRoutingHops}, ` +
				`successfulRouteHops avg ` +
				`${metrics.successfulRouteHops.length > 0 ? metrics.successfulRouteHops.reduce((a, b) => a + b, 0) / metrics.successfulRouteHops.length : 'n/a'}`
		)
		return metrics.avgRoutingHops
	}

	const clustered = avgHopsFor('clustered')
	const uniform = avgHopsFor()
	expect(clustered).to.be.greaterThan(uniform)
})
```

**Before finalizing**: run this case once, read the logged `avgRoutingHops` vs
`successfulRouteHops`-avg for both arms. If `avgRoutingHops` (all attempts) separates clustered
from uniform cleanly, keep the `expect` as written above and delete the unused
`successfulRouteHops` half of the console.log (or keep it — harmless either way). If
`avgRoutingHops` is noisy/doesn't separate but the `successfulRouteHops` average does, switch the
function to return that average instead, and add a one-line comment (mirroring the
`successfulRouteHops` doc-comment in `sim-metrics.ts`) saying why. If targets from the existing
generation loop don't land across cluster boundaries under the clustered layout (i.e. clustered
hops ≈ uniform hops, no separation either way), the target generation needs to change — e.g. seed
targets so they land near cluster gaps — before this case can be trusted; don't ship it
unseparating.

### 4. `'skewed placement: some regions are denser than others'` (message-bus.spec.ts, current
L372–405)

Leave assertion logic untouched. Optional-only: swap its inline `val = (val << 8n) |
BigInt(peer.coord[i]!)` loop (L387–393) for the imported `coordToBigInt`. Skip if it adds noise;
not required for this ticket to be done.

## Design rationale (for context only — decisions above are final, don't reopen)

The `largestGap > medianGap` check is an arithmetic identity for almost any non-uniform spacing —
it proves nothing about clustering specifically. The `routingAttempts === 10` check only proves
routes were attempted, and the sim never even set `placement: 'clustered'`, so it silently ran
uniform the whole time. `maxPeersInOneSpacingArc` (already proven out in `churn-scenarios.spec.ts`)
is the correct statistic: it directly measures "how many peers pile into a small arc," which both
clustering and clumped joining actually do and uniform placement doesn't.

`clusterConfig` is inert on a non-`'clustered'` sim (see `placement.ts`: `clusterCenters` is only
built when `placement === 'clustered' && clusterConfig` is supplied) — so it's fine to simply omit
both `placement` and `clusterConfig` together for the "default/uniform" arm of each comparison,
which is what the snippets above do, rather than relying on passing `clusterConfig` alongside a
`'uniform'` placement and hoping it's ignored.

## TODO

- [x] Create `packages/fret/test/simulation/placement-assertions.ts` — DONE, confirmed written
      this run, verbatim match to "1." above
- [x] Edit `churn-scenarios.spec.ts` per "2." above (add import, delete the four lifted
      definitions, keep `PlacementCase`/`placementReading`/`assertPlacementSeparates`) — DONE,
      confirmed via re-read after edit
- [ ] Edit `message-bus.spec.ts` per "3." above — replace both vacuous cases with the snippets
      given; run once with a loose/zero threshold in case 1 to capture real readings across
      `PLACEMENT_SEEDS`, then fill in `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC` with a real
      measured-and-commented threshold (same table format as `placement-assertions.ts`'s
      `MAX_PEERS_IN_ONE_SPACING_ARC` doc comment)
- [ ] For case 2 (`inter-cluster routing takes more hops`), run once, compare the two candidate
      statistics (`avgRoutingHops` vs `successfulRouteHops` average) per the guidance above, pick
      whichever separates cleanly, note which and why in a one-line comment
- [ ] Leave `skewed placement` case behavior unchanged (cosmetic `coordToBigInt` swap optional)
- [ ] Run `cd packages/fret && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" "test/churn-scenarios.spec.ts" --timeout 60000` — confirm all cases pass, finish in reasonable wall time (well inside the existing 60s `this.timeout`)
- [ ] Run `cd packages/fret && npx tsc --noEmit` — confirm no type errors from the new shared module or the edited spec files

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
