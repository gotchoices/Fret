---
description: Sweep the simulated network's per-peer memory limit to find the smallest one that makes test routes take several hops instead of landing immediately, so a follow-up test has a number to use.
files: packages/fret/test/simulation/fret-sim.ts, packages/fret/test/simulation.routing.spec.ts, tickets/implement/28.5-sim-metric-guard-case.md
difficulty: medium
---

Continuation of `28-sim-relevance-scoring` (implement, 2026-08-21, run 6 hit the soft token
budget after phase A). **Phase A is done and its result is already recorded** in
`tickets/implement/28.5-sim-metric-guard-case.md` under `## Measured inputs`. This ticket is
**phase B — the capacity sweep — and nothing else.**

Note: the repo's `packages/fret` is already the shell's working directory in this harness, so
ticket paths are `../../tickets/...` from there.

## What phase A settled (do not re-measure)

- The sim-local `alpha` fallback the old ticket described is **not needed** and **must not be
  taken**. The sparsity bonus is not clamp-degenerate: only the distance-0 self entry sits at
  `sMax`, 1 of 32 entries (3.1%) at `capacity: 32`, 1 of 185 (0.5%) unbounded.
- **No tree change was made**, so nothing is half-applied and `yarn test` was not run.
- The spread is real but **narrow** — every non-self entry lands in the x-bin [0.9, 1.0), so the
  whole live population spans ≈ 4% of the bonus range (1.17–1.22). That is a property of
  `normalizedLogDistance` on a 256-bit ring, not of the KDE. Full table in 28.5.
- Incidental single-seed numbers from the phase A runs (seed 4242, 100 routes, 4 s convergence),
  useful only as a starting point for where to sweep:

  | case | knowledge | success | p90 hops | max hops |
  |---|---|---|---|---|
  | n=200 cap=32       | 16.0% | 100% | 3 | 5 |
  | n=1000 edge cap=32 |  3.2% | 100% | 8 | 19 |
  | n=200 unbounded    | 60.0% | 100% | 2 | 2 |

  So `capacity: 32` already looks like it clears the bar on one seed. **That is one seed and is
  not the answer** — the rule below wants the *smallest* capacity clearing it on **all four**.

## The measurement

Sweep `capacity` and pick the **smallest value** where, across all four seeds
(1 / 4242 / 99 / 20260820): knowledge fraction in low single-digit percent, **p90 hops ≥ 3**
under `minDistance`, and success ≥ 95%. If no capacity reaches p90 ≥ 3 with success ≥ 95%, say
so plainly with the numbers rather than loosening anything.

- Protection outranks the cap: the protection set is `2·max(2, m) + 1` = 17 ids at `m` 8, so a
  swept `capacity` below 17 bounds nothing. The default sweep starts there.
- Phase A's n=200 numbers suggest the interesting region is at or **below** 32 for the dense
  case; consider adding `17,20,24,28` rather than only the default list's upper half.

## Run the driver

Save § *The driver* below to `<scratchpad>/measure.mjs`, then from `packages/fret`:

`node --import ./register.mjs <scratchpad>/measure.mjs sweep [comma-separated capacity list]`

It is **verified working** — phase A ran through its `spread` mode unmodified. Its `sweep` mode
has not been run, but shares all of `measureRouting` / `pump` / `baseConfig` with the mode that
did. Delete the script when done.

`measureRouting` / `pump` / `baseConfig` / `CONVERGE_MS` / `ROUTE_COUNT` are copied verbatim
from `test/simulation.routing.spec.ts`; the only change is that `measureRouting` also returns
`sim` and `meanSize`. The n=1000 all-edge case is `profileMix: { edge: 1, core: 0 }`.

## Tests expected

Measurement changes no shipped code, so `yarn test` may be skipped — say so in the handoff. If
you do end up changing anything in the tree, run the full `yarn test` from `packages/fret`.

## TODO

- run `sweep`; widen the capacity list downward if 32 already clears the bar on every seed
- pick the smallest capacity meeting p90 ≥ 3 / success ≥ 95% on all four seeds
- record it into the `## Measured inputs` section of `28.5-sim-metric-guard-case.md`, replacing
  the `not yet measured` bullet
- delete the scratch script; review/ handoff repeating the capacity plus phase A's spread summary

## The driver

```js
// Throwaway measurement driver for ticket 28-sim-relevance-scoring.
// measureRouting / pump / baseConfig copied verbatim from test/simulation.routing.spec.ts.
const BASE = 'file:///C:/projects/Fret/packages/fret/'
const { FretSimulation } = await import(BASE + 'test/simulation/fret-sim.ts')
const { percentileSummary } = await import(BASE + 'test/simulation/sim-metrics.ts')
const { DeterministicRNG } = await import(BASE + 'test/simulation/deterministic-rng.ts')
const { toCoord } = await import(BASE + 'test/helpers/ring.ts')
const { sparsityBonus, normalizedLogDistance } = await import(BASE + 'src/store/relevance.ts')

function pump(sim, uptoMs) {
	while ((sim.scheduler.peek()?.time ?? Infinity) <= uptoMs) {
		sim.processEvent(sim.scheduler.nextEvent())
	}
	sim.scheduler.advanceTo(uptoMs)
}

function baseConfig(overrides = {}) {
	return {
		seed: 4242,
		n: 200,
		k: 15,
		m: 8,
		churnRatePerSec: 0,
		stabilizationIntervalMs: 500,
		durationMs: 60000,
		...overrides,
	}
}

const CONVERGE_MS = 4000
const ROUTE_COUNT = 100

function measureRouting(config) {
	const sim = new FretSimulation(config)
	sim.initialize()
	pump(sim, CONVERGE_MS)

	const sizes = Array.from(sim.getStores().values()).map((s) => s.size())
	const meanSize = sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length)

	const rng = new DeterministicRNG(config.seed + 1)
	const liveIds = Array.from(sim.getPeers().values()).filter((p) => p.alive).map((p) => p.id)
	for (let i = 0; i < ROUTE_COUNT; i++) {
		const from = liveIds[rng.nextInt(0, liveIds.length)]
		sim.scheduleRoute(from, toCoord(rng.nextBigInt(256)), CONVERGE_MS + 10 + i)
	}
	pump(sim, CONVERGE_MS + 10 + ROUTE_COUNT)

	const m = sim.metrics.finalize()
	const hops = percentileSummary(m.successfulRouteHops)
	return {
		sim,
		successRate: m.routingSuccessRate,
		p90Hops: hops.p90,
		maxHops: hops.max,
		attempts: m.routingAttempts,
		knowledgeFraction: meanSize / config.n,
		meanSize,
	}
}

const SEEDS = [1, 4242, 99, 20260820]

function fmtPct(x) { return (x * 100).toFixed(1) + '%' }

function quantiles(xs) {
	const s = [...xs].sort((a, b) => a - b)
	const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
	return { min: s[0], p10: q(0.1), p50: q(0.5), p90: q(0.9), max: s[s.length - 1] }
}

// -- Phase A: relevance spread across one peer's store under a capacity bound -------------
function spread(config, label) {
	const r = measureRouting(config)
	const sim = r.sim
	const stores = sim.getStores()
	const peers = Array.from(sim.getPeers().values()).filter((p) => p.alive && stores.has(p.id))
	peers.sort((a, b) => stores.get(b.id).size() - stores.get(a.id).size())
	const peer = peers[0]
	const store = stores.get(peer.id)
	const model = sim.models.get(peer.id)
	const entries = store.list()
	const rows = entries.map((e) => {
		const x = normalizedLogDistance(peer.coord, e.coord)
		return { id: e.id, x, bonus: sparsityBonus(model, x), rel: e.relevance }
	})
	const bonuses = rows.map((row) => row.bonus)
	const rels = rows.map((row) => row.rel)
	const atMax = bonuses.filter((b) => b >= model.sMax - 1e-9).length
	const atMin = bonuses.filter((b) => b <= model.sMin + 1e-9).length
	console.log('\n### spread [' + label + '] peer=' + peer.id + ' store=' + entries.length +
		' (cap ' + (config.capacity ?? 'unset') + ')')
	console.log('  knowledge ' + fmtPct(r.knowledgeFraction) + '  success ' + fmtPct(r.successRate) +
		'  p90 ' + r.p90Hops + '  max ' + r.maxHops)
	console.log('  bonus ' + JSON.stringify(quantiles(bonuses)))
	console.log('  bonus at sMax(' + model.sMax + '): ' + atMax + '/' + bonuses.length +
		' (' + fmtPct(atMax / bonuses.length) + '); at sMin(' + model.sMin + '): ' + atMin)
	console.log('  relevance ' + JSON.stringify(quantiles(rels)))
	console.log('  occupancy [' + model.occupancy.map((o) => o.toFixed(4)).join(', ') + ']')
	console.log('  centers   [' + model.centers.map((c) => c.toFixed(3)).join(', ') + ']')
	const bins = Array.from({ length: 10 }, () => ({ n: 0, bonus: 0, rel: 0 }))
	for (const row of rows) {
		const i = Math.min(9, Math.floor(row.x * 10))
		bins[i].n++; bins[i].bonus += row.bonus; bins[i].rel += row.rel
	}
	console.log('  x-bin  count  meanBonus  meanRel')
	bins.forEach((b, i) => {
		if (b.n === 0) { console.log('   ' + (i / 10).toFixed(1) + '      0        -         -'); return }
		console.log('   ' + (i / 10).toFixed(1) + '   ' + String(b.n).padStart(5) + '   ' +
			(b.bonus / b.n).toFixed(4) + '   ' + (b.rel / b.n).toFixed(4))
	})
	return { atMaxFraction: atMax / bonuses.length, storeSize: entries.length }
}

const mode = process.argv[2] ?? 'all'

if (mode === 'spread' || mode === 'all') {
	spread(baseConfig({ capacity: 32 }), 'n=200 cap=32')
	spread(baseConfig({ n: 1000, profileMix: { edge: 1, core: 0 }, capacity: 32 }), 'n=1000 edge cap=32')
	spread(baseConfig(), 'n=200 unbounded')
}

// -- Phase B: capacity sweep --------------------------------------------------------------
if (mode === 'sweep' || mode === 'all') {
	const caps = (process.argv[3] ?? '17,20,24,32,48,64,96,128').split(',').map(Number)
	const cases = [['n=200', {}], ['n=1000 all-edge', { n: 1000, profileMix: { edge: 1, core: 0 } }]]
	for (const [label, extra] of cases) {
		console.log('\n### sweep ' + label)
		console.log('  cap   | seed     | know%  | succ%  | p90 | max | meanStore')
		for (const cap of caps) {
			const agg = []
			for (const seed of SEEDS) {
				const r = measureRouting(baseConfig({ ...extra, capacity: cap, seed }))
				agg.push(r)
				console.log('  ' + String(cap).padStart(5) + ' | ' + String(seed).padStart(8) +
					' | ' + fmtPct(r.knowledgeFraction).padStart(6) +
					' | ' + fmtPct(r.successRate).padStart(6) +
					' | ' + String(r.p90Hops).padStart(3) + ' | ' + String(r.maxHops).padStart(3) +
					' | ' + r.meanSize.toFixed(1))
			}
			const minSucc = Math.min(...agg.map((r) => r.successRate))
			const minP90 = Math.min(...agg.map((r) => r.p90Hops))
			const maxP90 = Math.max(...agg.map((r) => r.p90Hops))
			console.log('  ' + String(cap).padStart(5) + ' | SUMMARY  | minSucc ' + fmtPct(minSucc) +
				' p90 ' + minP90 + '..' + maxP90)
		}
	}
}
```
