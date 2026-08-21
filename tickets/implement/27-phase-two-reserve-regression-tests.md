---
description: The background maintenance cycle was fixed so its second half always gets a slice of time, but the two tests that prove a stalled neighbour can no longer eat the whole cycle were never written. Write them.
files: packages/fret/test/stabilize-concurrency.spec.ts, packages/fret/test/helpers/maintenance-rig.ts, packages/fret/src/service/fret-service.ts
difficulty: medium
---

<!-- resume-note -->
## Resume note (run 4 — BUDGET_WARNING on third tool call; no code written)

Working tree untouched (`git status` still only untracked `tickets/.in-progress`; HEAD `911ae0f`).
Run 4 re-read the rig, the whole spec, and grepped the service for the flip sites. It **confirms**
run 3's note below in full — nothing in it is corrected — and adds the exact coordinates the next
run would otherwise re-derive. Read run 3's note, then this list, then write the two cases.

### Confirmed, do not re-verify

- **Rig API is exactly as run 2's note describes.** `test/helpers/maintenance-rig.ts`:
  `PeerRig.setProtocolBehavior(id, protocol, b)` (checked *before* the per-peer `behavior` map, in
  `PeerRig.open`), `behavior`, `protocolsSeenBy`, `holdMs`, `inFlight`, `highWater`; and on the
  `MaintenanceRig`: `ping()`, `neighbors()`, `concurrency()`, `setTickBudget()`, `seedPeers()`,
  `teardown()`. There is **no** `setPhaseOneBudget` and neither new case needs one.
- `seedPeers(count, membership, patch?)` mints real Ed25519 ids at true ring coords, marks each
  dialable, and `buildMaintenanceRig` stubs `getConnections` so **every** peer has one open
  connection. So the connection-only `fetchNeighbors` really does open a stream — which is what
  makes case 2's `!answered`-gate flip a genuine bite rather than a no-op.
- The spec's local aliases (`ping`, `neighbors`, `seedPeers`, `setTickBudget`, `concurrency`,
  `tick()` returning elapsed ms) and the `evidence(id)` snapshot helper all exist near the top of
  `test/stabilize-concurrency.spec.ts`; `this.timeout(10000)` is the describe-level default.

### Exact sites (line numbers from HEAD `911ae0f`; grep the symbol, don't trust the number)

`packages/fret/src/service/fret-service.ts`:
- `MAINTENANCE_SNAPSHOT_TIMEOUT_MS = 1000` declared :334; `STABILIZE_PHASE_ONE_BUDGET_MS = 3000` :370.
- `stabilizeOnce` :2234 — phase-1 `deadline(...)` :2245, pooled `probeAndFetch` call :2249,
  phase-2 target selection :2281.
- `nearProbeTargets` :2296, `probeAndFetch` :2313 (its `!answered` gate is the `return []` just
  above the `fetchAndMergeSnapshot` call at :2324 — **case 2's bite flip**), `phaseTwoTargets` :2409.
- `fetchAndMergeSnapshot` :2626 — its `fetchNeighbors` options carry
  `timeoutMs: FretService.MAINTENANCE_SNAPSHOT_TIMEOUT_MS` at **:2634. That single line is case 1's
  bite flip** (delete it -> falls back to the route-sized `RPC_TIMEOUT_MS` 5000 -> the stalled fetch
  outruns the 5000 ms tick budget -> phase 2 early-returns and the phase-2 peers are never opened).
  Put it back after running the one case.

### Where to put the two cases

`test/stabilize-concurrency.spec.ts` is organized by `// ----- section -----` banners in this
order: headline regression, pool cap, ping-before-fetch per peer, disjoint candidate lists,
truncation is not evidence, rotation, phase-2 target selection. Add a new
`// ----- phase-2 reserve -----` section **immediately after the headline-regression case** (it is
the same family: one stalled peer must not cost the tick its other work) and put both new cases
there. Also add the two new concerns to the bullet list in the file-header comment, which
enumerates the properties the spec pins.

## Resume note (run 3 — stopped on BUDGET_WARNING on the second tool call; no code written)

Run 3 changed nothing in the working tree (`git status` still shows only the untracked
`tickets/.in-progress`). It re-read the rig, the spec and `stabilizeOnce`, and worked the timing
arithmetic through. That arithmetic **corrects two things run 2 wrote down**, and both would have
cost the next run a failing test and a bite-confirmation that does not bite. Read this section
before re-opening the files; everything under *Rig API* and *Code sites* in run 2's note below is
still accurate and is not repeated here.

### 1. Case 1's bite flip is the snapshot timeout, not the phase-1 signal

Run 2's note said to confirm case 1 bites by handing phase 1 `budget.signal` instead of
`phaseOne.signal`. **That flip does not bite**, because of the per-RPC timeouts:

- A phase-1 task is `probeAndFetch` = ping then fetch, chained per peer. The ping is bounded by
  `MAINTENANCE_RPC_TIMEOUT_MS` (2000) and the fetch by `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` (1000),
  so **one task costs at most ~3000 ms**, and the tasks are pooled, so phase 1's wall clock is
  ~3000 ms at worst no matter how many near peers stall.
- 3000 ms is exactly `STABILIZE_PHASE_ONE_BUDGET_MS`. So phase 1 leaves >= 2000 ms of the 5000 ms
  tick for phase 2 **whether or not the sub-budget exists**. Swapping the signal starves nothing.
- The flip that *does* bite is reverting the other half of the fix: drop the `timeoutMs` from the
  `fetchNeighbors` call in `fetchAndMergeSnapshot` so it falls back to the route-sized
  `RPC_TIMEOUT_MS` (5000). The stalled fetch then runs past the 5000 ms tick budget, phase 2 hits
  the `budget.signal.aborted` early return, and the phase-2 peers are never opened. That is the
  outage case 1 exists to pin.

**Finding to carry into the review handoff:** given today's constants the phase-1 sub-budget is a
belt-and-braces guard, and the load-bearing change for this regression is the snapshot timeout.
The sub-budget is what keeps the guard true if either RPC timeout is ever raised, and it is already
pinned as an inequality over the declared defaults by `test/stabilize-budget-invariants.spec.ts`.
That division of labour is worth stating plainly in the handoff rather than claiming case 1 pins
the sub-budget — it does not.

### 2. Case 1's second tick needs the labels re-posed, or it asserts the wrong thing

Run 2's note asked for "exactly one `PROTOCOL_PING` per tick" against the phase-2 peers on tick 1
**and** tick 2. As specified that fails on tick 2: the phase-2 peers answer their probe, so the
`unknown` one is promoted to `member` and the `dead` one is revived — both become **live members**
and are therefore drawn into the *near* list on tick 2, where they are pinged *and* fetched.
`protocolsSeenBy` then reads `[ping, neighbors]` for the second tick, not `[ping]`.

Three ways out; **(a) is the recommendation**:

- **(a) Re-pose the starting labels between the two ticks** — `store.setMembership(unknownId, 'unknown')`
  and `store.update(deadId, { state: 'dead' })` — and assert one ping opened per peer per tick.
  Fast (~1.1 s per tick), and it says plainly what it is doing: asking the same question of a
  second tick, which is the "and it never gets a turn again" half.
- (b) Make the phase-2 peers hang so their labels never change. Costs ~3 s per tick (phase 2's ping
  times out at 2000 ms) and needs checking that the backoff a timed-out probe records does not make
  `reprobeExcludedTargets` skip the peer on tick 2 — its off-backoff filter is real, and the first
  backoff window may or may not have elapsed by the time tick 2 runs. Fragile.
- (c) Assert whatever promotion leaves behind on tick 2. Rejected: that measures promotion, not the
  phase-2 reserve.

### 3. The mocha timeout worry was overstated, but still raise it

Run 2's note budgeted ~3 s per hung tick and warned the describe-level `this.timeout(10000)`
(line 25) would blow. With the real constants a tick is **~1.0–1.1 s** for case 1 (phase 1 ends on
the 1000 ms snapshot timeout, not on its 3000 ms sub-budget) and **~2.0 s** for case 2 (the ping
timeout). Mocha's `this.timeout` is per *test*, not per file, so 10 s is already enough for each
case as specified. Raise it to ~20 s for these two cases anyway as insurance against a slow CI box
— per case via `this.timeout(...)`, which needs an ordinary `function` callback (the existing cases
use arrow callbacks, which have no `this`).

### 4. Case 2 is unchanged and is the simpler of the two

Near peer whose ping hangs (`harness.rig.behavior.set(id, 'hangs')`) → the ping times out at
2000 ms → `probeAndFetch`'s `wasCancelled(signal)` is false (phase 1's budget is 3000 ms, not yet
expired) → the `if (!answered) return []` gate is what stops the fetch. Assert zero
`PROTOCOL_NEIGHBORS` streams. Deleting that one gate is a clean bite: the rig's stubbed
`getConnections` gives every peer an open connection, so the connection-only `fetchNeighbors`
really would open a stream.

<!-- end resume-note -->

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

**Code sites for the temporary flips** (`packages/fret/src/service/fret-service.ts`):
- `stabilizeOnce` at ~:2234. The phase-1 deadline is opened at ~:2245, and the pool options plus
  the `probeAndFetch` calls at ~:2248–2249 (`this.probeAndFetch(id, phaseOne.signal)` and
  `phaseOnePool = { ..., signal: phaseOne.signal }`). **See run 3's note above: swapping this
  signal is NOT case 1's bite flip.** Case 1's flip is the `timeoutMs` on the `fetchNeighbors` call
  inside `fetchAndMergeSnapshot`.
- `probeAndFetch` at ~:2313; its `if (!answered) return []` gate sits just below the
  `wasCancelled(signal)` early return. **Case 2's flip:** delete that gate.

## What already landed (do not redo)

The fix from `tick-budget-starves-phase-two` is **implemented, type-checks, passes every existing
spec, and is committed** (see the resume notes):

- `src/service/fret-service.ts`
  - `MAINTENANCE_SNAPSHOT_TIMEOUT_MS = 1000` declared beside `MAINTENANCE_RPC_TIMEOUT_MS`, and
    passed as `timeoutMs` from `fetchAndMergeSnapshot`'s `fetchNeighbors` call (previously the
    route-sized `RPC_TIMEOUT_MS` default).
  - `STABILIZE_PHASE_ONE_BUDGET_MS = 3000` declared beside `STABILIZE_TICK_BUDGET_MS`.
  - `stabilizeOnce` opens `deadline(STABILIZE_PHASE_ONE_BUDGET_MS, budget.signal)` — a child of the
    tick deadline — runs phase 1's pool and every `probeAndFetch` against *that* signal, and
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
`harness.setTickBudget`). Per run 3's arithmetic a tick costs ~1.1 s (case 1) or ~2.0 s (case 2),
not the ~3 s run 2 assumed.

**Case 1 — a stalled snapshot must not starve phase 2.** Seed one near peer (live `member`) and
give it `harness.rig.setProtocolBehavior(id, harness.neighbors(), 'hangs')`, so its `PROTOCOL_PING`
still answers and only the neighbors fetch hangs. Seed at least one `dead` peer and one `unknown`
peer so both phase-2 arms have a target. Assert each phase-2 peer sees exactly one `PROTOCOL_PING`
per tick (`harness.rig.protocolsSeenBy(id)`), on tick 1 **and** on a second tick — the second tick
is what pins the "and it never gets a turn again" half, which is the part that made this a real
outage rather than a one-tick hiccup. **Re-pose the two phase-2 labels between the ticks** (run 3
note §2) — without that, tick 1's successful probes promote both peers into the near list and the
tick-2 assertion is wrong.

**Case 2 — an unreachable near peer issues no snapshot fetch.** A near peer whose ping hangs (plain
per-peer `harness.rig.behavior.set(id, 'hangs')` suffices) must open **zero** `PROTOCOL_NEIGHBORS`
streams. Against the old code it opened one, which could only fail.

**Confirm both tests bite.** The fix is already committed, so get that evidence by temporarily
undoing the one line each case depends on, running that case, and putting it back. **Case 1's line
is the `timeoutMs` on `fetchAndMergeSnapshot`'s `fetchNeighbors` call, not the phase-1 signal** —
see run 3's note §1, which also explains what to say about the sub-budget in the handoff. Case 2's
line is `probeAndFetch`'s `if (!answered) return []`. Record in the review handoff that you
confirmed each, and by which flip.

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

- Raise the two new cases' mocha timeout to ~20 s (`function` callbacks, not arrows) as insurance;
  the describe-level 10 s is already sufficient at the measured tick costs.
- Write case 1 (stalled snapshot, two ticks with the phase-2 labels re-posed between them, dead +
  unknown phase-2 targets) in `test/stabilize-concurrency.spec.ts`.
- Write case 2 (unreachable near peer opens zero neighbors streams).
- Run case 1 under the Edge profile as well.
- Confirm each case bites by its flip — case 1 via the `fetchNeighbors` `timeoutMs`, case 2 via the
  `!answered` gate; put the code back.
- `npx tsc --noEmit`, the targeted mocha run, then `yarn test` in the foreground.
