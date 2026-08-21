---
description: The background maintenance cycle was fixed so its second half always gets a slice of time, but the two tests that prove a stalled neighbour can no longer eat the whole cycle were never written. Write them.
files: packages/fret/test/stabilize-concurrency.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, packages/fret/src/service/fret-service.ts
difficulty: medium
---

<!-- resume-note -->
## Resume note (run 2 — stopped on BUDGET_WARNING before any code was written)

No test code was written and no validation was run. Nothing in the working tree changed. The run
was spent reading, and the facts below are what it established — read them before you re-open the
files. They correct one claim in the section that follows and remove one TODO item.

**The tree is clean; the fix is committed, not uncommitted.** The section below originally said the
fix sat in the working tree as uncommitted edits. It does not — it landed in commits (HEAD
`a7fba06`, `ticket(implement): tick-budget-starves-phase-two`), and `git status` shows only the
untracked `tickets/.in-progress`. So the "must not revert the tree wholesale" caution is moot: for
the confirm-it-bites flip, edit the one line, run the single case, edit it back. Still never run
`git checkout` / `restore` / `reset` / `stash` — other tickets may be in flight.

**The mid-phase-1 abort case already exists — that TODO is dropped.**
`test/stabilize-concurrency.spec.ts` already has `records nothing against any peer when the budget
cuts the first phase and skips the second` (tick budget 50 ms, every peer hangs; asserts
`evidence(id)` unchanged for members, unknowns, foreign and dead, plus `pingsFail` / `pingsSent`
unmoved, phase-2 peers never opened, and `inFlight === 0`), and a companion `records nothing
against a peer whose membership probe the budget aborts mid-flight`. Between them the "a phase-1
task cut off by the phase budget must score nothing" concern is already covered.

**Mocha timeout gotcha — this will bite both new cases.** The spec sets `this.timeout(10000)` at
the `describe` level (line 26). A per-file `this.timeout()` **overrides** the `--timeout 30000` CLI
flag, so a case running at the real, unmutated budgets (phase 1 alone is 3 s, and case 1 runs two
ticks) blows the 10 s describe timeout no matter what the command line says. Raise it — per case
via `this.timeout(...)`, which needs an ordinary `function` callback (the existing cases use arrow
callbacks, which have no `this`), or lift the describe-level value. Budget ~3 s per hung tick.

**Rig API, as it actually exists** (`test/helpers/maintenance-rig.ts`). The original body wrote
`rig.rig.*`; that is `MaintenanceRig.rig`, the `PeerRig` instance:
- `harness.rig.setProtocolBehavior(id, protocol, 'answers' | 'hangs')` — per-(peer, protocol),
  consulted **ahead of** the per-peer map. This is case 1's lever: ping answers, neighbors hangs.
- `harness.rig.behavior.set(id, 'hangs')` — per-peer, every protocol. Case 2's lever.
- `harness.rig.protocolsSeenBy(id)` → protocols opened against that peer, in call order.
- `harness.rig.holdMs`, `.inFlight`, `.highWater`.
- `harness.ping()` / `harness.neighbors()` → the two protocol strings.
- `harness.seedPeers(count, membership, patch?)`, `harness.setTickBudget(ms)`,
  `harness.concurrency()`, `harness.teardown()`.
- There is **no** `setPhaseOneBudget`. Add one only if a case genuinely needs it; cases 1 and 2 as
  specified do not — they run at the real budgets on purpose.
- Inside the spec the local aliases `ping()`, `neighbors()`, `seedPeers()`, `setTickBudget()`,
  `concurrency()` and `tick()` already exist, and `tick()` returns the elapsed ms. Switching to the
  Edge profile means `await teardown()` then `await build('edge')` — see the existing Edge
  pool-cap case for the pattern.

**Code sites for the two temporary flips** (`packages/fret/src/service/fret-service.ts`):
- `stabilizeOnce` at ~:2234. The phase-1 deadline is opened at ~:2245, and the pool options plus
  the `probeAndFetch` calls at ~:2248–2249 (`this.probeAndFetch(id, phaseOne.signal)` and
  `phaseOnePool = { ..., signal: phaseOne.signal }`). **Case 1's flip:** hand both `budget.signal`
  instead of `phaseOne.signal`.
- `probeAndFetch` at ~:2313; its `if (!answered) return []` gate sits just below the
  `wasCancelled(signal)` early return. **Case 2's flip:** delete that gate.

## What already landed (do not redo)

The fix from `tick-budget-starves-phase-two` is **implemented, type-checks, passes every existing
spec, and is committed** (see the resume note):

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
  `behavior` map. Every existing caller is unaffected.
- `test/stabilize-budget-invariants.spec.ts` — new, passing. Reads the four statics off
  `FretService` and asserts both inequalities with failure messages naming which number moved.
  Builds no rig, so it sees the declared defaults.
- `docs/fret.md` — *Stabilization and churn handling* gained three sub-bullets under **Two phases**
  (the reserve, the did-not-answer skip, the invariant and where it is pinned); *Stream management*
  lists `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` and records why it is not the route-sized default.

Validated at that time: `npx tsc --noEmit` clean, and
`test/{stabilize-concurrency,per-tick-hotpath,failure-recovery,dead-state,stabilize-budget-invariants}.spec.ts`
= 75 passing. **`yarn test` (the full suite) has not been run** — that is part of this ticket.

## What is left

Two regression cases in `packages/fret/test/stabilize-concurrency.spec.ts`, plus full validation.
Both drive `(svc as any).stabilizeOnce()` directly at the **real, unmutated** budgets (do not call
`harness.setTickBudget`), so a hung phase 1 costs ~3 s per tick — budget the wall clock accordingly
and raise the spec's timeout per the resume note.

**Case 1 — a stalled snapshot must not starve phase 2.** Seed one near peer (live `member`) and
give it `harness.rig.setProtocolBehavior(id, harness.neighbors(), 'hangs')`, so its `PROTOCOL_PING`
still answers and only the neighbors fetch hangs. Seed at least one `dead` peer and one `unknown`
peer so both phase-2 arms have a target. Assert each phase-2 peer sees exactly one `PROTOCOL_PING`
per tick (`harness.rig.protocolsSeenBy(id)`), on tick 1 **and** on a second tick — the second tick
is what pins the "and it never gets a turn again" half, which is the part that made this a real
outage rather than a one-tick hiccup.

**Case 2 — an unreachable near peer issues no snapshot fetch.** A near peer whose ping hangs (plain
per-peer `harness.rig.behavior.set(id, 'hangs')` suffices) must open **zero** `PROTOCOL_NEIGHBORS`
streams. Against the old code it opened one, which could only fail.

**Confirm both tests bite.** The fix is already committed, so get that evidence by temporarily
undoing the one line each case depends on (sites named in the resume note), running that case, and
putting it back. Record in the review handoff that you confirmed each, and by which flip.

**Sanity-check the Edge profile too** (`maintenanceConcurrency` is 2 there, so 4 near peers take
two pool rounds and phase 1 is likelier to reach its sub-budget) — at minimum run case 1 under
`buildMaintenanceRig('edge')` as well as the Core profile the rest of the spec uses.

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

- Raise the spec's mocha timeout so cases at the real budgets can finish (see resume note).
- Write case 1 (stalled snapshot, two ticks, dead + unknown phase-2 targets) in
  `test/stabilize-concurrency.spec.ts`.
- Write case 2 (unreachable near peer opens zero neighbors streams).
- Run case 1 under the Edge profile as well.
- Confirm each case bites by the temporary flip described in the resume note; put the code back.
- `npx tsc --noEmit`, the targeted mocha run, then `yarn test` in the foreground.
