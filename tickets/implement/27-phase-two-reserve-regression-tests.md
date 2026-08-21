---
description: The background maintenance cycle was fixed so its second half always gets a slice of time, but the two tests that prove a stalled neighbour can no longer eat the whole cycle were never written. Write them.
files: packages/fret/test/stabilize-concurrency.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, packages/fret/src/service/fret-service.ts
difficulty: medium
---

## What already landed (do not redo)

The fix from `tick-budget-starves-phase-two` is **implemented, type-checks, and passes every
existing spec**. Working tree at the time of writing carries, all uncommitted:

- `src/service/fret-service.ts`
  - `MAINTENANCE_SNAPSHOT_TIMEOUT_MS = 1000` declared beside `MAINTENANCE_RPC_TIMEOUT_MS`, and
    passed as `timeoutMs` from `fetchAndMergeSnapshot`'s `fetchNeighbors` call (previously the
    route-sized `RPC_TIMEOUT_MS` default).
  - `STABILIZE_PHASE_ONE_BUDGET_MS = 3000` declared beside `STABILIZE_TICK_BUDGET_MS`.
  - `stabilizeOnce` opens `deadline(STABILIZE_PHASE_ONE_BUDGET_MS, budget.signal)` — a child of
    the tick deadline — runs phase 1's pool and every `probeAndFetch` against *that* signal, and
    `cancel()`s it in a `finally`. Phase 2 keeps the tick signal and has its own pool options
    object. `enforceCapacity` and the announce are unmoved (still after phase 1 drains, above the
    phase-2 early return). The stale `NOTE:` naming `bug-tick-budget-starves-phase-two` is gone.
  - `probeNeighborLatency` now returns `Promise<boolean>` — whether the peer *answered*, by the
    round-trip rule in *Evidence strength* (`ok` either polarity / `busy` / `decode-error` → true;
    `unreachable` / `timeout` / `foreign-protocol` / `cancelled` / `skipped` / the malformed-id
    `catch` → false). No scoring changed.
  - `probeAndFetch` keeps its `wasCancelled(signal)` early return **ahead of** a new
    `if (!answered) return []` gate, so an unreachable near peer issues no neighbors request.
- `test/helpers/maintenance-rig.ts` — `PeerRig` gained a `protocolBehavior` map and
  `setProtocolBehavior(id, protocol, behavior)`, consulted in `open` ahead of the per-peer
  `behavior` map. Every existing caller is unaffected. `setPhaseOneBudget` was deliberately **not**
  added; add it only if a test below actually needs it.
- `test/stabilize-budget-invariants.spec.ts` — new, passing. Reads the four statics off
  `FretService` and asserts both inequalities with failure messages naming which number moved.
  Builds no rig, so it sees the declared defaults.
- `docs/fret.md` — *Stabilization and churn handling* gained three sub-bullets under **Two phases**
  (the reserve, the did-not-answer skip, the invariant and where it is pinned); *Stream management*
  lists `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` and records why it is not the route-sized default.

Validated: `npx tsc --noEmit` clean, and
`test/{stabilize-concurrency,per-tick-hotpath,failure-recovery,dead-state,stabilize-budget-invariants}.spec.ts`
= 75 passing. **`yarn test` (the full suite) has not been run** — that is part of this ticket.

## What is left

Two regression cases in `packages/fret/test/stabilize-concurrency.spec.ts`, plus full validation.
Both drive `(svc as any).stabilizeOnce()` directly at the **real, unmutated** budgets (do not call
`rig.setTickBudget`), so a hung phase 1 costs ~3 s per tick — budget the wall clock accordingly and
keep `--timeout 30000`.

**Case 1 — a stalled snapshot must not starve phase 2.** Seed one near peer (live `member`) and
give it `rig.rig.setProtocolBehavior(id, rig.neighbors(), 'hangs')`, so its `PROTOCOL_PING` still
answers and only the neighbors fetch hangs. Seed at least one `dead` peer and one `unknown` peer so
both phase-2 arms have a target. Assert each phase-2 peer sees exactly one `PROTOCOL_PING` per tick
(`rig.rig.protocolsSeenBy(id)`), on tick 1 **and** on a second tick — the second tick is what pins
the "and it never gets a turn again" half, which is the part that made this a real outage rather
than a one-tick hiccup.

**Case 2 — an unreachable near peer issues no snapshot fetch.** A near peer whose ping hangs (plain
per-peer `rig.rig.behavior.set(id, 'hangs')` suffices) must open **zero** `PROTOCOL_NEIGHBORS`
streams. Against the old code it opened one, which could only fail.

**Confirm both tests bite.** The ticket originally asked for "run it against HEAD first and watch
it fail"; the fix is already in the tree and the tree must not be reverted wholesale. Get the same
evidence by temporarily undoing the one line each case depends on, running the case, and putting it
back:
- Case 1 bites when `stabilizeOnce`'s phase-1 pool and `probeAndFetch` calls are handed
  `budget.signal` instead of `phaseOne.signal`.
- Case 2 bites when `probeAndFetch`'s `if (!answered) return []` is removed.
Record in the review handoff that you confirmed each, and by which flip.

**Sanity-check the Edge profile too** (`maintenanceConcurrency` is 2 there, so 4 near peers take
two pool rounds and phase 1 is likelier to reach its sub-budget) — at minimum run case 1 under
`buildMaintenanceRig('edge')` as well as whatever profile the rest of the spec uses.

Then, from `packages/fret/`:

```
npx tsc --noEmit
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/stabilize-concurrency.spec.ts" "test/stabilize-budget-invariants.spec.ts" "test/per-tick-hotpath.spec.ts" "test/failure-recovery.spec.ts" "test/dead-state.spec.ts" --timeout 30000
yarn test
```

Run `yarn test` in the foreground with no redirection so the runner's idle timer stays alive.

## Things to check rather than assume

- **Timer leaks.** Two `deadline()` handles are live per tick now. `test/mocha-exit-watchdog.ts`
  (10 s grace, no `--exit`) is the regression detector — a leak fails the run rather than hanging.
  If the run hangs at the end, that is the signal, not a flake.
- **A phase-1 task cut off by the phase budget must score nothing** — no strike, no backoff, no
  relevance decay, no `pingsFail`. `wasCancelled` compares against the signal the task was handed,
  which is now the phase-1 signal. A case that aborts mid-phase-1 and asserts zero strikes belongs
  in this spec if one is not already there.
- **`stop()` must still collapse the whole tick.** The phase-1 deadline is a child of the tick
  deadline which is a child of the run signal, so all three abort together — a `stop()` landing
  inside phase 1 must leave phase 2 un-run and record nothing.
- **The existing high-water-mark assertion** (pool concurrency *equals* the cap, proving the tick
  genuinely overlaps) and the **four-candidate-set disjointness** assertion must still pass; both
  were green after the implementation, but the new cases must not disturb them.
- `test/per-tick-hotpath.spec.ts` sets the tick budget to 50 ms; the phase-1 deadline is a *child*,
  so it aborts with the parent and the phase budget is never binding there. Confirmed green already
  — keep it that way.

## TODO

- Write case 1 (stalled snapshot, two ticks, dead + unknown phase-2 targets) in
  `test/stabilize-concurrency.spec.ts`.
- Write case 2 (unreachable near peer opens zero neighbors streams).
- Run case 1 under the Edge profile as well.
- Confirm each case bites by the temporary flip described above; put the code back.
- Add a mid-phase-1 abort case asserting zero strikes, if the spec does not already have one.
- `npx tsc --noEmit`, the targeted mocha run, then `yarn test` in the foreground.
