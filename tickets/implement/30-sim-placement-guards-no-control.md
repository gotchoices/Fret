description: A simulation test claims that grouping peers into clusters makes message routing take more steps, but it would pass whether or not that were true; the measurement needed to fix or delete it has now been shown to be affordable, and a first run of it produced multi-hop routes for the first time.
files: packages/fret/test/message-bus.spec.ts, packages/fret/test/simulation/placement-assertions.ts, packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation.routing.spec.ts, docs/fret.md
difficulty: medium
tradeoffs: n/a (implement ticket)
---

Thirteenth run. **No source edits landed this run.** What landed is the measurement: Finding C
(the twelfth run's blocker) is **resolved**, and one sim was timed and produced the first
multi-hop reading this ticket has ever seen. Findings A and B are carried forward unchanged and
are still correct; do not re-derive them.

Stopped on a `BUDGET_WARNING` immediately after that timing run, before the sweep. The sweep is
the only thing left before the test can be written or deleted.

## Finding C is resolved — the cost was never the population, it was the drain

The twelfth run's sweep drained the scheduler to `durationMs` (30000 ms), i.e. 60 stabilization
ticks over 300 peers. `test/simulation.routing.spec.ts` **never does that**. Its `durationMs:
60000` is a config field that is never simulated: `measureRouting` pumps only to `CONVERGE_MS`
(4000 ms), fires its routes at 4010..4110, and pumps to 4110. Its doc-block records why 4000 is
enough — store contents measured flat from t=2000 through t=20000 at a 500 ms tick.

Its pump, which the sweep script below now uses:

```ts
function pump(sim: FretSimulation, uptoMs: number): void {
	while ((sim.scheduler.peek()?.time ?? Infinity) <= uptoMs) {
		sim.processEvent(sim.scheduler.nextEvent()!)
	}
	sim.scheduler.advanceTo(uptoMs)
}
```

With that change, one timed sim at `n: 300, k: 15, m: 8, capacity: 32,
stabilizationIntervalMs: 500, clustered, clusterConfig: { numClusters: 3, spreadBits: 32 }`,
converging to 4000 ms and firing 10 routes between real cluster centers via `nearestAlivePeerTo`:

```
one sim: centers 8ms, run 11856ms { hops: 4.9, ok: 10, attempts: 10, storeSize: 32 }
```

**~12 s per sim.** Against a 10-minute ceiling that is ~50 sims, so the eleventh run's 40-sim
sweep now fits — but see the trimming note below, because most of it is no longer worth buying.

## What that one run already tells you — read before sweeping

- **`storeSize: 32`.** The bound bit. Finding B's floor (`2m + 1` = 17) is cleared and the store
  is genuinely capped, which is the regime the whole test needed to reach.
- **`hops: 4.9` with 10/10 successes.** Finding A's "every route is one hop" is gone. There is a
  real multi-hop measurement to compare arms with.
- The `uniform` control arm was **not** run — that was a single-sim timing probe, not a triple.
  So there is no separation number yet, only proof that the clustered arm is no longer pinned at
  1.0 and therefore *can* separate.

## What to do next — sweep, trimmed

Write the script below back to `test/simulation/seed-check.tmp.ts` (relative imports work from
there), run from `packages/fret/`, and **delete it before handoff**. It is the twelfth run's
script with the pump fix and env-var variant selection already in it.

Start with the configuration already known to produce multi-hop routes, all five seeds, both
arms — 10 sims, roughly 2 minutes:

```
SWEEP_SPREADS=32 SWEEP_CAPS=32 node --import ./register.mjs test/simulation/seed-check.tmp.ts
```

Only if that does not separate cleanly, spend more:

- `SWEEP_SPREADS=224` next (widening the clusters is the eleventh run's stated "legitimate thing
  to try" — mind the ~52-bit precision caveat below).
- `SWEEP_CAPS=none` on a **single** seed last, as a sanity control showing the bound is what
  produced the multi-hop regime. Not worth five seeds.

Budget against 10 minutes at ~12 s per sim (~50 sims). Do not run all four combinations at five
seeds without reason — that is 40 sims and most of it buys nothing once the first block
separates.

## The sweep script, verbatim (pump fix included)

```ts
import { FretSimulation, type SimConfig } from './fret-sim.js'
import { PLACEMENT_SEEDS, nearestAlivePeerTo } from './placement-assertions.js'
import { toCoord } from '../helpers/ring.js'

const N = Number(process.env.SWEEP_N ?? 300)
const NUM_CLUSTERS = 3
const CONVERGE_MS = 4000
const ROUTES = 10

/** Drive every event scheduled up to `uptoMs`, then park the clock there. (routing spec's pump) */
function pump(sim: FretSimulation, uptoMs: number): void {
	while ((sim.scheduler.peek()?.time ?? Infinity) <= uptoMs) {
		sim.processEvent(sim.scheduler.nextEvent()!)
	}
	sim.scheduler.advanceTo(uptoMs)
}

function baseCfg(
	seed: number,
	placement: 'uniform' | 'clustered',
	spreadBits: number,
	capacity?: number,
): SimConfig {
	return {
		seed, n: N, k: 15, m: 8,
		churnRatePerSec: 0,
		stabilizationIntervalMs: 500,
		durationMs: 60000,
		placement,
		clusterConfig: { numClusters: NUM_CLUSTERS, spreadBits },
		capacity,
	}
}

function measure(cfg: SimConfig, centers: readonly bigint[]) {
	const sim = new FretSimulation(cfg)
	sim.initialize()
	pump(sim, CONVERGE_MS)
	const peers = Array.from(sim.getPeers().values()).filter((p) => p.alive)
	let firstSender: string | undefined
	for (let i = 0; i < ROUTES; i++) {
		const a = centers[i % centers.length]!
		const b = centers[(i + 1) % centers.length]!
		const from = nearestAlivePeerTo(peers, a)!
		firstSender ??= from
		sim.scheduleRoute(from, toCoord(b), CONVERGE_MS + 10 + i)
	}
	pump(sim, CONVERGE_MS + 10 + ROUTES)
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

if (process.env.SWEEP_ONE) {
	const t0 = Date.now()
	const centers = centersFor(8008, 32)
	const tc = Date.now()
	const r = measure(baseCfg(8008, 'clustered', 32, 32), centers)
	console.log(`one sim: centers ${tc - t0}ms, run ${Date.now() - tc}ms`, r)
	process.exit(0)
}

console.log(`n=${N} numClusters=${NUM_CLUSTERS} converge=${CONVERGE_MS}ms`)
console.log('spread cap    seed  clustered(hops/ok/store)  uniform(hops/ok/store)')
const SPREADS = (process.env.SWEEP_SPREADS ?? '32,224').split(',').map(Number)
const CAPS = (process.env.SWEEP_CAPS ?? '32,none')
	.split(',')
	.map((s) => (s === 'none' ? undefined : Number(s)))
const SEEDS = process.env.SWEEP_SEEDS
	? process.env.SWEEP_SEEDS.split(',').map(Number)
	: PLACEMENT_SEEDS
for (const spreadBits of SPREADS) {
	for (const capacity of CAPS) {
		for (const seed of SEEDS) {
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

## Finding A (confirmed at the code site): why the old test measured one hop

The old second test measured 0.9-1.0 average hops in *both* arms on *every* seed with 10/10
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

So the root cause is the unbounded store, and aiming targets at real cluster centers is necessary
but not sufficient. The `storeSize: 32` / `hops: 4.9` reading above is this finding being cleared.

## Finding B: a store bound is unreachable at n=30 — that is why n is raised

`FretSimulation.enforceCapacity` (`test/simulation/fret-sim.ts` L701-721) mirrors production:
eviction skips a protection set, and **protection outranks the cap** — with `capacity < 2m + 1`
the evictable set runs out and the store simply stays over capacity. At m = 8 that floor is 17.
Any capacity that is a "small fraction" of n = 30 (about 3-4) is far below 17, so setting it
changes nothing: `store.size()` stays at the full population and the test still measures one hop.

Consequence: the second test needs its own, larger `n` — it does not have to share n=30 with the
first test. `capacity: 32` is comfortably above the 2m+1 = 17 floor, and at `n: 300` it is ~10.7%
of the population.

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
  `MAX_PEERS_IN_ONE_SPACING_ARC = 7`. `nearestAlivePeerTo` landed in the twelfth run and is
  committed; nothing consumes it yet.
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

Members: `sim.initialize()`, `sim.scheduler.peek()`, `sim.scheduler.nextEvent()`,
`sim.scheduler.advanceTo(ms)` (generator of events), `sim.scheduler.pending()`,
`sim.processEvent(evt)`, `sim.scheduleRoute(fromPeerId: string, targetCoord: Uint8Array, atMs: number)`,
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
store at roughly 3% of population is a **known-good multi-hop configuration**.

## What the fixed test needs

All three together — any one alone still measures nothing:

- **Bound the store, which means raising `n`** (Finding B). Report `store.size()` for one sender
  per run; it is the number that says at a glance whether the bound actually bit.
- **Aim targets at real clusters**, using `sim.getClusterCenters()`. Keep it symmetric so the
  `uniform` arm is a genuine control: take the centers from the `clustered` run once, then for
  `i` in 0..9 use `A = centers[i % numClusters]`, `B = centers[(i + 1) % numClusters]`, and in
  **both** arms route from `nearestAlivePeerTo(peers, A)` to coordinate `B`. Same two
  coordinates in both runs, same selection rule, so the only difference is where the placement
  put the peers.
- **Converge with the routing spec's pump, not a drain to `durationMs`** — that is what made the
  measurement affordable, and a mocha test that drains 60 s of ticks over 300 peers will time out
  exactly as the twelfth run's sweep did.

## The outcome that is allowed to be "no"

With `clusterConfig: { numClusters: 3, spreadBits: 32 }` the spread is 2^32 against a 2^256 ring
— about 1 part in 10^67. Three clusters are, for routing purposes, three *points*, and a ring
made of three points may simply not produce longer paths than a uniform one however the store is
bounded, because there is nothing between the clusters to route through. Widening `spreadBits`
(say 200-240 — mind the ~52-bit precision note) is a legitimate thing to try before concluding.

If, after the sweep, the two arms still do not separate cleanly across all five `PLACEMENT_SEEDS`,
the honest resolution is to **delete the second test**, not to loosen it. It currently asserts
`clustered > uniform` with no margin on a single hardcoded seed and would pass on noise; a
deleted vacuous test is strictly better than a retained one. The first test already covers
clustered placement's real, measured effect. Deleting is a result to report plainly in the
handoff, with the numbers behind it — not a failure.

The twelfth run's third permitted outcome — "delete it because the measurement is unaffordable" —
is **withdrawn**. It is affordable: ~12 s per sim.

TODO:
- Run the trimmed sweep (`SWEEP_SPREADS=32 SWEEP_CAPS=32`, all five seeds, ~2 min); record the
  table. Widen only if it does not separate.
- If it separates: rewrite `test/message-bus.spec.ts` L347-395 to use `nearestAlivePeerTo`, the
  raised `n`, the store bound and the pump-to-converge pattern; assert both `clustered > uniform`
  **and** a measured numeric margin over all 5 `PLACEMENT_SEEDS`, with the measured table in a
  comment — mirroring the `CLUSTERED_MAX_PEERS_IN_ONE_SPACING_ARC` pattern the first test uses.
  Mind the mocha timeout: 10 sims at ~12 s is ~2 min, so raise `this.timeout` on that describe
  block (currently 60000) or cut the seed count and say which in the comment.
- If it does not separate: delete that test, and delete `nearestAlivePeerTo`,
  `CoordPlacement.centers` and `FretSimulation.getClusterCenters()` if nothing else consumes
  them. All are committed, so that is a real edit to three files.
- Delete the scratch script either way.
- Gate, both from `packages/fret/`:
  ```
  node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/message-bus.spec.ts" "test/churn-scenarios.spec.ts" --timeout 300000
  npx tsc --noEmit
  ```
- Write the `review/` ticket (slug `sim-placement-guards-no-control`): the first test's measured
  threshold, what happened to the second test (fixed with numbers, or deleted with the numbers
  that justified deleting), and Findings A, B and C so the reviewer understands why the earlier
  target-generation and small-capacity plans were abandoned and why the twelfth run's sweep timed
  out. Delete this file once the review ticket is written.

## Hygiene

The working tree at handoff should hold whatever this ticket's work changes and nothing else. No
scratch files, no logs. `test/simulation/placement.ts` and `test/simulation/fret-sim.ts` are clean
at HEAD — if they show as modified at your handoff, that is your own edit.
