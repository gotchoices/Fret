---
description: With the simulated peers now scoring relevance for real, measure the score spread and sweep store capacity to pick the constant the follow-up metric-guard ticket needs.
prereq: sim-relevance-scoring-wiring-scores
files: packages/fret/test/simulation/fret-sim.ts, packages/fret/src/store/relevance.ts, packages/fret/test/simulation.routing.spec.ts, tickets/implement/28.5-sim-metric-guard-case.md
difficulty: medium
---

Narrowed from the original `sim-relevance-scoring` (2026-08-21, run 3 hit token budget): the
code changes moved to `sim-relevance-scoring-wiring-scores` (prereq). This ticket is
**measurement and the capacity decision only** — the wiring has landed (verified, below).

<!-- resume-note -->
Run 5 (2026-08-21) also hit the soft token budget during orientation, before any measurement
ran. **No tree change was made; nothing to resume mid-flight.** Two things run 5 adds, which
between them remove one branch of the ticket's decision tree and the whole cost of writing the
measurement driver:

- **`scoreMerge` *does* observe the KDE — the open question in "State at HEAD" is answered.**
  `fret-sim.ts` `scoreMerge` resolves the per-peer model and then calls `observeDistance(model, x)`
  before `initialRelevance`. So gossip merges do feed occupancy; the "nothing observes at all"
  cause is ruled out, and the documented sim-local `alpha` fallback is the right lever **if** the
  measured spread still turns out degenerate. Do not re-read that function to confirm this.
- The measurement driver is written out in full below (§ *The driver*) — a verbatim copy of the
  routing spec's harness plus the two measurement phases. Paste it into the scratchpad and run
  it; do not re-derive it. It has **not been run**, so treat a crash on first run as ordinary
  debugging rather than as a finding.

Start at "Run the driver" and go straight to numbers.
<!-- /resume-note -->

Note for whoever runs this: the repo's `cd packages/fret` is already the shell's working
directory in this harness, and ticket paths are therefore `../../tickets/...` from there.

## State at HEAD (verified 2026-08-21 — do not re-verify)

Prereq wiring is present in `test/simulation/fret-sim.ts`:

- per-peer sparsity models: `models: Map<string, SparsityModel>`, created by
  `createSparsityModel()` in `addPeer` — **no argument overrides today**, so the model runs at
  production defaults
- self-seed scored with `initialRelevance` (KDE deliberately not observed with the distance-0
  self entry)
- `scoreMerge` called from three merge sites, and **it calls `observeDistance`** (see resume note)
- `enforceCapacity` with production's protection set, called from four sites, each guarded by
  `if (this.config.capacity)`
- `SimConfig.capacity?: number` — unset in every spec today
- `nearRadiusFor` derives the near radius from `store.size()`

Production constants that decide the spread question (`src/store/relevance.ts`):
`createSparsityModel(m = 12, sigma = 0.08, alpha = 0.03, beta = 0.6, sMin = 0.7, sMax = 1.8)`;
centers are `(i + 0.5) / 12`, i.e. 0.042 … 0.958. `sparsityBonus` clamps at `sMax` whenever
occupancy is near zero, so **the clamp question is an occupancy-rate question**. Merges do
observe (confirmed above), so the only remaining cause of a fully-clamped spread is occupancy
growing too slowly at `alpha = 0.03` for the number of merges one sim run produces — which is
exactly what the documented `alpha` fallback fixes. Say which cause you measured.

## Run the driver

From `packages/fret`: `node --import ./register.mjs <scratchpad>/measure.mjs [spread|sweep|all]`.
Modes: `spread` (phase A only), `sweep` (phase B; optional 4th argument is a comma-separated
capacity list), `all` (default). Delete the script when done.

`measureRouting` / `pump` / `baseConfig` / `CONVERGE_MS` / `ROUTE_COUNT` in it are copied
verbatim from `test/simulation.routing.spec.ts`; the only change is that `measureRouting` also
returns `sim` and `meanSize`, so phase A can reach into the converged run's stores. Seeds
1 / 4242 / 99 / 20260820; the n=1000 all-edge case is `profileMix: { edge: 1, core: 0 }`.

`sim.models` is `private` in TypeScript only. The driver is plain `.mjs`, so reading it at
runtime is legal and is how phase A gets at each peer's occupancy array.

## Measurements — pick the constant, record both numbers

Expectations below are derived arithmetic, not observations — decide from what you measure.

- **Relevance spread across one peer's store** (phase A). Expectation: occupancy piles up at
  high-x KDE centers (bonus ≈ 1.05–1.1) while low-x centers stay sparse (clamped at `sMax` 1.8);
  that gradient makes eviction prefer far peers and keep the near/mid spine. The driver prints
  bonus quantiles, the at-`sMax` fraction, the raw occupancy array, and an x-binned
  count / mean-bonus / mean-relevance table, so the gradient is visible directly rather than
  inferred from the relevance numbers.
  - **Decision rule: if every entry still clamps at `sMax` (at-`sMax` fraction ≈ 100%),
    gossip-fed KDE is not enough.** Fallback: raise `alpha` for the sim's model only — a
    sim-local constant passed to `createSparsityModel` at the model-creation site in `addPeer`,
    documented there as sim-local and why. Do **not** change the production default in
    `src/store/relevance.ts`. Since merges are confirmed to observe, "observed but too slow" is
    now the only live cause, so this fallback is available without further diagnosis.
- **`capacity`, chosen so routes are genuinely multi-hop** (phase B). The existing spec logs
  knowledge fraction 63% at n=200 and 19% at n=1000 (both unbounded). Target: knowledge fraction
  in low single-digit percent and **p90 hops ≥ 3** under `minDistance`, with success ≥ 95%.
  Sweep `capacity` and pick the smallest value meeting that across all four seeds. If no capacity
  reaches p90 ≥ 3 with success ≥ 95%, say so plainly with the numbers rather than loosening
  anything.
  - The protection set is `2·max(2, m) + 1` = 17 ids at `m` 8, and protection outranks the cap,
    so a swept `capacity` below 17 bounds nothing. The driver's default sweep starts there:
    `17,20,24,32,48,64,96,128`.

**Record both measured numbers by editing the `## Measured inputs` section of
`tickets/implement/28.5-sim-metric-guard-case.md`** (the follow-up needs them), and repeat them
in this ticket's review handoff.

## Tests expected

- full `yarn test` from `packages/fret` still green (measurement should change no shipped code
  except possibly the sim-local `alpha` constant; if `alpha` changes, re-run
  `test/simulation.partition.spec.ts` and then the full suite again)
- if no tree change was made, `yarn test` may be skipped — say so in the handoff

## TODO

- paste § *The driver* into the scratchpad; run `spread`, then `sweep`
- read the spread; take the sim-local `alpha` fallback only if the at-`sMax` fraction says the
  bonus is degenerate, and document the deviation at the `createSparsityModel()` call in `addPeer`
- pick the smallest capacity meeting p90 ≥ 3 / success ≥ 95% on every seed; record capacity plus
  a spread summary into `28.5-sim-metric-guard-case.md`
- full `yarn test` if any tree change was made; delete the scratch script
- review/ handoff repeating both numbers and any deviation taken

## The driver

Written by run 5, unrun. Save as `<scratchpad>/measure.mjs`.

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
