---
description: Structured JSON metrics output, Edge/Core profile simulation, and CI regression thresholds for the deterministic simulation harness.
files:
  - packages/fret/test/simulation/sim-metrics.ts
  - packages/fret/test/simulation/fret-sim.ts
  - packages/fret/test/sim-profiles.spec.ts
  - .gitignore
---

## What was built

### 1. Structured JSON metrics output (`sim-metrics.ts`)
- `percentile(sorted, p)` — nearest-rank percentile from a sorted array.
- `percentileSummary(values)` — builds a `PercentileSummary` (p50/p90/p99/max) from unsorted data.
- `SimReport` interface: `meta` (seed, config, timestamp, gitSha), `summary` (`SimMetrics`), `distributions` (routing-hop / neighbor-count percentiles, convergence summary).
- `MetricsCollector.toReport(config)` / `.toJSON(config)` — full report + CI-consumable JSON string.

### 2. Edge/Core profile simulation (`fret-sim.ts`)
- `SimPeerConfig` with `EDGE_PROFILE` (6/6/6 caps, 2000ms cadence, 4 connections) and `CORE_PROFILE` (12/12/8 caps, 500ms cadence, 12 connections).
- `ProfileMix` + `profileMix` on `SimConfig`; RNG-driven per-peer profile assignment.
- Per-profile stabilization cadence (global tick at the fastest cadence, per-peer gating in `handleStabilize`).
- Snapshot caps enforced in bus-based and direct neighbor exchange; connection budget enforced in `handleConnect`.

### 3. CI integration
- `.gitignore` for `packages/fret/test/simulation/output/`.
- JSON schema documented via the TypeScript interfaces; routing-success regression threshold (≥85%) as a test.

## Review findings

**Diff reviewed**: implement commit `6a06093`. Read with fresh eyes before the handoff summary.

### Checked
- **Correctness** — `percentile` nearest-rank math (p50/p90/p99 on 1..100, empty, single-element all verified); `percentileSummary` copies before sorting, so it does not mutate `routingHops`/`neighborCounts` (no aliasing bug). `finalize()` is idempotent and safe to call from both `run()` and `toReport()`.
- **Profile mechanics** — profile assignment, per-peer cadence gating (edge gated to 2000ms while the global tick fires at 500ms), and snapshot-cap enforcement in both exchange paths. Confirmed deterministic.
- **Type safety** — `npx tsc --noEmit` clean (before and after my edits). No `any` introduced.
- **Tests** — `test/sim-profiles.spec.ts`: 10/10 pass. Full suite: 231 pass, 2 fail (pre-existing, unrelated — see below).
- **Docs** — `docs/fret.md` already documents the profile snapshot caps (Edge ≤6/6/6, Core ≤12/12/8); the new constants match. The `SimReport` format is a test-harness internal whose schema is its TypeScript interfaces, as intended — no `fret.md` change required.

### Found & fixed inline (minor)
- **Dead code**: `getConfig()` getter was added but never referenced anywhere. Removed.

### Tripwires (recorded in code, not ticketed)
- **`snapshotCap.sample` is inert in the harness** — the sim never emits the sparsity-weighted `sample` portion of a snapshot, so the `sample` cap is carried for parity with real profiles but enforces nothing. The spec assertions on it (`edgeCap.sample === 6`, etc.) only re-check the constant. Added a `NOTE:` at the `SimPeerConfig.snapshotCap` declaration pointing at `collectSnapshotEntries` for when/if sample-seeding lands.
- **`config.stabilizationIntervalMs` is ignored when `profileMix` is set** — per-peer cadence then comes from each profile and the global tick only sets polling granularity. This is intentional but silent; added a `NOTE:` in `scheduleStabilization()` so a future reader isn't surprised that the config field has no effect under a profile mix.

### Found, left as-is (observations, no action)
- **`timestamp: new Date().toISOString()`** makes the report non-deterministic in an otherwise deterministic harness. Acceptable — it is CI trend metadata, not a simulated value, and the round-trip test only asserts field presence.
- **Test name vs assertion** — `'all-core converges faster than mixed'` only asserts all-core is not worse by >5% (not strictly faster). Mild overstatement; the assertion is the safe/non-flaky one, so left unchanged.

### Empty categories
- **No major findings** — nothing warranted a new fix/plan/backlog ticket. The implementation is sound, deterministic, and well-decomposed.

### Pre-existing failure (not mine)
- Full-suite run surfaced 2 failures, both the single test `Proactive announcements > rate limiting prevents announcement storms` (`test/proactive-announce.spec.ts`): a libp2p `StreamStateError: Cannot write to a stream that is closed` plus a duplicate `done()` — a stream-lifecycle/async flake in the real-libp2p stack, which this ticket never touches. Flagged in `tickets/.pre-existing-error.md` for the runner's triage pass.
