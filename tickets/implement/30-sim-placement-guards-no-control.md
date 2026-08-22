description: A simulation test claims that grouping peers into clusters makes message routing take more steps, but it would pass whether or not that were true; the measurement needed to fix or delete it has now been shown to be too slow to run at the size previously proposed.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/simulation/placement-assertions.ts, packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation.routing.spec.ts, docs/fret.md
difficulty: medium
tradeoffs: n/a (implement ticket)
---

Twelfth run. **One real edit landed this run** (see below) and the sweep script was written and
run — it timed out, which is the new finding. Everything under the "Finding A" and "Finding B"
headings is carried forward unchanged and is still correct; do not re-derive it.

## What landed this run — do not redo

`nearestAlivePeerTo` is now exported from `test/simulation/placement-assertions.ts` (appended at
the end of the file, beside `maxPeersInOneSpacingArc`). Signature as the eleventh run specified;
ring distance `min(cw, ccw)` over 2^256, lexicographic id tie-break. `npx tsc --noEmit` passes
with it. It is an **uncommitted working-tree edit** — the runner commits it with this ticket, so
by the time you read this it should be at HEAD. Nothing consumes it yet.

The scratch sweep script was written, run, and deleted. Its contents are reproduced verbatim
below so you do not have to re-derive it.

## Finding C (new, and it is the blocker): the sweep as specified is not agent-runnable

At `n: 300, k: 15, m: 8, stabilizationIntervalMs: 500, durationMs: 30000`, **one**
(draw-centers + clustered run + uniform run) triple did not complete in 115 seconds — the run
was killed at the 2-minute tool timeout having printed only its header line. The eleventh run's
plan was 5 seeds x 2 placements x 2 capacities x 2 spreads, i.e. 40 sims plus 10 center draws.
At the observed rate that is well over an hour, so it cannot be run inside a ticket at all.

**First thing to do next run — this is cheap and probably resolves it.** Read the `SimConfig`
literals in `test/simulation.routing.spec.ts`. That spec already runs a **1000**-peer case
inside a mocha timeout, so whatever `durationMs` / `stabilizationIntervalMs` it uses is known to
be affordable at more than 3x the population used above. The 30000 ms / 500 ms pair used this
run was invented here, not copied from that spec, and 30000/500 = 60 stabilize ticks x 300 peers
of gossip merging is the obvious suspect. Copy the routing spec's numbers rather than guessing
new ones.

Then **time exactly one sim** — not a triple, not a sweep — and only widen once you know the
per-sim cost. Budget the sweep against a 10-minute ceiling: at cost `c` seconds per sim, you can
afford roughly `600/c` sims. If that is fewer than 40, cut variants in this order (cheapest
information lost first): drop the `capacity: undefined` sanity control to a single seed, then
drop one `spreadBits` value, then reduce to 3 seeds for exploration and re-run all 5 only for
the configuration you intend to ship.

## Finding A (confirmed at the code site): every route is one hop, and why

The second test measured 0.9-1.0 average hops in *both* arms on *every* seed with 10/10
successes. Not "the targets landed in the wrong place" — "there is nowhere to route to".

`FretSimulation.handleRoute` (`test/simulation/fret-sim.ts` L785-793) declares a route successful
the moment the peer holding the message is the target coordinate's **anchor in its own store**
(`neighborsRight(target, 1)` / `neighborsLeft(target, 1)`). At n=30 with `capacity` unset, 5 s of
stabilization leaves every peer holding every other peer, so the originator's own store already
names the globally-nearest peer to any target: it delivers in one hop and that peer is the
anchor. No target-generation scheme can produce a multi-hop route against a store that already
contains the destination's neighbours. This matches `docs/fret.md` under *Testing strategy*
("unbounded stores plus a per-tick gossip merge ... arrive in one or two hops under any
roughly-monotone metric").

So the root cause is the unbounded store, and aiming targets at real cluster centers is
necessary but not sufficient.

## Finding B: a store bound is unreachable at n=30 — you must raise n

`FretSimulation.enforceCapacity` (`test/simulation/fret-sim.ts` L701-721) mirrors production:
eviction skips a protection set, and **protection outranks the cap** — with `capacity < 2m + 1`
the evictable set runs out and the store simply stays over capacity. At m = 8 that floor is 17.
Any capacity that is a "small fraction" of n = 30 (about 3-4) is far below 17, so setting it
changes nothing: `store.size()` stays at the full population and the test still measures one hop.

Consequence: the second test needs its own, larger `n` — it does not have to share n=30 with the
first test. `capacity: 32` is comfortably above the 2m+1 = 17 floor.

Note the interaction already recorded at `nearRadiusFor` (`fret-sim.ts` ~L860): the near radius is
`4k/store.size()` of maximum ring distance, so at k=15 and a 32-entry store the fraction is
60/32 > 1 and clamps to half the ring, putting every candidate in the selector's *near* branch.
Fine for a hop-count measure, but it means the test discriminates the distance metric and the
placement, not the cost function's slack constants — say so in the test comment rather than
letting a future reader over-claim.

## What is already done — do not touch, do not re-measure

- **Step 1 (the first placement test) is finished.** `test/message-bus.spec.ts` L296-345,
  `clustered placement: peers cluster around centers`: threshold
  `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC = 5`, measured table in a comment, both directions
  asserted over `PLACEMENT_SEEDS`. Correct as it stands.
- **`test/churn-scenarios.spec.ts` is finished** (L3 imports `MAX_PEERS_IN_ONE_SPACING_ARC`,
  L369-395 asserts both arms).
- **`test/simulation/placement-assertions.ts` is finished** — exports `coordToBigInt`,
  `maxPeersInOneSpacingArc`, `nearestAlivePeerTo`, `PLACEMENT_SEEDS = [8008, 8009, 8010, 4242, 99]`,
  `MAX_PEERS_IN_ONE_SPACING_ARC = 7`.
- **`CoordPlacement.centers` and `FretSimulation.getClusterCenters()` exist and are committed.**
  Nothing consumes them yet.

The only outstanding work is the **second** test, `clustered placement: inter-cluster routing
takes more hops` (`test/message-bus.spec.ts` L347-395).

## Harness API — transcribed, so you do not have to go looking

`SimConfig` (`test/simulation/fret-sim.ts` L65-89), the fields this ticket needs:

```ts
{ seed, n, k, m, churnRatePerSec, stabilizationIntervalMs, durationMs,
  placement?: 'uniform' | 'clustered' | 'skewed' | 'clumped-joiners',
  clusterConfig?: { numClusters: number; spreadBits: number },
  capacity?: number,            // max store entries per peer; unset = unbounded
  deadAfterFailures?, deadReprobePerTick?, messageBus?, profileMix? }
```

Members: `sim.initialize()`, `sim.scheduler.advanceTo(ms)` (generator of events),
`sim.processEvent(evt)`, `sim.scheduler.pending()`, `sim.scheduler.nextEvent()`,
`sim.scheduleRoute(fromPeerId: string, targetCoord: Uint8Array, atMs: number)`,
`sim.getPeers(): ReadonlyMap<string, SimPeer>` (`SimPeer` carries `id`, `coord: Uint8Array`,
`alive: boolean`), `sim.getStores(): ReadonlyMap<string, DigitreeStore>`,
`sim.getClusterCenters(): readonly bigint[] | undefined`, `sim.aliveCount()`,
`sim.metrics.finalize()` -> `.routingAttempts`, `.avgRoutingHops`, `.successfulRouteHops[]`.

Coordinate helpers: `toCoord(v: bigint): Uint8Array` from `test/helpers/ring.js`;
`coordToBigInt` and `nearestAlivePeerTo` from `test/simulation/placement-assertions.js`.

`spreadBits` caveat, already recorded at `CoordPlacement.clusteredCoord`: the Gaussian offset is
scaled through a JS float, so it is exact only to ~52 bits. A `spreadBits` of ~224 still wraps
correctly but loses low-bit precision — fine for this measurement (cluster *width* is what
matters), but say so in any comment you ship, and do not raise `spreadBits` past 52 in the
shipped test without first moving that scaling into BigInt.

## Reference numbers from `simulation.routing.spec.ts` (already measured — do not re-run)

That spec's doc-block records, at `n: 1000`, all-edge, 100 routes, seed 4242, shipped
`minDistance`:

| capacity | knowledge per peer | success | p90 hops |
|---|---|---|---|
| 24 | 2.4% | 99% | 14 |
| 28 | 2.8% | 100% | 11 |
| 32 | 3.2% | 100% | 8 |

Confirmed across seeds 1 / 4242 / 99 / 20260820 at cap 32: 100% success, p90 7-8. So a bounded
store at roughly 3% of population is a **known-good multi-hop configuration** — that is the
regime the second test has to reach.

## What the fixed test needs

Both arms together — either alone still measures nothing:

- **Bound the store, which means raising `n`** (Finding B). Report `store.size()` for one sender
  per run; it is the number that says at a glance whether the bound actually bit.
- **Aim targets at real clusters**, using `sim.getClusterCenters()`. Keep it symmetric so the
  `uniform` arm is a genuine control: take the centers from the `clustered` run once, then for
  `i` in 0..9 use `A = centers[i % numClusters]`, `B = centers[(i + 1) % numClusters]`, and in
  **both** arms route from `nearestAlivePeerTo(peers, A)` to coordinate `B`. Same two
  coordinates in both runs, same selection rule, so the only difference is where the placement
  put the peers.

## The outcome that is allowed to be "no"

With `clusterConfig: { numClusters: 3, spreadBits: 32 }` the spread is 2^32 against a 2^256 ring
— about 1 part in 10^67. Three clusters are, for routing purposes, three *points*, and a ring
made of three points may simply not produce longer paths than a uniform one however the store is
bounded, because there is nothing between the clusters to route through. Widening `spreadBits`
(say 200-240 — mind the ~52-bit precision note) is a legitimate thing to try before concluding.

If, after raising `n`, bounding `capacity`, aiming at real centers **and** trying a wider spread,
the two arms still do not separate cleanly across all five `PLACEMENT_SEEDS`, the honest
resolution is to **delete the second test**, not to loosen it. It currently asserts
`clustered > uniform` with no margin on a single hardcoded seed and would pass on noise; a
deleted vacuous test is strictly better than a retained one. The first test already covers
clustered placement's real, measured effect. Deleting is a result to report plainly in the
handoff, with the numbers behind it — not a failure.

**A third permitted outcome, given Finding C:** if the measurement cannot be made affordable
(one sim still costs minutes after copying the routing spec's parameters), delete the second
test on *that* basis and say so. A test whose claim cannot be measured within a tractable budget
is not one to keep asserting on a hardcoded seed.

## The sweep script, verbatim

Write it back to `test/simulation/seed-check.tmp.ts` (relative imports work from there), run with
`node --import ./register.mjs test/simulation/seed-check.tmp.ts` from `packages/fret/`, and
**delete it before handoff** — `git status` on that directory must be clean. Adjust `N`,
`durationMs`, `stabilizationIntervalMs` and the variant loops per Finding C before running it.

```ts
import { FretSimulation, type SimConfig } from './fret-sim.js'
import { PLACEMENT_SEEDS, nearestAlivePeerTo } from './placement-assertions.js'
import { toCoord } from '../helpers/ring.js'

const N = Number(process.env.SWEEP_N ?? 300)
const NUM_CLUSTERS = 3

function baseCfg(seed: number, placement: 'uniform' | 'clustered', spreadBits: number, capacity?: number): SimConfig {
	return {
		seed, n: N, k: 15, m: 8,
		churnRatePerSec: 0,
		stabilizationIntervalMs: 500,   // <- suspect; copy simulation.routing.spec.ts instead
		durationMs: 30000,              // <- suspect; copy simulation.routing.spec.ts instead
		placement,
		clusterConfig: { numClusters: NUM_CLUSTERS, spreadBits },
		capacity,
	}
}

function measure(cfg: SimConfig, centers: readonly bigint[]) {
	const sim = new FretSimulation(cfg)
	sim.initialize()
	for (const evt of sim.scheduler.advanceTo(5000)) sim.processEvent(evt)
	const peers = Array.from(sim.getPeers().values()).filter((p) => p.alive)
	let firstSender: string | undefined
	for (let i = 0; i < 10; i++) {
		const a = centers[i % centers.length]!
		const b = centers[(i + 1) % centers.length]!
		const from = nearestAlivePeerTo(peers, a)!
		firstSender ??= from
		sim.scheduleRoute(from, toCoord(b), 5001 + i)
	}
	while (sim.scheduler.pending() > 0) {
		const evt = sim.scheduler.nextEvent()
		if (!evt || evt.time > cfg.durationMs) break
		sim.processEvent(evt)
	}
	const m = sim.metrics.finalize()
	return {
		hops: m.avgRoutingHops,
		ok: m.successfulRouteHops.length,
		attempts: m.routingAttempts,
		storeSize: sim.getStores().get(firstSender!)?.size() ?? -1,
	}
}

function centersFor(seed: number, spreadBits: number): readonly bigint[] {
	const sim = new FretSimulation(baseCfg(seed, 'clustered', spreadBits))
	sim.initialize()
	const c = sim.getClusterCenters()
	if (!c) throw new Error('no centers')
	return c
}

console.log(`n=${N} numClusters=${NUM_CLUSTERS}`)
console.log('spread cap    seed  clustered(hops/ok/store)  uniform(hops/ok/store)')
for (const spreadBits of [32, 224]) {
	for (const capacity of [32, undefined]) {
		for (const seed of PLACEMENT_SEEDS) {
			const t0 = Date.now()
			const centers = centersFor(seed, spreadBits)
			const cl = measure(baseCfg(seed, 'clustered', spreadBits, capacity), centers)
			const un = measure(baseCfg(seed, 'uniform', spreadBits, capacity), centers)
			const capLabel = capacity === undefined ? 'none' : String(capacity)
			console.log(
				`${String(spreadBits).padStart(6)} ${capLabel.padStart(4)} ${String(seed).padStart(5)}  ` +
					`${cl.hops.toFixed(2)}/${cl.ok}/${cl.storeSize}`.padEnd(25) +
					` ${un.hops.toFixed(2)}/${un.ok}/${un.storeSize}`.padEnd(24) +
					` (${Date.now() - t0}ms)`,
			)
		}
	}
}
```

Drawing `centers` once from a `clustered` run per (seed, spreadBits) and reusing them for that
seed's `uniform` arm is what makes the control a control. Ship a numeric margin only if
separation is clean and consistent across all five seeds; 1-vs-0.9 is noise.

TODO:
- Read the `SimConfig` literals in `test/simulation.routing.spec.ts` and adopt its
  `durationMs` / `stabilizationIntervalMs`. Time **one** sim before sweeping anything.
- Run the sweep, trimmed to fit a 10-minute ceiling per Finding C; record the table.
- If it separates: rewrite `test/message-bus.spec.ts` L347-395 to use `nearestAlivePeerTo` plus
  the raised `n` and the store bound, assert both `clustered > uniform` **and** a measured
  numeric margin over all 5 `PLACEMENT_SEEDS`, with the measured table in a comment — mirroring
  the `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC` pattern the first test already uses.
- If it does not separate (or cannot be measured affordably): delete that test, and delete
  `nearestAlivePeerTo`, `CoordPlacement.centers` and `FretSimulation.getClusterCenters()` if
  nothing else consumes them. All are committed, so that is a real edit to three files.
- Delete the scratch script either way.
- Gate, both from `packages/fret/`:
  ```
  node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" "test/churn-scenarios.spec.ts" --timeout 60000
  npx tsc --noEmit
  ```
- Write the `review/` ticket (slug `sim-placement-guards-no-control`): the first test's measured
  threshold, what happened to the second test (fixed with numbers, or deleted with the numbers
  that justified deleting), and Findings A, B and C so the reviewer understands why the earlier
  target-generation and small-capacity plans were abandoned and why the sweep was trimmed.
  Delete this file once the review ticket is written.

## Hygiene

The working tree at handoff should hold whatever this ticket's work changes and nothing else. No
scratch files, no logs. `test/simulation/placement.ts` and `test/simulation/fret-sim.ts` are
clean at HEAD — if they show as modified at your handoff, that is your own edit.
